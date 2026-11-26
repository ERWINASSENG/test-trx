import express from 'express';
import { hasPermission } from './access-control';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';
import {
  assertSafePublicMailHost,
  encryptMailSecret,
  isMailEncryptionConfigured,
  validatePublicMailHostFormat,
} from './mail-crypto';
import {
  loadGlobalMailSettings,
  syncMailInboxAccount,
  verifyImapCredentials,
} from './mail-sync';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MailActor {
  id: string;
  email?: string;
  role?: string;
}

function getActor(req: express.Request): MailActor | null {
  const user = (req as unknown as Record<string, unknown>)['user'] as MailActor | undefined;
  return user?.id ? user : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeAccountPublicDto(row: Record<string, unknown>, ownerName?: string) {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    ...(ownerName !== undefined ? { userName: ownerName } : {}),
    emailAddress: String(row['email_address']),
    accountRole: row['account_role'] === 'manager' ? 'manager' : 'commercial',
    isActive: Boolean(row['is_active']),
    lastSyncedAt: typeof row['last_synced_at'] === 'string' ? row['last_synced_at'] : null,
    lastError: typeof row['last_error'] === 'string' ? row['last_error'] : null,
    createdAt: String(row['created_at'] || ''),
    updatedAt: String(row['updated_at'] || ''),
  };
}

export const getMyMailAccountHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service mail temporairement indisponible.' });
    return;
  }

  const [settings, accountRes] = await Promise.all([
    loadGlobalMailSettings(adminClient),
    adminClient
      .from('mail_inbox_accounts')
      .select('id, user_id, email_address, account_role, is_active, last_synced_at, last_error, created_at, updated_at')
      .eq('user_id', actor.id)
      .maybeSingle(),
  ]);

  if (accountRes.error) {
    res.status(500).json({ error: 'Impossible de lire l’état de votre boîte mail.' });
    return;
  }

  const configuredOnServer = Boolean(
    isMailEncryptionConfigured() && settings && settings.is_enabled && settings.imap_host
  );

  res.json({
    configuredOnServer,
    account: accountRes.data ? sanitizeAccountPublicDto(accountRes.data) : null,
  });
};

