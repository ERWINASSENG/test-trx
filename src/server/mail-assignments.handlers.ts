import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import express from 'express';
import { hasPermission } from './access-control';
import { createAppNotification } from './app-notifications';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';
import { decryptMailSecret, isMailEncryptionConfigured } from './mail-crypto';
import { mailProvider } from './mail-imap';
import { parseMailMessageRef } from './mail-provider';
import {
  getMailActor,
  handleImapError,
  resolveActorMailboxContext,
  setPrivateNoStoreHeaders,
} from './mail-read.handlers';
import {
  MAX_SMTP_SUBJECT_LENGTH,
  MAX_SMTP_TEXT_BODY_LENGTH,
  sendMailViaSmtp,
} from './mail-smtp';
import { loadGlobalMailSettings } from './mail-sync';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRICT_EMAIL_PATTERN =
  /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]{2,}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ASSIGNMENTS_LIMIT = 100;
const MAX_NOTE_LENGTH = 1000;
const MAX_CLIENT_NAME_LENGTH = 160;
const UNOPENED_ASSIGNMENT_ALERT_MINUTES = 240; // 4h

export interface ValidatedForwardAssignPayload {
  assignedTo: string;
  clientEmail: string | null;
  clientName: string | null;
  note: string | null;
}

export interface MailAssignmentMatchRow {
  id: string;
  manager_user_id: string;
  assigned_to: string;
  client_email: string;
  client_name: string | null;
  subject: string;
  forwarded_at: string;
  opened_at: string | null;
  quote_id: string | null;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasNullByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 0) {
      return true;
    }
  }
  return false;
}

function formatDateTimeFr(dateInput: string | number | Date | null | undefined): string {
  if (!dateInput) return '—';
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function validateForwardAssignPayload(
  rawBody: unknown
): { valid: true; data: ValidatedForwardAssignPayload } | { valid: false; error: string } {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return { valid: false, error: 'Corps de requête invalide.' };
  }

  const body = rawBody as Record<string, unknown>;
  const assignedTo = typeof body['assignedTo'] === 'string' ? body['assignedTo'].trim() : '';
  if (!UUID_PATTERN.test(assignedTo)) {
    return { valid: false, error: 'Sélectionnez un commercial valide.' };
  }

  let clientEmail: string | null = null;
  if (body['clientEmail'] !== undefined && body['clientEmail'] !== null && body['clientEmail'] !== '') {
    if (typeof body['clientEmail'] !== 'string') {
      return { valid: false, error: 'Adresse email du client invalide.' };
    }
    const cleaned = body['clientEmail'].trim().toLowerCase();
    if (
      cleaned.length > 254 ||
      hasControlChars(cleaned) ||
      !STRICT_EMAIL_PATTERN.test(cleaned)
    ) {
      return { valid: false, error: 'Adresse email du client invalide.' };
    }
    clientEmail = cleaned;
  }

  let clientName: string | null = null;
  if (body['clientName'] !== undefined && body['clientName'] !== null && body['clientName'] !== '') {
    if (typeof body['clientName'] !== 'string') {
      return { valid: false, error: 'Nom du client invalide.' };
    }
    const cleaned = body['clientName'].trim();
    if (cleaned.length > MAX_CLIENT_NAME_LENGTH || hasControlChars(cleaned)) {
      return { valid: false, error: 'Nom du client invalide (160 caractères maximum).' };
    }
    clientName = cleaned || null;
  }

  let note: string | null = null;
  if (body['note'] !== undefined && body['note'] !== null && body['note'] !== '') {
    if (typeof body['note'] !== 'string') {
      return { valid: false, error: 'Consigne manager invalide.' };
    }
    if (hasNullByte(body['note'])) {
      return { valid: false, error: 'Consigne manager invalide.' };
    }
    const cleaned = body['note'].trim();
    if (cleaned.length > MAX_NOTE_LENGTH) {
      return {
        valid: false,
        error: `La consigne manager ne peut pas dépasser ${MAX_NOTE_LENGTH} caractères.`,
      };
    }
    note = cleaned || null;
  }

  return {
    valid: true,
    data: { assignedTo, clientEmail, clientName, note },
  };
}

