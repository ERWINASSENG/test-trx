export type MailFolderSpecialUse =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'junk'
  | 'archive'
  | 'custom';

export interface MailAddressDto {
  name: string;
  address: string;
}

export interface MailFolderDto {
  path: string;
  name: string;
  specialUse: MailFolderSpecialUse;
  totalMessages: number;
  unreadMessages: number;
  selectable: boolean;
}

export interface MailSummaryDto {
  ref: string;
  folder: string;
  uid: number;
  uidValidity: number;
  messageId: string | null;
  subject: string;
  from: MailAddressDto | null;
  to: MailAddressDto[];
  date: string | null;
  snippet: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  sizeBytes: number;
}

export interface MailAttachmentMetaDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
}

export interface MailDetailDto extends MailSummaryDto {
  cc: MailAddressDto[];
  replyTo: MailAddressDto[];
  inReplyTo: string | null;
  references: string[];
  textBody: string;
  sanitizedHtml: string;
  hasBlockedRemoteImages: boolean;
  blockedRemoteImagesCount: number;
  attachments: MailAttachmentMetaDto[];
  linkedQuoteId?: string | null;
}

export interface MailFoldersResponse {
  mailboxEmail: string;
  folders: MailFolderDto[];
}

export interface MailMessagesPageResponse {
  folder: string;
  uidValidity: number;
  page: number;
  limit: number;
  total: number;
  hasNextPage: boolean;
  messages: MailSummaryDto[];
}

export interface MailMessageDetailResponse {
  message: MailDetailDto;
}

export interface MailUnreadCountResponse {
  connected: boolean;
  folder: string;
  unreadCount: number;
  totalCount: number;
}

export type MailErrorCode =
  | 'MAILBOX_NOT_CONNECTED'
  | 'MAIL_SERVER_NOT_CONFIGURED'
  | 'MAIL_SMTP_NOT_CONFIGURED'
  | 'MAILBOX_AUTH_FAILED'
  | 'MAIL_FOLDER_NOT_FOUND'
  | 'MAIL_MESSAGE_NOT_FOUND'
  | 'MAIL_UPSTREAM_UNAVAILABLE'
  | 'MAIL_INVALID_PAYLOAD'
  | 'MAIL_RECIPIENT_REJECTED'
  | 'MAIL_SMTP_SEND_FAILED'
  | 'MAIL_ATTACHMENT_TOO_LARGE'
  | 'MAIL_ATTACHMENT_NOT_FOUND'
  | 'UNKNOWN';

export type MailMoveTarget = 'trash' | 'archive';

export interface CreateQuoteFromMailResponseDto {
  created: boolean;
  quoteId: string;
  quoteNumber?: string;
}

export interface SendMailRequestDto {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  inReplyTo?: string | null;
  references?: string[];
}

export interface SendMailResponseDto {
  sent: boolean;
  messageId: string;
  acceptedCount: number;
  rejectedCount: number;
  sentFolderAppended: boolean;
}

export type MailComposerMode = 'new' | 'reply' | 'reply_all' | 'forward';

export interface MailComposerDraft {
  mode: MailComposerMode;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  inReplyTo: string | null;
  references: string[];
}
