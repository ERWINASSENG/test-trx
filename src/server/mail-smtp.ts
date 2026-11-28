import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { resolveSafePublicMailHost } from './mail-crypto';
import { withMailboxLock } from './mail-sync';

export const MAX_SMTP_RECIPIENTS = 50;
export const MAX_SMTP_SUBJECT_LENGTH = 250;
export const MAX_SMTP_TEXT_BODY_LENGTH = 100_000;
const MAX_REFERENCES_COUNT = 20;
const MAX_MESSAGE_ID_LENGTH = 255;

const STRICT_EMAIL_PATTERN =
  /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]{2,}$/;
const MESSAGE_ID_PATTERN = /^<[^<>\s]{1,250}>$/;

export interface ValidatedSendMailPayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  inReplyTo: string | null;
  references: string[];
  totalRecipients: number;
}

export interface SmtpSendContext {
  accountId: string;
  userId: string;
  emailAddress: string;
  displayName: string | null;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  sentFolder: string | null;
}

export interface SmtpSendResult {
  messageId: string;
  acceptedCount: number;
  rejectedCount: number;
  sentFolderAppended: boolean;
  detectedSentFolder: string | null;
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

function normalizeEmailList(
  rawList: unknown,
  fieldLabel: string
): { ok: true; emails: string[] } | { ok: false; error: string } {
  if (rawList === undefined || rawList === null) {
    return { ok: true, emails: [] };
  }
  if (!Array.isArray(rawList)) {
    return { ok: false, error: `Le champ ${fieldLabel} doit être une liste d’adresses email.` };
  }
  if (rawList.length > MAX_SMTP_RECIPIENTS) {
    return {
      ok: false,
      error: `Trop de destinataires dans ${fieldLabel} (maximum ${MAX_SMTP_RECIPIENTS}).`,
    };
  }

  const seen = new Set<string>();
  const emails: string[] = [];

  for (const rawItem of rawList) {
    if (typeof rawItem !== 'string') {
      return { ok: false, error: `Adresse email invalide dans ${fieldLabel}.` };
    }
    if (hasControlChars(rawItem)) {
      return {
        ok: false,
        error: `Caractères de contrôle interdits dans une adresse de ${fieldLabel}.`,
      };
    }
    const cleaned = rawItem.trim();
    if (!cleaned) continue;
    if (cleaned.length > 254 || !STRICT_EMAIL_PATTERN.test(cleaned)) {
      return {
        ok: false,
        error: `Adresse email invalide dans ${fieldLabel} : « ${cleaned.slice(0, 60)} ».`,
      };
    }
    const lower = cleaned.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      emails.push(cleaned);
    }
  }

  return { ok: true, emails };
}

function sanitizeMessageIdHeader(raw: unknown): string | null | 'INVALID' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return 'INVALID';
  if (hasControlChars(raw)) return 'INVALID';
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_MESSAGE_ID_LENGTH || !MESSAGE_ID_PATTERN.test(trimmed)) {
    return 'INVALID';
  }
  return trimmed;
}