export function buildForwardedAssignTextBody(params: {
  note: string | null;
  clientEmail: string;
  clientName: string | null;
  originalDate: string | null;
  originalSubject: string;
  originalTextBody: string;
}): string {
  const clientHeader = params.clientName
    ? `${params.clientName} <${params.clientEmail}>`
    : params.clientEmail;
  const lines: string[] = [];

  if (params.note) {
    lines.push(params.note, '');
  }

  lines.push(
    '---------- Demande client transférée (suivi commercial) ----------',
    `Client : ${clientHeader}`,
    `Date : ${params.originalDate ? formatDateTimeFr(params.originalDate) : '—'}`,
    `Objet : ${params.originalSubject}`,
    '',
    params.originalTextBody || '(Message sans contenu texte)'
  );

  return lines.join('\n').slice(0, MAX_SMTP_TEXT_BODY_LENGTH);
}

/**
 * Marque un transfert mail comme ouvert par le commercial assigné (idempotent, anti-falsification).
 */
export async function markMailAssignmentOpenedByMessageId(
  adminClient: SupabaseClient,
  params: {
    assignedTo: string;
    messageId: string;
    channel: 'webmail' | 'imap_seen';
    imapUid?: number | null;
  }
): Promise<{ updated: boolean; assignmentId?: string }> {
  const cleanMessageId = params.messageId.trim();
  if (!UUID_PATTERN.test(params.assignedTo) || !cleanMessageId) {
    return { updated: false };
  }

  const nowIso = new Date().toISOString();
  const updatePayload: Record<string, unknown> = {
    opened_at: nowIso,
    opened_channel: params.channel,
    updated_at: nowIso,
  };
  if (typeof params.imapUid === 'number' && params.imapUid > 0) {
    updatePayload['assigned_imap_uid'] = params.imapUid;
  }

  const { data: openedRow } = await adminClient
    .from('mail_assignments')
    .update({ ...updatePayload, status: 'opened' })
    .eq('assigned_to', params.assignedTo)
    .eq('forwarded_message_id', cleanMessageId)
    .is('opened_at', null)
    .eq('status', 'sent')
    .select('id')
    .maybeSingle();

  if (openedRow?.id) {
    return { updated: true, assignmentId: String(openedRow.id) };
  }

  // Si la cotation avait déjà été créée avant détection de l'ouverture, on renseigne uniquement opened_at
  const { data: quoteCreatedRow } = await adminClient
    .from('mail_assignments')
    .update(updatePayload)
    .eq('assigned_to', params.assignedTo)
    .eq('forwarded_message_id', cleanMessageId)
    .is('opened_at', null)
    .select('id')
    .maybeSingle();

  if (quoteCreatedRow?.id) {
    return { updated: true, assignmentId: String(quoteCreatedRow.id) };
  }

  return { updated: false };
}

export async function findMailAssignmentForQuoteCreation(
  adminClient: SupabaseClient,
  params: { actorId: string; messageId: string | null }
): Promise<MailAssignmentMatchRow | null> {
  if (!UUID_PATTERN.test(params.actorId) || !params.messageId) {
    return null;
  }

  const { data } = await adminClient
    .from('mail_assignments')
    .select('id, manager_user_id, assigned_to, client_email, client_name, subject, forwarded_at, opened_at, quote_id')
    .eq('assigned_to', params.actorId)
    .eq('forwarded_message_id', params.messageId.trim())
    .maybeSingle();

  if (!data?.id) {
    return null;
  }

  return {
    id: String(data.id),
    manager_user_id: String(data.manager_user_id),
    assigned_to: String(data.assigned_to),
    client_email: String(data.client_email).trim().toLowerCase(),
    client_name: typeof data.client_name === 'string' ? data.client_name : null,
    subject: String(data.subject || ''),
    forwarded_at: String(data.forwarded_at),
    opened_at: typeof data.opened_at === 'string' ? data.opened_at : null,
    quote_id: typeof data.quote_id === 'string' ? data.quote_id : null,
  };
}

