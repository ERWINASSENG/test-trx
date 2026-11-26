export type MailAccountRole = 'manager' | 'commercial';

export interface MailInboxAccountDto {
  id: string;
  userId: string;
  userName?: string;
  emailAddress: string;
  accountRole: MailAccountRole;
  isActive: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MyMailAccountResponse {
  configuredOnServer: boolean;
  account: MailInboxAccountDto | null;
}

export interface MailGlobalSettings {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  watchedFolder: string;
  subjectKeywords: string[];
  excludedSenders: string[];
  isEnabled: boolean;
  updatedAt?: string;
}

export interface AdminMailSettingsResponse {
  encryptionReady: boolean;
  settings: MailGlobalSettings | null;
  mailboxes: MailInboxAccountDto[];
}

export interface MailSyncSummaryDto {
  accountId: string;
  ingestedCount: number;
  repliesLinkedCount: number;
  seenUpdatedCount: number;
  lastSyncedAt: string;
}