export function validateSendMailPayload(
  raw: unknown
): { valid: true; data: ValidatedSendMailPayload } | { valid: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, error: 'Corps de requête invalide.' };
  }

  const body = raw as Record<string, unknown>;

  const toRes = normalizeEmailList(body['to'], 'À');
  if (!toRes.ok) return { valid: false, error: toRes.error };

  const ccRes = normalizeEmailList(body['cc'], 'Cc');
  if (!ccRes.ok) return { valid: false, error: ccRes.error };

  const bccRes = normalizeEmailList(body['bcc'], 'Cci');
  if (!bccRes.ok) return { valid: false, error: bccRes.error };

  if (toRes.emails.length === 0) {
    return { valid: false, error: 'Au moins un destinataire valide est requis dans le champ À.' };
  }

  const totalRecipients = toRes.emails.length + ccRes.emails.length + bccRes.emails.length;
  if (totalRecipients > MAX_SMTP_RECIPIENTS) {
    return {
      valid: false,
      error: `Le nombre total de destinataires ne peut pas dépasser ${MAX_SMTP_RECIPIENTS}.`,
    };
  }

  if (typeof body['subject'] !== 'string') {
    return { valid: false, error: 'L’objet du message est requis.' };
  }
  if (hasControlChars(body['subject'])) {
    return { valid: false, error: 'L’objet contient des caractères non autorisés.' };
  }
  const subject = body['subject'].trim();
  if (!subject) {
    return { valid: false, error: 'L’objet du message ne peut pas être vide.' };
  }
  if (subject.length > MAX_SMTP_SUBJECT_LENGTH) {
    return {
      valid: false,
      error: `L’objet ne peut pas dépasser ${MAX_SMTP_SUBJECT_LENGTH} caractères.`,
    };
  }

  if (typeof body['textBody'] !== 'string') {
    return { valid: false, error: 'Le contenu du message est requis.' };
  }
  if (hasNullByte(body['textBody'])) {
    return { valid: false, error: 'Le contenu du message contient des caractères non autorisés.' };
  }
  const textBody = body['textBody'];
  if (!textBody.trim()) {
    return { valid: false, error: 'Le contenu du message ne peut pas être vide.' };
  }
  if (textBody.length > MAX_SMTP_TEXT_BODY_LENGTH) {
    return {
      valid: false,
      error: `Le message ne peut pas dépasser ${MAX_SMTP_TEXT_BODY_LENGTH} caractères.`,
    };
  }

  const inReplyTo = sanitizeMessageIdHeader(body['inReplyTo']);
  if (inReplyTo === 'INVALID') {
    return { valid: false, error: 'En-tête In-Reply-To invalide.' };
  }

  const references: string[] = [];
  if (body['references'] !== undefined && body['references'] !== null) {
    if (!Array.isArray(body['references'])) {
      return { valid: false, error: 'En-tête References invalide.' };
    }
    const limited = body['references'].slice(-MAX_REFERENCES_COUNT);
    for (const item of limited) {
      const sanitizedRef = sanitizeMessageIdHeader(item);
      if (sanitizedRef === 'INVALID') {
        return { valid: false, error: 'En-tête References invalide.' };
      }
      if (sanitizedRef && !references.includes(sanitizedRef)) {
        references.push(sanitizedRef);
      }
    }
  }

  return {
    valid: true,
    data: {
      to: toRes.emails,
      cc: ccRes.emails,
      bcc: bccRes.emails,
      subject,
      textBody,
      inReplyTo,
      references,
      totalRecipients,
    },
  };
}

function resolveSmtpTlsOptions(port: number, tlsEnabled: boolean): {
  secure: boolean;
  requireTLS: boolean;
} {
  if (port === 465) {
    return { secure: true, requireTLS: false };
  }
  return { secure: false, requireTLS: Boolean(tlsEnabled) };
}

function buildSafeDisplayName(rawName: string | null): string | null {
  if (!rawName) return null;
  if (hasControlChars(rawName)) return null;
  const trimmed = rawName.trim().slice(0, 120);
  return trimmed || null;
}

async function appendToSentFolderBestEffort(
  ctx: SmtpSendContext,
  rawMimeMessage: Buffer
): Promise<{ appended: boolean; sentFolder: string | null }> {
  if (!ctx.imapHost) {
    return { appended: false, sentFolder: null };
  }

  try {
    return await withMailboxLock(ctx.accountId, async () => {
      const resolvedImap = await resolveSafePublicMailHost(ctx.imapHost);
      const client = new ImapFlow({
        host: resolvedImap.resolvedIp,
        servername: resolvedImap.host,
        port: ctx.imapPort,
        secure: ctx.imapTls,
        tls: {
          rejectUnauthorized: true,
          servername: resolvedImap.host,
        },
        disableAutoIdle: true,
        auth: {
          user: ctx.emailAddress,
          pass: ctx.password,
        },
        logger: false,
        connectionTimeout: 10_000,
        greetingTimeout: 8_000,
        socketTimeout: 15_000,
      });

      client.on('error', () => undefined);

      try {
        await client.connect();
        let targetFolder = ctx.sentFolder?.trim() || null;

        if (!targetFolder) {
          const folders = await client.list();
          const sentEntry =
            folders.find((f) => (f.specialUse || '').toLowerCase() === '\\sent') ??
            folders.find((f) =>
              ['sent', 'envoyés', 'éléments envoyés', 'inbox.sent', 'sent items', 'sent messages'].includes(
                f.path.toLowerCase()
              ) ||
              ['sent', 'envoyés', 'éléments envoyés', 'sent items'].includes(f.name.toLowerCase())
            );
          targetFolder = sentEntry?.path ?? null;
        }

        if (!targetFolder) {
          return { appended: false, sentFolder: null };
        }

        await client.append(targetFolder, rawMimeMessage, ['\\Seen']);
        return { appended: true, sentFolder: targetFolder };
      } finally {
        try {
          await client.logout();
        } catch {
          // Ignoré lors de la fermeture
        }
        client.close();
      }
    });
  } catch {
    return { appended: false, sentFolder: ctx.sentFolder };
  }
}