/**
 * Vérifie si une adresse email correspond à un collaborateur interne actif
 * afin d'éviter la création par erreur d'un prospect au nom d'un collègue ou manager.
 */
export async function isInternalCompanyEmail(
  adminClient: SupabaseClient,
  email: string
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !STRICT_EMAIL_PATTERN.test(normalized)) {
    return false;
  }

  const safePattern = normalized.replace(/[%_]/g, '');
  const [profileRes, mailboxRes] = await Promise.all([
    adminClient
      .from('profiles')
      .select('email')
      .eq('is_active', true)
      .ilike('email', safePattern)
      .limit(5),
    adminClient
      .from('mail_inbox_accounts')
      .select('email_address')
      .eq('is_active', true)
      .ilike('email_address', safePattern)
      .limit(5),
  ]);

  const matchesProfile = (profileRes.data || []).some(
    (row) => String(row.email || '').trim().toLowerCase() === normalized
  );
  if (matchesProfile) return true;

  return (mailboxRes.data || []).some(
    (row) => String(row.email_address || '').trim().toLowerCase() === normalized
  );
}

/**
 * POST /api/mail/messages/:ref/forward-assign
 * Transfère un email client au commercial choisi et crée un suivi dans mail_assignments
 * SANS créer automatiquement ni prospect ni cotation.
 */
