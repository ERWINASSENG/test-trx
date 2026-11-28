import crypto from 'node:crypto';
import express from 'express';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';
import { mailProvider } from './mail-imap';
import {
  findMailAssignmentForQuoteCreation,
  isInternalCompanyEmail,
  markMailAssignmentOpenedByMessageId,
} from './mail-assignments.handlers';
import { parseMailMessageRef, type MailMoveTarget } from './mail-provider';
import {
  getMailActor,
  handleImapError,
  resolveActorMailboxContext,
  setPrivateNoStoreHeaders,
} from './mail-read.handlers';
import { recordQuoteEvent } from './quotes';

const SAFE_DOWNLOAD_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/octet-stream',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.svgz',
  '.xml',
  '.js',
  '.mjs',
  '.cjs',
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.vbs',
  '.msi',
  '.scr',
  '.com',
  '.pif',
  '.hta',
  '.jar',
  '.php',
]);

export function sanitizeAttachmentFilename(rawFilename: string): string {
  const baseName = rawFilename.split(/[/\\]/).pop() ?? '';
  let cleaned = '';
  for (let i = 0; i < baseName.length; i++) {
    const code = baseName.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) {
      cleaned += baseName[i];
    }
  }

  cleaned = cleaned
    .replace(/["';<>|:*?]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150);

  return cleaned || 'piece-jointe';
}

export function resolveSafeDownloadContentType(
  rawContentType: string,
  filename: string
): string {
  const lowerName = filename.toLowerCase();
  const dotIdx = lowerName.lastIndexOf('.');
  if (dotIdx !== -1) {
    const ext = lowerName.slice(dotIdx);
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      return 'application/octet-stream';
    }
  }

  const normalizedMime = (rawContentType || '').toLowerCase().split(';')[0].trim();
  if (SAFE_DOWNLOAD_MIMES.has(normalizedMime)) {
    return normalizedMime;
  }

  return 'application/octet-stream';
}

function toAsciiHeaderFilename(filename: string): string {
  const ascii = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '_')
    .trim();
  return ascii || 'piece-jointe';
}

export const updateMailFlagsHandler = async (
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
    res.status(400).json({ error: 'Référence de message invalide.' });
    return;
  }

  const body =
    typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  const isRead = typeof body['isRead'] === 'boolean' ? body['isRead'] : undefined;
  const isFlagged = typeof body['isFlagged'] === 'boolean' ? body['isFlagged'] : undefined;

  if (isRead === undefined && isFlagged === undefined) {
    res.status(400).json({ error: 'Précisez au moins un indicateur (isRead ou isFlagged).' });
    return;
  }

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const updated = await mailProvider.updateMessageFlags(resolved.ctx, {
      folder: parsedRef.folder,
      uidValidity: parsedRef.uidValidity,
      uid: parsedRef.uid,
      isRead,
      isFlagged,
    });

    if (!updated) {
      res.status(404).json({
        code: 'MAIL_MESSAGE_NOT_FOUND',
        error: 'Message introuvable ou déplacé.',
      });
      return;
    }

    // Détection temps réel d'ouverture d'un mail transféré par un manager (mutation PATCH, jamais sur GET)
    if (isRead === true) {
      const adminClient = getSupabaseAdmin();
      if (adminClient) {
        try {
          const { data: pendingAssignments } = await adminClient
            .from('mail_assignments')
            .select('id')
            .eq('assigned_to', actor.id)
            .is('opened_at', null)
            .limit(1);

          if (pendingAssignments && pendingAssignments.length > 0) {
            const detail = await mailProvider.getMessage(resolved.ctx, {
              folder: parsedRef.folder,
              uidValidity: parsedRef.uidValidity,
              uid: parsedRef.uid,
              allowRemoteImages: false,
            });
            if (detail?.messageId) {
              await markMailAssignmentOpenedByMessageId(adminClient, {
                assignedTo: actor.id,
                messageId: detail.messageId,
                channel: 'webmail',
                imapUid: parsedRef.uid,
              });
            }
          }
        } catch {
          // Non bloquant pour la mise à jour du flag IMAP
        }
      }
    }

    res.json({
      updated: true,
      ...(isRead !== undefined ? { isRead } : {}),
      ...(isFlagged !== undefined ? { isFlagged } : {}),
    });
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};