export const connectMyMailAccountHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  if (!isRecord(req.body)) {
    res.status(400).json({ error: 'Données de connexion mail invalides.' });
    return;
  }

  // S3 : Liste blanche stricte — aucun hôte, port ou user_id accepté depuis le client
  const allowedKeys = new Set(['email', 'password']);
  if (Object.keys(req.body).some((key) => !allowedKeys.has(key))) {
    res.status(400).json({ error: 'La requête contient des champs non autorisés.' });
    return;
  }

  const rawEmail = typeof req.body['email'] === 'string' ? req.body['email'].trim().toLowerCase() : '';
  const rawPassword = typeof req.body['password'] === 'string' ? req.body['password'] : '';

  if (!rawEmail || rawEmail.length > 254 || !EMAIL_PATTERN.test(rawEmail)) {
    res.status(400).json({ error: 'Veuillez saisir une adresse email professionnelle valide.' });
    return;
  }
  if (!rawPassword || rawPassword.length > 256) {
    res.status(400).json({ error: 'Veuillez saisir votre mot de passe mail.' });
    return;
  }

  if (!isMailEncryptionConfigured()) {
    res.status(503).json({
      error: 'Le chiffrement des boîtes mail n’est pas encore activé sur le serveur.',
    });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service mail temporairement indisponible.' });
    return;
  }

  const settings = await loadGlobalMailSettings(adminClient);
  if (!settings || !settings.is_enabled || !settings.imap_host) {
    res.status(503).json({
      error: 'Le serveur IMAP de l’entreprise n’est pas encore configuré par l’administrateur.',
    });
    return;
  }

  // Anti-usurpation d'adresse mail déjà rattachée à un autre collaborateur
  const { data: emailOwner } = await adminClient
    .from('mail_inbox_accounts')
    .select('user_id')
    .ilike('email_address', rawEmail.replace(/[%_]/g, ''))
    .maybeSingle();

  if (emailOwner?.user_id && String(emailOwner.user_id) !== actor.id) {
    res.status(409).json({
      error: 'Cette adresse email est déjà connectée à un autre profil utilisateur.',
    });
    return;
  }

  // Vérification IMAP réelle en lecture seule avant tout enregistrement
  const check = await verifyImapCredentials({
    host: settings.imap_host,
    port: settings.imap_port,
    secure: settings.imap_tls,
    email: rawEmail,
    password: rawPassword,
    watchedFolder: settings.watched_folder,
  });

  if (!check.ok) {
    res.status(400).json({ error: check.error || 'Connexion IMAP refusée.' });
    return;
  }

  // Rôle de boîte calculé exclusivement côté serveur
  const isManagerBox =
    actor.role === 'admin' ||
    actor.role === 'manager' ||
    (await hasPermission(actor.id, 'quotes.timing.read', undefined));
  const accountRole: 'manager' | 'commercial' = isManagerBox ? 'manager' : 'commercial';

  const encryptedPassword = encryptMailSecret(rawPassword);
  const nowIso = new Date().toISOString();

  const { data: saved, error: upsertErr } = await adminClient
    .from('mail_inbox_accounts')
    .upsert(
      {
        user_id: actor.id,
        email_address: rawEmail,
        account_role: accountRole,
        encrypted_password: encryptedPassword,
        is_active: true,
        last_error: null,
        updated_at: nowIso,
      },
      { onConflict: 'user_id' }
    )
    .select('id, user_id, email_address, account_role, is_active, last_synced_at, last_error, created_at, updated_at')
    .single();

  if (upsertErr || !saved) {
    res.status(500).json({ error: 'Impossible d’enregistrer votre boîte mail.' });
    return;
  }

  await writeAuditLog(adminClient, {
    userId: actor.id,
    userEmail: actor.email,
    userRole: actor.role,
    action: 'CONNECT_SELF_MAILBOX',
    entityType: 'mail_inbox_account',
    entityId: String(saved.id),
    details: { email_address: rawEmail, account_role: accountRole },
    ipAddress: req.ip || null,
  });

  // Lancement non bloquant d'une première synchronisation
  void syncMailInboxAccount(adminClient, String(saved.id)).catch(() => undefined);

  res.json({
    account: sanitizeAccountPublicDto(saved),
  });
};

export const syncMyMailAccountHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service mail temporairement indisponible.' });
    return;
  }

  const { data: account } = await adminClient
    .from('mail_inbox_accounts')
    .select('id')
    .eq('user_id', actor.id)
    .eq('is_active', true)
    .maybeSingle();

  if (!account?.id) {
    res.status(404).json({ error: 'Aucune boîte mail active n’est rattachée à votre profil.' });
    return;
  }

  try {
    const summary = await syncMailInboxAccount(adminClient, String(account.id));
    res.json({ summary });
  } catch (err: unknown) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'La synchronisation IMAP a échoué.',
    });
  }
};

export const disconnectMyMailAccountHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service mail temporairement indisponible.' });
    return;
  }

  const { data: existing } = await adminClient
    .from('mail_inbox_accounts')
    .select('id, email_address')
    .eq('user_id', actor.id)
    .maybeSingle();

  if (!existing?.id) {
    res.json({ disconnected: true });
    return;
  }

  const { error } = await adminClient
    .from('mail_inbox_accounts')
    .delete()
    .eq('id', String(existing.id))
    .eq('user_id', actor.id);

  if (error) {
    res.status(500).json({ error: 'Impossible de déconnecter votre boîte mail.' });
    return;
  }

  await writeAuditLog(adminClient, {
    userId: actor.id,
    userEmail: actor.email,
    userRole: actor.role,
    action: 'DISCONNECT_SELF_MAILBOX',
    entityType: 'mail_inbox_account',
    entityId: String(existing.id),
    details: { email_address: existing.email_address },
    ipAddress: req.ip || null,
  });

  res.json({ disconnected: true });
};

export const listTeamMailboxesStatusHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service mail temporairement indisponible.' });
    return;
  }

  const { data: accounts, error } = await adminClient
    .from('mail_inbox_accounts')
    .select('id, user_id, email_address, account_role, is_active, last_synced_at, last_error, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(100);

  if (error) {
    res.status(500).json({ error: 'Impossible de charger l’état des boîtes mail.' });
    return;
  }

  const userIds = [...new Set((accounts || []).map((a) => String(a.user_id)))];
  const { data: profiles } = userIds.length > 0
    ? await adminClient.from('profiles').select('id, first_name, last_name, email').in('id', userIds)
    : { data: [] };

  const nameMap = new Map(
    (profiles || []).map((p) => [
      String(p.id),
      `${p.first_name || ''} ${p.last_name || ''}`.trim() || String(p.email || 'Collaborateur'),
    ])
  );

  res.json({
    mailboxes: (accounts || []).map((acc) =>
      sanitizeAccountPublicDto(acc, nameMap.get(String(acc.user_id)) || 'Collaborateur')
    ),
  });
};

export const getAdminMailSettingsHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service mail temporairement indisponible.' });
    return;
  }

  const [settings, accountsRes] = await Promise.all([
    loadGlobalMailSettings(adminClient),
    adminClient
      .from('mail_inbox_accounts')
      .select('id, user_id, email_address, account_role, is_active, last_synced_at, last_error, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(100),
  ]);

  const userIds = [...new Set((accountsRes.data || []).map((a) => String(a.user_id)))];
  const { data: profiles } = userIds.length > 0
    ? await adminClient.from('profiles').select('id, first_name, last_name, email').in('id', userIds)
    : { data: [] };

  const nameMap = new Map(
    (profiles || []).map((p) => [
      String(p.id),
      `${p.first_name || ''} ${p.last_name || ''}`.trim() || String(p.email || 'Collaborateur'),
    ])
  );

  res.json({
    encryptionReady: isMailEncryptionConfigured(),
    settings: settings
      ? {
          imapHost: settings.imap_host,
          imapPort: settings.imap_port,
          imapTls: settings.imap_tls,
          smtpHost: settings.smtp_host,
          smtpPort: settings.smtp_port,
          smtpTls: settings.smtp_tls,
          watchedFolder: settings.watched_folder,
          subjectKeywords: settings.subject_keywords,
          excludedSenders: settings.excluded_senders,
          isEnabled: settings.is_enabled,
          updatedAt: settings.updated_at,
        }
      : null,
    mailboxes: (accountsRes.data || []).map((acc) =>
      sanitizeAccountPublicDto(acc, nameMap.get(String(acc.user_id)) || 'Collaborateur')
    ),
  });
};