export const forwardAssignMailHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getMailActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const parsedRef = parseMailMessageRef(req.params['ref']);
  if (!parsedRef) {
    res.status(400).json({ code: 'MAIL_INVALID_REF', error: 'Référence de message invalide.' });
    return;
  }

  const validated = validateForwardAssignPayload(req.body);
  if (!validated.valid) {
    res.status(400).json({ code: 'MAIL_ASSIGN_INVALID_PAYLOAD', error: validated.error });
    return;
  }

  if (!isMailEncryptionConfigured()) {
    res.status(503).json({
      code: 'MAIL_SERVER_NOT_CONFIGURED',
      error: 'Le service de messagerie n’est pas encore activé sur le serveur.',
    });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service indisponible.' });
    return;
  }

  // 1. Vérifie que le destinataire est bien un commercial actif (anti-relais SMTP arbitraire)
  const { data: commercialRole } = await adminClient
    .from('access_roles')
    .select('id')
    .eq('role_key', 'commercial')
    .eq('is_active', true)
    .maybeSingle();

  if (!commercialRole?.id) {
    res.status(422).json({ error: 'Aucun rôle commercial actif n’est configuré.' });
    return;
  }

  const [roleLinkRes, targetProfileRes, targetMailboxRes] = await Promise.all([
    adminClient
      .from('access_user_roles')
      .select('user_id, expires_at')
      .eq('role_id', commercialRole.id)
      .eq('user_id', validated.data.assignedTo)
      .maybeSingle(),
    adminClient
      .from('profiles')
      .select('id, first_name, last_name, email, is_active')
      .eq('id', validated.data.assignedTo)
      .maybeSingle(),
    adminClient
      .from('mail_inbox_accounts')
      .select('id, email_address, is_active')
      .eq('user_id', validated.data.assignedTo)
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  const roleLink = roleLinkRes.data;
  const isRoleValid =
    Boolean(roleLink?.user_id) &&
    (!roleLink?.expires_at || Date.parse(String(roleLink.expires_at)) > Date.now());
  const targetProfile = targetProfileRes.data;

  if (!isRoleValid || !targetProfile || !targetProfile.is_active) {
    res.status(422).json({
      code: 'MAIL_ASSIGN_INVALID_COMMERCIAL',
      error: 'Le destinataire sélectionné n’est pas un commercial actif.',
    });
    return;
  }

  const targetEmail = String(
    targetMailboxRes.data?.email_address || targetProfile.email || ''
  )
    .trim()
    .toLowerCase();
  if (!targetEmail || !STRICT_EMAIL_PATTERN.test(targetEmail)) {
    res.status(422).json({
      code: 'MAIL_ASSIGN_MISSING_TARGET_EMAIL',
      error: 'Le commercial sélectionné ne possède pas d’adresse email professionnelle valide.',
    });
    return;
  }

  // 2. Contexte boîte mail & SMTP du manager (scopé strictement à actor.id)
  const [resolved, settings, managerAccountRes, managerProfileRes] = await Promise.all([
    resolveActorMailboxContext(actor.id),
    loadGlobalMailSettings(adminClient),
    adminClient
      .from('mail_inbox_accounts')
      .select('id, email_address, display_name, encrypted_password, sent_folder, is_active')
      .eq('user_id', actor.id)
      .maybeSingle(),
    adminClient
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', actor.id)
      .maybeSingle(),
  ]);

  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  if (!settings || !settings.is_enabled || !settings.smtp_host) {
    res.status(503).json({
      code: 'MAIL_SMTP_NOT_CONFIGURED',
      error: 'Le serveur SMTP de l’entreprise n’est pas encore configuré.',
    });
    return;
  }

  const managerAccount = managerAccountRes.data;
  if (!managerAccount || !managerAccount.is_active) {
    res.status(404).json({
      code: 'MAILBOX_NOT_CONNECTED',
      error: 'Connectez d’abord votre boîte mail dans Mon Profil.',
    });
    return;
  }

  // 3. Lecture du mail source dans la boîte du manager
  let detail;
  try {
    detail = await mailProvider.getMessage(resolved.ctx, {
      folder: parsedRef.folder,
      uidValidity: parsedRef.uidValidity,
      uid: parsedRef.uid,
      allowRemoteImages: false,
    });
  } catch (err: unknown) {
    handleImapError(res, err);
    return;
  }

  if (!detail) {
    res.status(404).json({
      code: 'MAIL_MESSAGE_NOT_FOUND',
      error: 'Message source introuvable ou déplacé.',
    });
    return;
  }

  const fallbackClientEmail = (detail.from?.address || '').trim().toLowerCase();
  const clientEmail = validated.data.clientEmail || fallbackClientEmail;
  if (!clientEmail || !STRICT_EMAIL_PATTERN.test(clientEmail)) {
    res.status(422).json({
      code: 'MAIL_ASSIGN_INVALID_CLIENT_EMAIL',
      error: 'Renseignez une adresse email valide pour le client d’origine.',
    });
    return;
  }

  const managerEmail = String(managerAccount.email_address || '').trim().toLowerCase();
  if (clientEmail === managerEmail || clientEmail === targetEmail) {
    res.status(422).json({
      code: 'MAIL_ASSIGN_INTERNAL_CLIENT_EMAIL',
      error: 'L’adresse du client d’origine ne peut pas être celle du manager ou du commercial.',
    });
    return;
  }

  const clientName =
    validated.data.clientName ||
    (detail.from?.name && detail.from.name.trim().toLowerCase() !== clientEmail
      ? detail.from.name.trim().slice(0, MAX_CLIENT_NAME_LENGTH)
      : null);

  const rawSubject = (detail.subject || '').trim() || 'Demande de cotation';
  const fwdSubject = (/^(?:tr|fwd)\s*:/i.test(rawSubject)
    ? rawSubject
    : `Tr: ${rawSubject}`
  ).slice(0, MAX_SMTP_SUBJECT_LENGTH);

  const textBody = buildForwardedAssignTextBody({
    note: validated.data.note,
    clientEmail,
    clientName,
    originalDate: detail.date,
    originalSubject: rawSubject,
    originalTextBody: detail.textBody || '',
  });

  // 4. Envoi SMTP depuis la boîte du manager (From forcé + anti-CRLF + IMAP APPEND Sent)
  let password: string;
  try {
    password = decryptMailSecret(String(managerAccount.encrypted_password));
  } catch {
    res.status(500).json({ error: 'Impossible d’accéder aux identifiants de votre boîte mail.' });
    return;
  }

  const profileFullName = managerProfileRes.data
    ? `${String(managerProfileRes.data.first_name || '')} ${String(managerProfileRes.data.last_name || '')}`.trim()
    : '';
  const displayName = String(managerAccount.display_name || '').trim() || profileFullName || null;

  let sendResult;
  try {
    sendResult = await sendMailViaSmtp(
      {
        accountId: String(managerAccount.id),
        userId: actor.id,
        emailAddress: managerEmail,
        displayName,
        password,
        smtpHost: settings.smtp_host,
        smtpPort: settings.smtp_port,
        smtpTls: settings.smtp_tls,
        imapHost: settings.imap_host,
        imapPort: settings.imap_port,
        imapTls: settings.imap_tls,
        sentFolder: typeof managerAccount.sent_folder === 'string' ? managerAccount.sent_folder : null,
      },
      {
        to: [targetEmail],
        cc: [],
        bcc: [],
        subject: fwdSubject,
        textBody,
        inReplyTo: null,
        references: [],
        totalRecipients: 1,
      }
    );
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message.toLowerCase() : '';
    const isAuth = rawMsg.includes('auth') || rawMsg.includes('535') || rawMsg.includes('login');
    res.status(isAuth ? 401 : 502).json({
      code: isAuth ? 'MAILBOX_AUTH_FAILED' : 'MAIL_SMTP_SEND_FAILED',
      error: isAuth
        ? 'Authentification SMTP refusée. Mettez à jour votre mot de passe mail dans Mon Profil.'
        : 'Impossible de transférer le message pour le moment.',
    });
    return;
  }

  const forwardedAtIso = new Date().toISOString();
  const forwardedMessageId = sendResult.messageId
    ? sendResult.messageId.trim().slice(0, 255)
    : `<fwd-${crypto.randomUUID()}@transimex.local>`;

  // 5. Enregistrement du suivi mail_assignments (ZÉRO prospect / ZÉRO cotation créée)
  const { data: createdAssignment, error: insertError } = await adminClient
    .from('mail_assignments')
    .insert({
      manager_user_id: actor.id,
      assigned_to: validated.data.assignedTo,
      source_account_id: String(managerAccount.id),
      assigned_mailbox_account_id: targetMailboxRes.data?.id
        ? String(targetMailboxRes.data.id)
        : null,
      source_internet_message_id: detail.messageId ? detail.messageId.slice(0, 255) : null,
      forwarded_message_id: forwardedMessageId,
      client_email: clientEmail,
      client_name: clientName,
      subject: rawSubject.slice(0, 300),
      manager_note: validated.data.note,
      status: 'sent',
      forwarded_at: forwardedAtIso,
    })
    .select('id, forwarded_at')
    .single();

  if (insertError || !createdAssignment?.id) {
    res.status(500).json({
      error: 'Le mail a été transféré mais le suivi n’a pas pu être enregistré.',
    });
    return;
  }

  const assignmentId = String(createdAssignment.id);
  const targetFullName =
    `${String(targetProfile.first_name || '')} ${String(targetProfile.last_name || '')}`.trim() ||
    targetEmail;

  await Promise.all([
    adminClient.from('mail_send_log').insert({
      user_id: actor.id,
      account_id: String(managerAccount.id),
      message_id: forwardedMessageId,
      recipients_count: 1,
      subject_preview: fwdSubject.slice(0, 120),
      status: 'sent',
    }),
    createAppNotification(adminClient, {
      recipientId: validated.data.assignedTo,
      actorId: actor.id,
      notificationType: 'assignment',
      title: 'Nouvelle demande mail transférée',
      message: `${displayName || 'Un manager'} vous a transféré une demande client (${clientName || clientEmail}) : ${rawSubject.slice(0, 100)}`,
      href: '/mail',
      sourceType: 'quote',
      sourceId: assignmentId,
      dedupeKey: `mail-assignment:${assignmentId}`,
    }),
    writeAuditLog(adminClient, {
      userId: actor.id,
      action: 'MAIL_FORWARD_ASSIGN',
      entityType: 'mail_assignment',
      entityId: assignmentId,
      details: {
        assigned_to: validated.data.assignedTo,
        sent_folder_appended: sendResult.sentFolderAppended,
      },
    }),
  ]);

  res.status(201).json({
    assignment: {
      id: assignmentId,
      assignedTo: validated.data.assignedTo,
      assignedToName: targetFullName,
      clientEmail,
      clientName,
      subject: rawSubject.slice(0, 300),
      status: 'sent',
      forwardedAt: forwardedAtIso,
      forwardedAtFormatted: formatDateTimeFr(forwardedAtIso),
      messageId: forwardedMessageId,
    },
  });
};

/**
 * GET /api/mail/assignments
 * Retourne la liste bornée (≤ 100) des mails transférés avec leur état réel
 * (Transféré -> Ouvert par le commercial -> Cotation créée).
 * Zéro mutation DB dans ce handler GET (règle S11).
 */
export const listMailAssignmentsHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getMailActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service indisponible.' });
    return;
  }

  const [canReadTiming, canManageQuotes] = await Promise.all([
    hasPermission(actor.id, 'quotes.timing.read', undefined),
    hasPermission(actor.id, 'quotes.manage', undefined),
  ]);

  if (!canReadTiming) {
    res.status(403).json({
      error: 'Permission quotes.timing.read requise pour consulter le suivi des mails transférés.',
    });
    return;
  }

  const period = typeof req.query['period'] === 'string' ? req.query['period'] : 'month';
  const specificDate = typeof req.query['date'] === 'string' ? req.query['date'] : null;
  const rawRepId = typeof req.query['repId'] === 'string' ? req.query['repId'].trim() : '';
  const rawStatus = typeof req.query['status'] === 'string' ? req.query['status'].trim() : '';

  const repFilter =
    rawRepId && rawRepId !== 'all' && UUID_PATTERN.test(rawRepId) ? rawRepId : null;
  const statusFilter =
    rawStatus === 'sent' || rawStatus === 'opened' || rawStatus === 'quote_created'
      ? rawStatus
      : null;

  const now = new Date();
  let startDate: Date;
  let endDate: Date = now;

  if (specificDate && DATE_PATTERN.test(specificDate)) {
    startDate = new Date(`${specificDate}T00:00:00.000Z`);
    endDate = new Date(`${specificDate}T23:59:59.999Z`);
  } else if (period === '7d') {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === 'quarter') {
    const currentQuarter = Math.floor(now.getMonth() / 3);
    startDate = new Date(now.getFullYear(), currentQuarter * 3, 1);
  } else if (period === 'year') {
    startDate = new Date(now.getFullYear(), 0, 1);
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  let query = adminClient
    .from('mail_assignments')
    .select(
      'id, manager_user_id, assigned_to, client_email, client_name, subject, manager_note, status, forwarded_at, opened_at, opened_channel, quote_id, quote_created_at'
    )
    .gte('forwarded_at', startDate.toISOString())
    .lte('forwarded_at', endDate.toISOString())
    .order('forwarded_at', { ascending: false })
    .limit(MAX_ASSIGNMENTS_LIMIT);

  // Scoping S1 : sans droit global quotes.manage, l'acteur ne voit que ses propres transferts
  if (!canManageQuotes) {
    query = query.or(`manager_user_id.eq.${actor.id},assigned_to.eq.${actor.id}`);
  }
  if (repFilter) {
    query = query.eq('assigned_to', repFilter);
  }
  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  const { data: rows, error } = await query;
  if (error) {
    res.status(500).json({ error: 'Impossible de charger les mails transférés.' });
    return;
  }

  const assignmentRows = rows || [];
  const userIds = [
    ...new Set(
      assignmentRows
        .flatMap((row) => [String(row.manager_user_id), String(row.assigned_to)])
        .filter((id) => UUID_PATTERN.test(id))
    ),
  ];
  const quoteIds = [
    ...new Set(
      assignmentRows
        .map((row) => (typeof row.quote_id === 'string' ? row.quote_id : ''))
        .filter((id) => UUID_PATTERN.test(id))
    ),
  ];

  const [profilesRes, quotesRes] = await Promise.all([
    userIds.length
      ? adminClient.from('profiles').select('id, first_name, last_name, email').in('id', userIds)
      : { data: [], error: null },
    quoteIds.length
      ? adminClient.from('sales_quotes').select('id, quote_number, status').in('id', quoteIds)
      : { data: [], error: null },
  ]);

  const profileMap = new Map(
    (profilesRes.data || []).map((p) => [
      String(p.id),
      `${String(p.first_name || '')} ${String(p.last_name || '')}`.trim() ||
        String(p.email || 'Utilisateur'),
    ])
  );
  const quoteMap = new Map(
    (quotesRes.data || []).map((q) => [
      String(q.id),
      { quoteNumber: String(q.quote_number || ''), quoteStatus: String(q.status || 'draft') },
    ])
  );

  let unopenedCount = 0;
  let openedCount = 0;
  let quoteCreatedCount = 0;
  const nowMs = Date.now();

  const assignments = assignmentRows.map((row) => {
    const status = String(row.status || 'sent') as 'sent' | 'opened' | 'quote_created';
    const forwardedAt = String(row.forwarded_at);
    const openedAt = typeof row.opened_at === 'string' ? row.opened_at : null;
    const quoteCreatedAt = typeof row.quote_created_at === 'string' ? row.quote_created_at : null;
    const quoteId = typeof row.quote_id === 'string' ? row.quote_id : null;
    const linkedQuote = quoteId ? quoteMap.get(quoteId) : null;

    const forwardedMs = new Date(forwardedAt).getTime();
    const minutesSinceForwarded = Math.max(0, Math.round((nowMs - forwardedMs) / 60000));
    const isUnopened = !openedAt && status === 'sent';
    const isUnopenedAlert =
      isUnopened && minutesSinceForwarded >= UNOPENED_ASSIGNMENT_ALERT_MINUTES;

    if (status === 'quote_created') quoteCreatedCount++;
    else if (openedAt || status === 'opened') openedCount++;
    else unopenedCount++;

    return {
      id: String(row.id),
      managerUserId: String(row.manager_user_id),
      managerName: profileMap.get(String(row.manager_user_id)) || 'Manager',
      assignedTo: String(row.assigned_to),
      repName: profileMap.get(String(row.assigned_to)) || 'Commercial',
      clientEmail: String(row.client_email),
      clientName: typeof row.client_name === 'string' ? row.client_name : null,
      subject: String(row.subject),
      managerNote: typeof row.manager_note === 'string' ? row.manager_note : null,
      status,
      forwardedAt,
      forwardedAtFormatted: formatDateTimeFr(forwardedAt),
      openedAt,
      openedAtFormatted: openedAt ? formatDateTimeFr(openedAt) : 'En attente d’ouverture',
      openedChannel:
        row.opened_channel === 'webmail' || row.opened_channel === 'imap_seen'
          ? row.opened_channel
          : null,
      quoteId,
      quoteNumber: linkedQuote?.quoteNumber || null,
      quoteStatus: linkedQuote?.quoteStatus || null,
      quoteCreatedAt,
      quoteCreatedAtFormatted: quoteCreatedAt
        ? formatDateTimeFr(quoteCreatedAt)
        : 'Aucune cotation créée',
      isUnopened,
      isUnopenedAlert,
    };
  });

  res.json({
    summary: {
      totalCount: assignments.length,
      unopenedCount,
      openedCount,
      quoteCreatedCount,
    },
    assignments,
  });
};
