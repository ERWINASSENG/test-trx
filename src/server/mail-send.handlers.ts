import crypto from 'node:crypto';
import express from 'express';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';
import {
  decryptMailSecret,
  isMailEncryptionConfigured,
  validatePublicMailHostFormat,
} from './mail-crypto';
import {
  sendMailViaSmtp,
  validateSendMailPayload,
  verifySmtpConnection,
} from './mail-smtp';
import { loadGlobalMailSettings } from './mail-sync';

interface MailSendActor {
  id: string;
  email?: string;
  role?: string;
}

function getActor(req: express.Request): MailSendActor | null {
  const user = (req as unknown as Record<string, unknown>)['user'] as MailSendActor | undefined;
  return user?.id ? user : null;
}

function setPrivateNoStoreHeaders(res: express.Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
}

function classifySmtpError(err: unknown): {
  status: number;
  code: string;
  userMessage: string;
} {
  const rawMsg = err instanceof Error ? err.message.toLowerCase() : '';

  if (
    rawMsg.includes('auth') ||
    rawMsg.includes('535') ||
    rawMsg.includes('credentials') ||
    rawMsg.includes('login')
  ) {
    return {
      status: 401,
      code: 'MAILBOX_AUTH_FAILED',
      userMessage:
        'Authentification SMTP refusée. Mettez à jour votre mot de passe mail dans Mon Profil.',
    };
  }

  if (rawMsg.includes('adresse interne') || rawMsg.includes('non autoris')) {
    return {
      status: 400,
      code: 'MAIL_HOST_FORBIDDEN',
      userMessage: 'Serveur SMTP refusé par la politique de sécurité.',
    };
  }

  if (rawMsg.includes('550') || rawMsg.includes('553') || rawMsg.includes('recipient')) {
    return {
      status: 422,
      code: 'MAIL_RECIPIENT_REJECTED',
      userMessage: 'Un ou plusieurs destinataires ont été refusés par le serveur mail.',
    };
  }

  return {
    status: 502,
    code: 'MAIL_SMTP_SEND_FAILED',
    userMessage: 'Impossible d’envoyer le message pour le moment. Réessayez dans quelques instants.',
  };
}

