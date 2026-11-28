import crypto from 'node:crypto';
import express from 'express';
import { getSupabaseAdmin } from './auth';
import { decryptMailSecret, isMailEncryptionConfigured } from './mail-crypto';
import { mailProvider } from './mail-imap';
import {
  parseMailMessageRef,
  sanitizeFolderName,
  type MailConnectionContext,
} from './mail-provider';
import { loadGlobalMailSettings } from './mail-sync';

interface MailReadActor {
  id: string;
  email?: string;
  role?: string;
}

type MailboxResolutionResult =
  | { ok: true; ctx: MailConnectionContext; mailboxEmail: string; watchedFolder: string }
  | { ok: false; status: number; code: string; error: string };

function getActor(req: express.Request): MailReadActor | null {
  const user = (req as unknown as Record<string, unknown>)['user'] as MailReadActor | undefined;
  return user?.id ? user : null;
}

function setPrivateNoStoreHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
}

async function resolveActorMailboxContext(actorId: string): Promise<MailboxResolutionResult> {
  if (!isMailEncryptionConfigured()) {
    return {
      ok: false,
      status: 503,
      code: 'MAIL_SERVER_NOT_CONFIGURED',
      error: 'Le service de messagerie n’est pas encore activé sur le serveur.',
    };
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    return {
      ok: false,
      status: 503,
      code: 'MAIL_SERVICE_UNAVAILABLE',
      error: 'Service de messagerie temporairement indisponible.',
    };
  }

  const [settings, accountRes] = await Promise.all([
    loadGlobalMailSettings(adminClient),
    adminClient
      .from('mail_inbox_accounts')
      .select('id, user_id, email_address, encrypted_password, is_active')
      .eq('user_id', actorId)
      .maybeSingle(),
  ]);

  if (!settings || !settings.is_enabled || !settings.imap_host) {
    return {
      ok: false,
      status: 503,
      code: 'MAIL_SERVER_NOT_CONFIGURED',
      error: 'Le serveur IMAP de l’entreprise n’est pas encore configuré.',
    };
  }

  if (accountRes.error) {
    return {
      ok: false,
      status: 500,
      code: 'MAIL_ACCOUNT_LOOKUP_FAILED',
      error: 'Impossible de charger les paramètres de votre boîte mail.',
    };
  }

  const account = accountRes.data;
  if (!account || !account.is_active || !account.encrypted_password) {
    return {
      ok: false,
      status: 412,
      code: 'MAILBOX_NOT_CONNECTED',
      error: 'Votre boîte mail professionnelle n’est pas encore connectée.',
    };
  }

  let password: string;
  try {
    password = decryptMailSecret(String(account.encrypted_password));
  } catch {
    return {
      ok: false,
      status: 500,
      code: 'MAIL_SECRET_DECRYPT_FAILED',
      error: 'Impossible de déchiffrer vos identifiants mail. Reconnectez votre boîte dans Mon Profil.',
    };
  }

  return {
    ok: true,
    mailboxEmail: String(account.email_address),
    watchedFolder: settings.watched_folder || 'INBOX',
    ctx: {
      accountId: String(account.id),
      userId: actorId,
      emailAddress: String(account.email_address),
      password,
      imapHost: settings.imap_host,
      imapPort: settings.imap_port,
      imapTls: settings.imap_tls,
    },
  };
}

function handleImapError(res: express.Response, err: unknown): void {
  const correlationId = crypto.randomUUID().slice(0, 8);
  const rawMsg = err instanceof Error ? err.message.toLowerCase() : '';

  if (rawMsg.includes('auth') || rawMsg.includes('credentials') || rawMsg.includes('login')) {
    res.status(401).json({
      code: 'MAILBOX_AUTH_FAILED',
      error: 'Identifiants mail refusés par le serveur. Mettez à jour votre mot de passe dans Mon Profil.',
      correlationId,
    });
    return;
  }

  if (rawMsg.includes('mailbox') || rawMsg.includes('nonexistent') || rawMsg.includes('does not exist')) {
    res.status(404).json({
      code: 'MAIL_FOLDER_NOT_FOUND',
      error: 'Le dossier demandé est introuvable dans votre boîte mail.',
      correlationId,
    });
    return;
  }

  if (rawMsg.includes('adresse interne') || rawMsg.includes('non autoris')) {
    res.status(400).json({
      code: 'MAIL_HOST_FORBIDDEN',
      error: 'Configuration du serveur mail refusée par la politique de sécurité.',
      correlationId,
    });
    return;
  }

  console.error(`[MAIL-READ][${correlationId}] Erreur IMAP:`, err instanceof Error ? err.name : 'unknown');
  res.status(502).json({
    code: 'MAIL_UPSTREAM_UNAVAILABLE',
    error: `Impossible de joindre votre serveur mail pour le moment (réf. ${correlationId}).`,
    correlationId,
  });
}

function parseBoundedInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export const listMailFoldersHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const folders = await mailProvider.listFolders(resolved.ctx);
    res.json({
      mailboxEmail: resolved.mailboxEmail,
      folders,
    });
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};

export const listMailMessagesHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const rawFolder = req.query['folder'];
  const folder =
    rawFolder === undefined || rawFolder === ''
      ? 'INBOX'
      : sanitizeFolderName(rawFolder);
  if (!folder) {
    res.status(400).json({ error: 'Nom de dossier mail invalide.' });
    return;
  }

  const page = parseBoundedInt(req.query['page'], 1, 1, 1000);
  const limit = parseBoundedInt(req.query['limit'], 25, 1, 50);
  if (page === null || limit === null) {
    res.status(400).json({ error: 'Paramètres de pagination invalides (page 1-1000, limit 1-50).' });
    return;
  }

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const result = await mailProvider.listMessages(resolved.ctx, {
      folder,
      page,
      limit,
    });
    res.json(result);
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};

export const getMailMessageHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const parsedRef = parseMailMessageRef(req.params['ref']);
  if (!parsedRef) {
    res.status(400).json({ error: 'Référence de message invalide.' });
    return;
  }

  const allowRemoteImages =
    req.query['allowRemoteImages'] === 'true' || req.query['allowRemoteImages'] === '1';

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const message = await mailProvider.getMessage(resolved.ctx, {
      folder: parsedRef.folder,
      uidValidity: parsedRef.uidValidity,
      uid: parsedRef.uid,
      allowRemoteImages,
    });

    if (!message) {
      res.status(404).json({
        code: 'MAIL_MESSAGE_NOT_FOUND',
        error: 'Message introuvable ou déplacé.',
      });
      return;
    }

    res.json({ message });
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};

export const getMailUnreadCountHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const resolved = await resolveActorMailboxContext(actor.id);
  if (!resolved.ok) {
    if (resolved.code === 'MAILBOX_NOT_CONNECTED' || resolved.code === 'MAIL_SERVER_NOT_CONFIGURED') {
      res.json({
        connected: false,
        folder: 'INBOX',
        unreadCount: 0,
        totalCount: 0,
      });
      return;
    }
    res.status(resolved.status).json({ code: resolved.code, error: resolved.error });
    return;
  }

  try {
    const summary = await mailProvider.getUnreadCount(resolved.ctx, 'INBOX');
    res.json({
      connected: true,
      ...summary,
    });
  } catch (err: unknown) {
    handleImapError(res, err);
  }
};