export const updateAdminMailSettingsHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  if (!isRecord(req.body)) {
    res.status(400).json({ error: 'Paramètres serveur mail invalides.' });
    return;
  }

  const allowedKeys = new Set([
    'imapHost',
    'imapPort',
    'imapTls',
    'smtpHost',
    'smtpPort',
    'smtpTls',
    'watchedFolder',
    'subjectKeywords',
    'excludedSenders',
    'isEnabled',
  ]);
  if (Object.keys(req.body).some((key) => !allowedKeys.has(key))) {
    res.status(400).json({ error: 'La requête contient des champs non autorisés.' });
    return;
  }

  const rawImapHost = typeof req.body['imapHost'] === 'string' ? req.body['imapHost'].trim() : '';
  const rawSmtpHost = typeof req.body['smtpHost'] === 'string' ? req.body['smtpHost'].trim() : '';
  const imapPort = Number(req.body['imapPort'] ?? 993);
  const smtpPort = Number(req.body['smtpPort'] ?? 465);
  const imapTls = Boolean(req.body['imapTls'] ?? true);
  const smtpTls = Boolean(req.body['smtpTls'] ?? true);
  const watchedFolder = typeof req.body['watchedFolder'] === 'string'
    ? req.body['watchedFolder'].trim()
    : 'INBOX';
  const isEnabled = Boolean(req.body['isEnabled'] ?? true);

  if (rawImapHost) {
    const checkImap = validatePublicMailHostFormat(rawImapHost);
    if (!checkImap.valid) {
      res.status(400).json({ error: `Serveur IMAP : ${checkImap.error}` });
      return;
    }
    try {
      await assertSafePublicMailHost(rawImapHost);
    } catch (err: unknown) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Serveur IMAP invalide.',
      });
      return;
    }
  }

  if (rawSmtpHost) {
    const checkSmtp = validatePublicMailHostFormat(rawSmtpHost);
    if (!checkSmtp.valid) {
      res.status(400).json({ error: `Serveur SMTP : ${checkSmtp.error}` });
      return;
    }
    try {
      await assertSafePublicMailHost(rawSmtpHost);
    } catch (err: unknown) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Serveur SMTP invalide.',
      });
      return;
    }
  }

  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
    res.status(400).json({ error: 'Port IMAP invalide (1 à 65535).' });
    return;
  }
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    res.status(400).json({ error: 'Port SMTP invalide (1 à 65535).' });
    return;
  }
  if (!watchedFolder || watchedFolder.length > 128) {
    res.status(400).json({ error: 'Le dossier IMAP surveillé doit contenir entre 1 et 128 caractères.' });
    return;
  }

  const parseStringArray = (val: unknown, label: string): { list?: string[]; error?: string } => {
    if (!Array.isArray(val) || val.length > 50) {
      return { error: `La liste « ${label} » est invalide (maximum 50 entrées).` };
    }
    const cleaned: string[] = [];
    for (const item of val) {
      if (typeof item !== 'string') return { error: `Entrée invalide dans « ${label} ».` };
      const trimmed = item.trim().toLowerCase();
      if (trimmed.length > 64) return { error: `Chaque entrée de « ${label} » est limitée à 64 caractères.` };
      if (trimmed) cleaned.push(trimmed);
    }
    return { list: [...new Set(cleaned)] };
  };

  const kwCheck = parseStringArray(req.body['subjectKeywords'] ?? [], 'Mots-clés de cotation');
  if (kwCheck.error || !kwCheck.list) {
    res.status(400).json({ error: kwCheck.error });
    return;
  }
  if (watchedFolder.toUpperCase() === 'INBOX' && kwCheck.list.length === 0) {
    res.status(400).json({
      error: 'Au moins un mot-clé de cotation est obligatoire lorsque le dossier surveillé est INBOX.',
    });
    return;
  }

  const exclCheck = parseStringArray(req.body['excludedSenders'] ?? [], 'Expéditeurs exclus');
  if (exclCheck.error || !exclCheck.list) {
    res.status(400).json({ error: exclCheck.error });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service mail temporairement indisponible.' });
    return;
  }

  const nowIso = new Date().toISOString();
  const { error: saveErr } = await adminClient.from('mail_global_settings').upsert(
    {
      id: 1,
      imap_host: rawImapHost.toLowerCase(),
      imap_port: imapPort,
      imap_tls: imapTls,
      smtp_host: rawSmtpHost.toLowerCase(),
      smtp_port: smtpPort,
      smtp_tls: smtpTls,
      watched_folder: watchedFolder,
      subject_keywords: kwCheck.list,
      excluded_senders: exclCheck.list,
      is_enabled: isEnabled,
      updated_by: actor.id,
      updated_at: nowIso,
    },
    { onConflict: 'id' }
  );

  if (saveErr) {
    res.status(500).json({ error: 'Impossible d’enregistrer les paramètres serveur mail.' });
    return;
  }

  await writeAuditLog(adminClient, {
    userId: actor.id,
    userEmail: actor.email,
    userRole: actor.role,
    action: 'UPDATE_GLOBAL_MAIL_SETTINGS',
    entityType: 'mail_global_settings',
    entityId: '1',
    details: {
      imap_host: rawImapHost.toLowerCase(),
      imap_port: imapPort,
      watched_folder: watchedFolder,
      is_enabled: isEnabled,
    },
    ipAddress: req.ip || null,
  });

  res.json({
    saved: true,
    settings: {
      imapHost: rawImapHost.toLowerCase(),
      imapPort,
      imapTls,
      smtpHost: rawSmtpHost.toLowerCase(),
      smtpPort,
      smtpTls,
      watchedFolder,
      subjectKeywords: kwCheck.list,
      excludedSenders: exclCheck.list,
      isEnabled,
      updatedAt: nowIso,
    },
  });
};
