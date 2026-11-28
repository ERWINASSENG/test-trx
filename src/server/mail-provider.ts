export type MailFolderSpecialUse =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'junk'
  | 'archive'
  | 'custom';

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailFolder {
  path: string;
  name: string;
  specialUse: MailFolderSpecialUse;
  totalMessages: number;
  unreadMessages: number;
  selectable: boolean;
}

export interface MailSummary {
  /** Référence opaque et stable : <base64url(folder)>:<uidValidity>:<uid> */
  ref: string;
  folder: string;
  uid: number;
  uidValidity: number;
  messageId: string | null;
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  date: string | null;
  snippet: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  sizeBytes: number;
}

export interface MailAttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
}

export interface MailDetail extends MailSummary {
  cc: MailAddress[];
  replyTo: MailAddress[];
  inReplyTo: string | null;
  references: string[];
  textBody: string;
  /** HTML strictement assaini côté serveur (images distantes bloquées par défaut). */
  sanitizedHtml: string;
  /** HTML assaini avec images distantes autorisées (uniquement si demandé explicitement par l'utilisateur). */
  hasBlockedRemoteImages: boolean;
  blockedRemoteImagesCount: number;
  attachments: MailAttachmentMeta[];
}

export interface MailPageResult {
  folder: string;
  uidValidity: number;
  page: number;
  limit: number;
  total: number;
  hasNextPage: boolean;
  messages: MailSummary[];
}

export interface MailUnreadSummary {
  folder: string;
  unreadCount: number;
  totalCount: number;
}

export interface MailConnectionContext {
  accountId: string;
  userId: string;
  emailAddress: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
}

export interface MailProvider {
  listFolders(ctx: MailConnectionContext): Promise<MailFolder[]>;
  listMessages(
    ctx: MailConnectionContext,
    options: { folder: string; page: number; limit: number }
  ): Promise<MailPageResult>;
  getMessage(
    ctx: MailConnectionContext,
    options: {
      folder: string;
      uidValidity: number;
      uid: number;
      allowRemoteImages: boolean;
    }
  ): Promise<MailDetail | null>;
  getUnreadCount(ctx: MailConnectionContext, folder?: string): Promise<MailUnreadSummary>;
}

const MAX_FOLDER_LENGTH = 128;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function sanitizeFolderName(rawFolder: unknown): string | null {
  if (typeof rawFolder !== 'string') return null;
  const trimmed = rawFolder.trim();
  if (!trimmed || trimmed.length > MAX_FOLDER_LENGTH) return null;
  if (hasControlChars(trimmed)) return null;
  return trimmed;
}

export function encodeMailMessageRef(folder: string, uidValidity: number, uid: number): string {
  const encodedFolder = Buffer.from(folder, 'utf8').toString('base64url');
  return `${encodedFolder}:${uidValidity}:${uid}`;
}

export interface ParsedMailMessageRef {
  folder: string;
  uidValidity: number;
  uid: number;
}

export function parseMailMessageRef(rawRef: unknown): ParsedMailMessageRef | null {
  if (typeof rawRef !== 'string') return null;
  const trimmed = rawRef.trim();
  if (!trimmed || trimmed.length > 320) return null;

  const parts = trimmed.split(':');
  if (parts.length !== 3) return null;

  const [encodedFolder, rawUidValidity, rawUid] = parts;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(encodedFolder)) return null;
  if (!/^\d{1,12}$/.test(rawUidValidity) || !/^\d{1,12}$/.test(rawUid)) return null;

  const uidValidity = Number(rawUidValidity);
  const uid = Number(rawUid);
  if (
    !Number.isSafeInteger(uidValidity) ||
    uidValidity < 0 ||
    !Number.isSafeInteger(uid) ||
    uid <= 0
  ) {
    return null;
  }

  let decodedFolder: string;
  try {
    decodedFolder = Buffer.from(encodedFolder, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const safeFolder = sanitizeFolderName(decodedFolder);
  if (!safeFolder) return null;

  return { folder: safeFolder, uidValidity, uid };
}