export const moveMailMessageHandler = async (
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
    res.status(400).json({ error: 'Référence de message invalide.' });
    return;
  }

  const body =
    typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const rawTarget = body['target'];
  if (rawTarget !== 'trash' && rawTarget !== 'archive') {
    res.status(400).json({ error: 'Destination non autorisée (attendu : trash ou archive).' });
    return;
  }
  const target: MailMoveTarget = rawTarget;

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const result = await mailProvider.moveMessage(resolved.ctx, {
      folder: parsedRef.folder,
      uidValidity: parsedRef.uidValidity,
      uid: parsedRef.uid,
      target,
      cachedTrashFolder: resolved.trashFolder,
    });

    if (!result.destinationFolder) {
      res.status(404).json({
        code: 'MAIL_FOLDER_NOT_FOUND',
        error:
          target === 'trash'
            ? 'Aucun dossier Corbeille détecté dans votre boîte mail.'
            : 'Aucun dossier Archives détecté dans votre boîte mail.',
      });
      return;
    }

    if (!result.moved) {
      res.status(404).json({
        code: 'MAIL_MESSAGE_NOT_FOUND',
        error: 'Message introuvable ou déjà déplacé.',
      });
      return;
    }

    const adminClient = getSupabaseAdmin();
    if (adminClient && target === 'trash' && !resolved.trashFolder) {
      await adminClient
        .from('mail_inbox_accounts')
        .update({ trash_folder: result.destinationFolder, updated_at: new Date().toISOString() })
        .eq('id', resolved.ctx.accountId);
    }

    res.json({
      moved: true,
      target,
      destinationFolder: result.destinationFolder,
    });
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};

export const deleteMailMessageHandler = async (
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
    res.status(400).json({ error: 'Référence de message invalide.' });
    return;
  }

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const deleted = await mailProvider.deleteMessage(resolved.ctx, {
      folder: parsedRef.folder,
      uidValidity: parsedRef.uidValidity,
      uid: parsedRef.uid,
    });

    if (!deleted) {
      res.status(404).json({
        code: 'MAIL_MESSAGE_NOT_FOUND',
        error: 'Message introuvable ou déjà supprimé.',
      });
      return;
    }

    res.json({ deleted: true });
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};

export const downloadMailAttachmentHandler = async (
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
  const attachmentId =
    typeof req.params['attachmentId'] === 'string' ? req.params['attachmentId'].trim() : '';

  if (!parsedRef || !/^\d{1,12}-\d{1,4}$/.test(attachmentId)) {
    res.status(400).json({ error: 'Référence de pièce jointe invalide.' });
    return;
  }

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const result = await mailProvider.getAttachment(resolved.ctx, {
      folder: parsedRef.folder,
      uidValidity: parsedRef.uidValidity,
      uid: parsedRef.uid,
      attachmentId,
    });

    if (result === 'TOO_LARGE') {
      res.status(413).json({
        code: 'MAIL_ATTACHMENT_TOO_LARGE',
        error: 'Pièce jointe trop volumineuse pour le téléchargement direct (maximum 4 Mo).',
      });
      return;
    }

    if (!result) {
      res.status(404).json({
        code: 'MAIL_ATTACHMENT_NOT_FOUND',
        error: 'Pièce jointe introuvable.',
      });
      return;
    }

    const safeFilename = sanitizeAttachmentFilename(result.filename);
    const asciiFilename = toAsciiHeaderFilename(safeFilename);
    const safeContentType = resolveSafeDownloadContentType(result.contentType, safeFilename);

    res.setHeader('Content-Type', safeContentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
    );
    res.setHeader('Content-Length', String(result.content.length));
    res.status(200).send(result.content);
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};