export async function sendMailViaSmtp(
  ctx: SmtpSendContext,
  payload: ValidatedSendMailPayload
): Promise<SmtpSendResult> {
  const resolvedSmtp = await resolveSafePublicMailHost(ctx.smtpHost);
  const { secure, requireTLS } = resolveSmtpTlsOptions(ctx.smtpPort, ctx.smtpTls);
  const safeDisplayName = buildSafeDisplayName(ctx.displayName);
  const fromField = safeDisplayName
    ? { name: safeDisplayName, address: ctx.emailAddress }
    : ctx.emailAddress;

  const baseMailOptions: nodemailer.SendMailOptions = {
    from: fromField,
    to: payload.to,
    ...(payload.cc.length > 0 ? { cc: payload.cc } : {}),
    subject: payload.subject,
    text: payload.textBody,
    ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
    ...(payload.references.length > 0 ? { references: payload.references } : {}),
  };

  // 1. Pré-compilation MIME RFC822 (sans Bcc) pour garantir un Message-ID stable et la copie Sent
  const streamTransporter = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  const compiled = await streamTransporter.sendMail(baseMailOptions);
  const messageId = String(compiled.messageId || '').trim();
  const rawMimeBuffer = Buffer.isBuffer(compiled.message)
    ? compiled.message
    : Buffer.from(String(compiled.message || ''), 'utf8');

  // 2. Envoi SMTP authentifié (avec Bcc dans l'enveloppe uniquement)
  const smtpTransporter = nodemailer.createTransport({
    host: resolvedSmtp.resolvedIp,
    port: ctx.smtpPort,
    secure,
    requireTLS,
    auth: {
      user: ctx.emailAddress,
      pass: ctx.password,
    },
    tls: {
      rejectUnauthorized: true,
      servername: resolvedSmtp.host,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  });

  try {
    const info = await smtpTransporter.sendMail({
      ...baseMailOptions,
      ...(payload.bcc.length > 0 ? { bcc: payload.bcc } : {}),
      ...(messageId ? { messageId } : {}),
    });

    const finalMessageId = String(info.messageId || messageId || '').trim();
    const appendOutcome = await appendToSentFolderBestEffort(ctx, rawMimeBuffer);

    return {
      messageId: finalMessageId,
      acceptedCount: Array.isArray(info.accepted) ? info.accepted.length : payload.totalRecipients,
      rejectedCount: Array.isArray(info.rejected) ? info.rejected.length : 0,
      sentFolderAppended: appendOutcome.appended,
      detectedSentFolder: appendOutcome.sentFolder,
    };
  } finally {
    smtpTransporter.close();
  }
}

export async function verifySmtpConnection(params: {
  host: string;
  port: number;
  tlsEnabled: boolean;
  auth?: { email: string; password: string };
}): Promise<{ ok: boolean; authenticated: boolean; message: string }> {
  let resolvedSmtp: { host: string; resolvedIp: string };
  try {
    resolvedSmtp = await resolveSafePublicMailHost(params.host);
  } catch (err: unknown) {
    return {
      ok: false,
      authenticated: false,
      message: err instanceof Error ? err.message : 'Serveur SMTP invalide ou non autorisé.',
    };
  }

  const { secure, requireTLS } = resolveSmtpTlsOptions(params.port, params.tlsEnabled);
  const transporter = nodemailer.createTransport({
    host: resolvedSmtp.resolvedIp,
    port: params.port,
    secure,
    requireTLS,
    ...(params.auth
      ? {
          auth: {
            user: params.auth.email,
            pass: params.auth.password,
          },
        }
      : {}),
    tls: {
      rejectUnauthorized: true,
      servername: resolvedSmtp.host,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  });

  try {
    await transporter.verify();
    return {
      ok: true,
      authenticated: Boolean(params.auth),
      message: params.auth
        ? `Connexion et authentification SMTP réussies sur ${resolvedSmtp.host}:${params.port}.`
        : `Serveur SMTP joignable en TLS sur ${resolvedSmtp.host}:${params.port} (connectez votre boîte dans Mon Profil pour tester aussi l’authentification).`,
    };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message.toLowerCase() : '';
    const isAuthErr =
      rawMsg.includes('auth') ||
      rawMsg.includes('535') ||
      rawMsg.includes('credentials') ||
      rawMsg.includes('login');
    return {
      ok: false,
      authenticated: false,
      message: isAuthErr
        ? 'Serveur SMTP joignable, mais authentification refusée (vérifiez vos identifiants mail dans Mon Profil).'
        : 'Impossible de joindre le serveur SMTP avec ces paramètres (vérifiez l’hôte, le port 465/587 et TLS).',
    };
  } finally {
    transporter.close();
  }
}