export const sendMailHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const validated = validateSendMailPayload(req.body);
  if (!validated.valid) {
    res.status(400).json({ code: 'MAIL_INVALID_PAYLOAD', error: validated.error });
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
    res.status(503).json({
      code: 'MAIL_SERVICE_UNAVAILABLE',
      error: 'Service de messagerie temporairement indisponible.',
    });
    return;
  }

  const [settings, accountRes, profileRes] = await Promise.all([
    loadGlobalMailSettings(adminClient),
    adminClient
      .from('mail_inbox_accounts')
      .select('id, user_id, email_address, display_name, encrypted_password, sent_folder, is_active')
      .eq('user_id', actor.id)
      .maybeSingle(),
    adminClient
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', actor.id)
      .maybeSingle(),
  ]);

  if (!settings || !settings.is_enabled || !settings.smtp_host) {
    res.status(503).json({
      code: 'MAIL_SMTP_NOT_CONFIGURED',
      error: 'Le serveur SMTP de l’entreprise n’est pas encore configuré par l’administrateur.',
    });
    return;
  }

  if (accountRes.error) {
    res.status(500).json({
      code: 'MAIL_ACCOUNT_LOOKUP_FAILED',
      error: 'Impossible de charger les paramètres de votre boîte mail.',
    });
    return;
  }

  const account = accountRes.data;
  if (!account || !account.is_active || !account.encrypted_password) {
    res.status(412).json({
      code: 'MAILBOX_NOT_CONNECTED',
      error: 'Connectez votre boîte mail dans Mon Profil avant d’envoyer un message.',
    });
    return;
  }

  let password: string;
  try {
    password = decryptMailSecret(String(account.encrypted_password));
  } catch {
    res.status(500).json({
      code: 'MAIL_SECRET_DECRYPT_FAILED',
      error: 'Impossible de déchiffrer vos identifiants mail. Reconnectez votre boîte dans Mon Profil.',
    });
    return;
  }

  const profileFullName = [
    typeof profileRes.data?.first_name === 'string' ? profileRes.data.first_name.trim() : '',
    typeof profileRes.data?.last_name === 'string' ? profileRes.data.last_name.trim() : '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  const effectiveDisplayName =
    (typeof account.display_name === 'string' && account.display_name.trim()) ||
    profileFullName ||
    null;

  const accountId = String(account.id);
  const subjectPreview = validated.data.subject.slice(0, 160);

  try {
    const result = await sendMailViaSmtp(
      {
        accountId,
        userId: actor.id,
        emailAddress: String(account.email_address),
        displayName: effectiveDisplayName,
        password,
        smtpHost: settings.smtp_host,
        smtpPort: settings.smtp_port,
        smtpTls: settings.smtp_tls,
        imapHost: settings.imap_host,
        imapPort: settings.imap_port,
        imapTls: settings.imap_tls,
        sentFolder: typeof account.sent_folder === 'string' ? account.sent_folder : null,
      },
      validated.data
    );

    // Mémorise le dossier Sent auto-détecté pour accélérer les envois suivants
    if (!account.sent_folder && result.detectedSentFolder) {
      await adminClient
        .from('mail_inbox_accounts')
        .update({ sent_folder: result.detectedSentFolder, updated_at: new Date().toISOString() })
        .eq('id', accountId);
    }

    await Promise.all([
      adminClient.from('mail_send_log').insert({
        user_id: actor.id,
        account_id: accountId,
        recipient_count: validated.data.totalRecipients,
        subject_preview: subjectPreview,
        smtp_message_id: result.messageId ? result.messageId.slice(0, 255) : null,
        status: 'sent',
        sent_folder_appended: result.sentFolderAppended,
        error_code: null,
      }),
      writeAuditLog(adminClient, {
        userId: actor.id,
        action: 'SEND_MAIL_SMTP',
        entityType: 'mail_inbox_account',
        entityId: accountId,
        details: {
          recipient_count: validated.data.totalRecipients,
          sent_folder_appended: result.sentFolderAppended,
          is_reply: Boolean(validated.data.inReplyTo),
        },
      }),
    ]);

    res.json({
      sent: true,
      messageId: result.messageId,
      acceptedCount: result.acceptedCount,
      rejectedCount: result.rejectedCount,
      sentFolderAppended: result.sentFolderAppended,
    });
  } catch (err: unknown) {
    const correlationId = crypto.randomUUID().slice(0, 8);
    const classified = classifySmtpError(err);

    console.error(
      `[MAIL-SEND][${correlationId}] Échec envoi SMTP (${classified.code}):`,
      err instanceof Error ? err.name : 'unknown'
    );

    await adminClient.from('mail_send_log').insert({
      user_id: actor.id,
      account_id: accountId,
      recipient_count: validated.data.totalRecipients,
      subject_preview: subjectPreview,
      smtp_message_id: null,
      status: 'failed',
      sent_folder_appended: false,
      error_code: classified.code,
    });

    res.status(classified.status).json({
      code: classified.code,
      error: `${classified.userMessage} (réf. ${correlationId})`,
      correlationId,
    });
  }
};

export const testAdminSmtpSettingsHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  setPrivateNoStoreHeaders(res);
  const actor = getActor(req);
  if (!actor) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const body =
    typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  const hostCheck = validatePublicMailHostFormat(body['smtpHost']);
  if (!hostCheck.valid || !hostCheck.host) {
    res.status(400).json({ error: hostCheck.error || 'Hôte SMTP invalide.' });
    return;
  }

  const smtpPort = Number(body['smtpPort']);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    res.status(400).json({ error: 'Port SMTP invalide (attendu entre 1 et 65535).' });
    return;
  }

  const smtpTls = Boolean(body['smtpTls'] ?? true);

  let auth: { email: string; password: string } | undefined;
  const adminClient = getSupabaseAdmin();
  if (adminClient && isMailEncryptionConfigured()) {
    const { data: ownAccount } = await adminClient
      .from('mail_inbox_accounts')
      .select('email_address, encrypted_password, is_active')
      .eq('user_id', actor.id)
      .maybeSingle();

    if (ownAccount?.is_active && ownAccount.encrypted_password) {
      try {
        auth = {
          email: String(ownAccount.email_address),
          password: decryptMailSecret(String(ownAccount.encrypted_password)),
        };
      } catch {
        auth = undefined;
      }
    }
  }

  const result = await verifySmtpConnection({
    host: hostCheck.host,
    port: smtpPort,
    tlsEnabled: smtpTls,
    auth,
  });

  if (!result.ok) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
};