export const createQuoteFromMailHandler = async (
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
    res.status(400).json({ error: 'Référence de message invalide.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service indisponible.' });
    return;
  }

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    // 1. Déduplication par (account_id, folder, imap_uid)
    const { data: existingByUid } = await adminClient
      .from('mail_links')
      .select('entity_id')
      .eq('account_id', resolved.ctx.accountId)
      .eq('folder', parsedRef.folder)
      .eq('imap_uid', parsedRef.uid)
      .eq('entity_type', 'quote')
      .maybeSingle();

    if (existingByUid?.entity_id) {
      res.json({
        created: false,
        quoteId: String(existingByUid.entity_id),
      });
      return;
    }

    // 2. Lecture du message IMAP (zéro HTML conservé dans sales_quotes — texte brut uniquement)
    const detail = await mailProvider.getMessage(resolved.ctx, {
      folder: parsedRef.folder,
      uidValidity: parsedRef.uidValidity,
      uid: parsedRef.uid,
      allowRemoteImages: false,
    });

    if (!detail) {
      res.status(404).json({
        code: 'MAIL_MESSAGE_NOT_FOUND',
        error: 'Message introuvable ou déplacé.',
      });
      return;
    }

    // 3. Déduplication secondaire par internet_message_id (mail_links ou mail_ingested_messages)
    if (detail.messageId) {
      const { data: existingByMsg } = await adminClient
        .from('mail_links')
        .select('entity_id')
        .eq('account_id', resolved.ctx.accountId)
        .eq('internet_message_id', detail.messageId)
        .eq('entity_type', 'quote')
        .maybeSingle();

      if (existingByMsg?.entity_id) {
        res.json({
          created: false,
          quoteId: String(existingByMsg.entity_id),
        });
        return;
      }

      const { data: ingestedQuote } = await adminClient
        .from('mail_ingested_messages')
        .select('quote_id')
        .eq('account_id', resolved.ctx.accountId)
        .eq('internet_message_id', detail.messageId)
        .not('quote_id', 'is', null)
        .maybeSingle();

      if (ingestedQuote?.quote_id) {
        const quoteId = String(ingestedQuote.quote_id);
        await adminClient.from('mail_links').upsert(
          {
            user_id: actor.id,
            account_id: resolved.ctx.accountId,
            internet_message_id: detail.messageId.slice(0, 255),
            folder: parsedRef.folder,
            imap_uid: parsedRef.uid,
            entity_type: 'quote',
            entity_id: quoteId,
          },
          { onConflict: 'account_id,folder,imap_uid,entity_type' }
        );
        res.json({ created: false, quoteId });
        return;
      }
    }

    // 4. Vérifie si ce mail est un transfert suivi par un manager (mail_assignments)
    const matchedAssignment = await findMailAssignmentForQuoteCreation(adminClient, {
      actorId: actor.id,
      messageId: detail.messageId,
    });

    if (matchedAssignment?.quote_id) {
      await adminClient.from('mail_links').upsert(
        {
          user_id: actor.id,
          account_id: resolved.ctx.accountId,
          internet_message_id: detail.messageId ? detail.messageId.slice(0, 255) : null,
          folder: parsedRef.folder,
          imap_uid: parsedRef.uid,
          entity_type: 'quote',
          entity_id: matchedAssignment.quote_id,
        },
        { onConflict: 'account_id,folder,imap_uid,entity_type' }
      );
      res.json({ created: false, quoteId: matchedAssignment.quote_id });
      return;
    }

    // Résolution du vrai client d'origine (jamais le manager sur un mail transféré)
    const senderEmail = matchedAssignment
      ? matchedAssignment.client_email
      : (detail.from?.address || '').trim().toLowerCase();
    const senderName = matchedAssignment
      ? (matchedAssignment.client_name || '').trim()
      : (detail.from?.name || '').trim();

    if (!senderEmail) {
      res.status(422).json({
        error: 'Impossible de créer la cotation : adresse email de l’expéditeur introuvable.',
      });
      return;
    }

    // Garde-fou anti-interne : évite de créer un prospect au nom d'un manager/collègue si transféré hors /mail
    if (!matchedAssignment && (await isInternalCompanyEmail(adminClient, senderEmail))) {
      res.status(422).json({
        code: 'MAIL_INTERNAL_SENDER_GUARD',
        error:
          'Cet email provient d’un collaborateur interne. Utilisez « Transférer à un commercial » depuis la messagerie pour conserver le vrai client, ou créez la cotation depuis le module Cotations.',
      });
      return;
    }

    let prospectId: string | null = null;
    const { data: existingProspect } = await adminClient
      .from('prospects')
      .select('id')
      .ilike('email', senderEmail.replace(/[%_]/g, ''))
      .limit(1)
      .maybeSingle();

    if (existingProspect?.id) {
      prospectId = String(existingProspect.id);
    } else {
      const cleanName = senderName && senderName.toLowerCase() !== senderEmail ? senderName.slice(0, 120) : null;
      const { data: createdProspect, error: prospectErr } = await adminClient
        .from('prospects')
        .insert({
          company_name: (cleanName || senderEmail).slice(0, 150),
          contact_name: cleanName,
          email: senderEmail,
          phone: null,
          country: null,
          sector: null,
          contact_role: null,
          estimated_value: null,
          source: 'outlook_imap',
          status: 'new',
          assigned_to: actor.id,
          created_by: actor.id,
        })
        .select('id')
        .single();

      if (prospectErr || !createdProspect?.id) {
        res.status(500).json({ error: 'Impossible d’associer un contact à cette cotation.' });
        return;
      }
      prospectId = String(createdProspect.id);
    }

    // 5. Création de la cotation brouillon vide (règle zéro donnée devinée)
    const descColId = crypto.randomUUID();
    const amountColId = crypto.randomUUID();
    const createdIso = new Date().toISOString();
    const cleanSubject =
      (matchedAssignment?.subject || detail.subject || '').trim().slice(0, 480) ||
      'Demande de cotation';
    const senderDisplay = senderName
      ? `${senderName} <${senderEmail}>`.slice(0, 310)
      : senderEmail.slice(0, 310);
    const plainBody = (detail.textBody || '').trim().slice(0, 10_000) || null;

    const { data: createdQuote, error: quoteErr } = await adminClient
      .from('sales_quotes')
      .insert({
        prospect_id: prospectId,
        opportunity_id: null,
        contact_id: null,
        assigned_to: actor.id,
        assigned_at: matchedAssignment ? matchedAssignment.forwarded_at : createdIso,
        created_by: actor.id,
        title: cleanSubject,
        currency: 'XAF',
        columns: [
          { id: descColId, label: 'Désignation', type: 'text' },
          { id: amountColId, label: 'Montant HT', type: 'amount' },
        ],
        rows: [],
        total_column_id: amountColId,
        total_amount: 0,
        status: 'draft',
        valid_until: null,
        sea_freight: {},
        source_channel: 'outlook_imap',
        source_mailbox_account_id: resolved.ctx.accountId,
        source_email_sender: senderDisplay,
        source_email_subject: cleanSubject,
        source_email_body_text: plainBody,
        outlook_read_at: matchedAssignment?.opened_at || (detail.isRead ? createdIso : null),
        first_opened_at: createdIso,
      })
      .select('id, quote_number')
      .single();

    if (quoteErr || !createdQuote?.id) {
      res.status(500).json({ error: 'Impossible de créer la cotation depuis cet email.' });
      return;
    }

    const quoteId = String(createdQuote.id);
    const quoteNumber = String(createdQuote.quote_number || '');

    const postCreateTasks: PromiseLike<unknown>[] = [
      adminClient.from('mail_links').upsert(
        {
          user_id: actor.id,
          account_id: resolved.ctx.accountId,
          internet_message_id: detail.messageId ? detail.messageId.slice(0, 255) : null,
          folder: parsedRef.folder,
          imap_uid: parsedRef.uid,
          entity_type: 'quote',
          entity_id: quoteId,
        },
        { onConflict: 'account_id,folder,imap_uid,entity_type' }
      ),
      recordQuoteEvent(adminClient, {
        quoteId,
        eventType: 'email_received',
        actorUserId: actor.id,
        metadata: {
          source: matchedAssignment ? 'webmail_forwarded_assign_create' : 'webmail_manual_create',
          senderEmail,
          subject: cleanSubject.slice(0, 200),
          ...(matchedAssignment ? { mailAssignmentId: matchedAssignment.id } : {}),
        },
      }),
      writeAuditLog(adminClient, {
        userId: actor.id,
        action: 'CREATE_QUOTE_FROM_MAIL',
        entityType: 'sales_quote',
        entityId: quoteId,
        details: {
          quote_number: quoteNumber,
          folder: parsedRef.folder,
          ...(matchedAssignment ? { mail_assignment_id: matchedAssignment.id } : {}),
        },
      }),
    ];

    if (matchedAssignment) {
      const assignmentUpdate: Record<string, unknown> = {
        status: 'quote_created',
        quote_id: quoteId,
        quote_created_at: createdIso,
        updated_at: createdIso,
      };
      if (!matchedAssignment.opened_at) {
        assignmentUpdate['opened_at'] = createdIso;
        assignmentUpdate['opened_channel'] = 'webmail';
      }
      postCreateTasks.push(
        adminClient
          .from('mail_assignments')
          .update(assignmentUpdate)
          .eq('id', matchedAssignment.id)
          .eq('assigned_to', actor.id)
      );
    }

    await Promise.all(postCreateTasks);

    res.status(201).json({
      created: true,
      quoteId,
      quoteNumber,
    });
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};
