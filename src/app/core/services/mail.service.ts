import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  MailDetailDto,
  MailErrorCode,
  MailFolderDto,
  MailFoldersResponse,
  MailMessageDetailResponse,
  MailMessagesPageResponse,
  MailSummaryDto,
  MailUnreadCountResponse,
} from '../models/mail.model';
import { getApiErrorMessage } from '../utils/api-error.util';
import { AuthService } from './auth.service';

export interface MailReadApiResult<T> {
  success: boolean;
  data?: T;
  code?: MailErrorCode;
  error?: string;
}

const KNOWN_ERROR_CODES = new Set<MailErrorCode>([
  'MAILBOX_NOT_CONNECTED',
  'MAIL_SERVER_NOT_CONFIGURED',
  'MAILBOX_AUTH_FAILED',
  'MAIL_FOLDER_NOT_FOUND',
  'MAIL_MESSAGE_NOT_FOUND',
  'MAIL_UPSTREAM_UNAVAILABLE',
  'UNKNOWN',
]);

@Injectable({ providedIn: 'root' })
export class MailService {
  private readonly authService = inject(AuthService);

  private dataUserId: string | null | undefined;
  private messagesRequestSeq = 0;
  private detailRequestSeq = 0;

  private readonly _mailboxEmail = signal<string | null>(null);
  private readonly _folders = signal<MailFolderDto[]>([]);
  private readonly _selectedFolder = signal<string>('INBOX');
  private readonly _messages = signal<MailSummaryDto[]>([]);
  private readonly _page = signal<number>(1);
  private readonly _limit = signal<number>(25);
  private readonly _totalMessages = signal<number>(0);
  private readonly _hasNextPage = signal<boolean>(false);
  private readonly _selectedMessage = signal<MailDetailDto | null>(null);
  private readonly _selectedMessageRef = signal<string | null>(null);

  private readonly _unreadCount = signal<number>(0);
  private readonly _isMailboxConnected = signal<boolean>(false);

  private readonly _isLoadingFolders = signal<boolean>(false);
  private readonly _isLoadingMessages = signal<boolean>(false);
  private readonly _isLoadingDetail = signal<boolean>(false);

  private readonly _errorCode = signal<MailErrorCode | null>(null);
  private readonly _errorMessage = signal<string | null>(null);

  public readonly mailboxEmail = computed(() => this._mailboxEmail());
  public readonly folders = computed(() => this._folders());
  public readonly selectedFolder = computed(() => this._selectedFolder());
  public readonly messages = computed(() => this._messages());
  public readonly page = computed(() => this._page());
  public readonly limit = computed(() => this._limit());
  public readonly totalMessages = computed(() => this._totalMessages());
  public readonly hasNextPage = computed(() => this._hasNextPage());
  public readonly selectedMessage = computed(() => this._selectedMessage());
  public readonly selectedMessageRef = computed(() => this._selectedMessageRef());

  public readonly unreadCount = computed(() => this._unreadCount());
  public readonly isMailboxConnected = computed(() => this._isMailboxConnected());

  public readonly isLoadingFolders = computed(() => this._isLoadingFolders());
  public readonly isLoadingMessages = computed(() => this._isLoadingMessages());
  public readonly isLoadingDetail = computed(() => this._isLoadingDetail());

  public readonly errorCode = computed(() => this._errorCode());
  public readonly errorMessage = computed(() => this._errorMessage());

  constructor() {
    effect(() => {
      this.authService.currentUser();
      this.resetForAccountChange();
    });
  }

  public async loadFolders(): Promise<MailReadApiResult<MailFoldersResponse>> {
    this._isLoadingFolders.set(true);
    this._errorCode.set(null);
    this._errorMessage.set(null);
    try {
      const res = await this.get<MailFoldersResponse>('/api/mail/folders');
      if (res.success && res.data) {
        this._mailboxEmail.set(res.data.mailboxEmail || null);
        this._folders.set(Array.isArray(res.data.folders) ? res.data.folders : []);
        this._isMailboxConnected.set(true);

        const inbox = res.data.folders.find((f) => f.specialUse === 'inbox');
        if (inbox) {
          this._unreadCount.set(inbox.unreadMessages);
        }
      } else {
        this.applyError(res.code, res.error);
      }
      return res;
    } finally {
      this._isLoadingFolders.set(false);
    }
  }

  public async loadMessages(
    folder = this._selectedFolder(),
    page = 1,
    limit = this._limit()
  ): Promise<MailReadApiResult<MailMessagesPageResponse>> {
    const seq = ++this.messagesRequestSeq;
    this._selectedFolder.set(folder);
    this._page.set(page);
    this._isLoadingMessages.set(true);
    this._errorCode.set(null);
    this._errorMessage.set(null);

    try {
      const params = new URLSearchParams({
        folder,
        page: String(page),
        limit: String(limit),
      });
      const res = await this.get<MailMessagesPageResponse>(`/api/mail/messages?${params.toString()}`);
      if (seq !== this.messagesRequestSeq) {
        return res;
      }

      if (res.success && res.data) {
        this._messages.set(Array.isArray(res.data.messages) ? res.data.messages : []);
        this._page.set(res.data.page);
        this._limit.set(res.data.limit);
        this._totalMessages.set(res.data.total);
        this._hasNextPage.set(Boolean(res.data.hasNextPage));
        this._isMailboxConnected.set(true);
      } else {
        this._messages.set([]);
        this._totalMessages.set(0);
        this._hasNextPage.set(false);
        this.applyError(res.code, res.error);
      }
      return res;
    } finally {
      if (seq === this.messagesRequestSeq) {
        this._isLoadingMessages.set(false);
      }
    }
  }

  public async loadMessageDetail(
    ref: string,
    allowRemoteImages = false
  ): Promise<MailReadApiResult<MailDetailDto>> {
    const seq = ++this.detailRequestSeq;
    this._selectedMessageRef.set(ref);
    this._isLoadingDetail.set(true);

    try {
      const encodedRef = encodeURIComponent(ref);
      const query = allowRemoteImages ? '?allowRemoteImages=1' : '';
      const res = await this.get<MailMessageDetailResponse>(`/api/mail/messages/${encodedRef}${query}`);
      if (seq !== this.detailRequestSeq) {
        return { success: false };
      }

      if (res.success && res.data?.message) {
        this._selectedMessage.set(res.data.message);
        return { success: true, data: res.data.message };
      }

      return { success: false, code: res.code, error: res.error };
    } finally {
      if (seq === this.detailRequestSeq) {
        this._isLoadingDetail.set(false);
      }
    }
  }

  public clearSelectedMessage(): void {
    this.detailRequestSeq += 1;
    this._selectedMessageRef.set(null);
    this._selectedMessage.set(null);
    this._isLoadingDetail.set(false);
  }

  public async refreshUnreadCount(): Promise<void> {
    const res = await this.get<MailUnreadCountResponse>('/api/mail/unread-count');
    if (res.success && res.data) {
      this._isMailboxConnected.set(Boolean(res.data.connected));
      this._unreadCount.set(res.data.connected ? Number(res.data.unreadCount || 0) : 0);
    }
  }

  public resetState(): void {
    this.messagesRequestSeq += 1;
    this.detailRequestSeq += 1;
    this._mailboxEmail.set(null);
    this._folders.set([]);
    this._selectedFolder.set('INBOX');
    this._messages.set([]);
    this._page.set(1);
    this._totalMessages.set(0);
    this._hasNextPage.set(false);
    this._selectedMessage.set(null);
    this._selectedMessageRef.set(null);
    this._unreadCount.set(0);
    this._isMailboxConnected.set(false);
    this._isLoadingFolders.set(false);
    this._isLoadingMessages.set(false);
    this._isLoadingDetail.set(false);
    this._errorCode.set(null);
    this._errorMessage.set(null);
  }

  private applyError(code: MailErrorCode | undefined, message: string | undefined): void {
    const resolvedCode = code ?? 'UNKNOWN';
    if (resolvedCode === 'MAILBOX_NOT_CONNECTED' || resolvedCode === 'MAIL_SERVER_NOT_CONFIGURED') {
      this._isMailboxConnected.set(false);
      this._unreadCount.set(0);
    }
    this._errorCode.set(resolvedCode);
    this._errorMessage.set(message || 'Impossible de charger votre messagerie.');
  }

  private resetForAccountChange(): void {
    const userId = this.authService.currentUser()?.id ?? null;
    if (this.dataUserId === userId) return;
    this.dataUserId = userId;
    this.resetState();
  }

  private extractErrorCode(payload: unknown): MailErrorCode {
    if (typeof payload === 'object' && payload !== null && 'code' in payload) {
      const rawCode = String((payload as Record<string, unknown>)['code']);
      if (KNOWN_ERROR_CODES.has(rawCode as MailErrorCode)) {
        return rawCode as MailErrorCode;
      }
    }
    return 'UNKNOWN';
  }

  private async get<T>(path: string): Promise<MailReadApiResult<T>> {
    this.resetForAccountChange();
    const requestedUserId = this.authService.currentUser()?.id ?? null;
    const token = this.authService.token();
    if (!token) {
      return { success: false, code: 'UNKNOWN', error: 'Session authentifiée introuvable.' };
    }

    try {
      const response = await fetch(path, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
      });

      const payload: unknown = await response.json().catch(() => null);
      if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) {
        return { success: false, code: 'UNKNOWN', error: 'La session a changé pendant la requête.' };
      }

      if (!response.ok) {
        return {
          success: false,
          code: this.extractErrorCode(payload),
          error: getApiErrorMessage(
            payload,
            `Impossible de contacter le service de messagerie (erreur HTTP ${response.status}).`
          ),
        };
      }

      if (typeof payload !== 'object' || payload === null) {
        return { success: false, code: 'UNKNOWN', error: 'Réponse invalide du service de messagerie.' };
      }

      return { success: true, data: payload as T };
    } catch {
      return {
        success: false,
        code: 'MAIL_UPSTREAM_UNAVAILABLE',
        error: 'Connexion au service de messagerie impossible. Vérifiez votre réseau puis réessayez.',
      };
    }
  }
}
