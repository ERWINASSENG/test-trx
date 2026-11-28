import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  CreateQuoteFromMailResponseDto,
  ForwardAssignMailRequestDto,
  ForwardAssignMailResponseDto,
  MailAssignmentFilterDto,
  MailAssignmentListResponseDto,
  MailDetailDto,
  MailErrorCode,
  MailFolderDto,
  MailFoldersResponse,
  MailMessageDetailResponse,
  MailMessagesPageResponse,
  MailMoveTarget,
  MailSummaryDto,
  MailUnreadCountResponse,
  SendMailRequestDto,
  SendMailResponseDto,
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
  'MAIL_SMTP_NOT_CONFIGURED',
  'MAILBOX_AUTH_FAILED',
  'MAIL_FOLDER_NOT_FOUND',
  'MAIL_MESSAGE_NOT_FOUND',
  'MAIL_UPSTREAM_UNAVAILABLE',
  'MAIL_INVALID_PAYLOAD',
  'MAIL_RECIPIENT_REJECTED',
  'MAIL_SMTP_SEND_FAILED',
  'MAIL_ATTACHMENT_TOO_LARGE',
  'MAIL_ATTACHMENT_NOT_FOUND',
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
  private readonly _searchQuery = signal<string>('');
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
  private readonly _isSending = signal<boolean>(false);
  private readonly _isMutating = signal<boolean>(false);

  private readonly _errorCode = signal<MailErrorCode | null>(null);
  private readonly _errorMessage = signal<string | null>(null);
  private readonly _assignments = signal<MailAssignmentListResponseDto | null>(null);
  private readonly _isLoadingAssignments = signal<boolean>(false);
  private readonly _assignmentsError = signal<string | null>(null);

  public readonly mailboxEmail = computed(() => this._mailboxEmail());
  public readonly folders = computed(() => this._folders());
  public readonly selectedFolder = computed(() => this._selectedFolder());
  public readonly searchQuery = computed(() => this._searchQuery());
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
  public readonly isSending = computed(() => this._isSending());
  public readonly isMutating = computed(() => this._isMutating());

  public readonly errorCode = computed(() => this._errorCode());
  public readonly errorMessage = computed(() => this._errorMessage());
  public readonly assignments = computed(() => this._assignments());
  public readonly isLoadingAssignments = computed(() => this._isLoadingAssignments());
  public readonly assignmentsError = computed(() => this._assignmentsError());

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
    limit = this._limit(),
    query = this._searchQuery()
  ): Promise<MailReadApiResult<MailMessagesPageResponse>> {
    const seq = ++this.messagesRequestSeq;
    const trimmedQuery = query.trim();
    this._selectedFolder.set(folder);
    this._searchQuery.set(trimmedQuery);
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
      if (trimmedQuery) {
        params.set('q', trimmedQuery);
      }
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

  public async sendMessage(
    payload: SendMailRequestDto
  ): Promise<MailReadApiResult<SendMailResponseDto>> {
    this._isSending.set(true);
    try {
      const safeBody: SendMailRequestDto = {
        to: payload.to,
        cc: payload.cc ?? [],
        bcc: payload.bcc ?? [],
        subject: payload.subject,
        textBody: payload.textBody,
        inReplyTo: payload.inReplyTo ?? null,
        references: payload.references ?? [],
      };
      return await this.request<SendMailResponseDto>('/api/mail/send', 'POST', safeBody);
    } finally {
      this._isSending.set(false);
    }
  }

  public async updateFlags(
    ref: string,
    flags: { isRead?: boolean; isFlagged?: boolean }
  ): Promise<MailReadApiResult<{ updated: boolean; isRead?: boolean; isFlagged?: boolean }>> {
    this._isMutating.set(true);
    try {
      const encodedRef = encodeURIComponent(ref);
      const res = await this.request<{ updated: boolean; isRead?: boolean; isFlagged?: boolean }>(
        `/api/mail/messages/${encodedRef}/flags`,
        'PATCH',
        flags
      );

      if (res.success && res.data?.updated) {
        const previousSummary = this._messages().find((m) => m.ref === ref) ?? null;
        this._messages.update((items) =>
          items.map((item) =>
            item.ref === ref
              ? {
                  ...item,
                  ...(flags.isRead !== undefined ? { isRead: flags.isRead } : {}),
                  ...(flags.isFlagged !== undefined ? { isFlagged: flags.isFlagged } : {}),
                }
              : item
          )
        );
        this._selectedMessage.update((cur) =>
          cur && cur.ref === ref
            ? {
                ...cur,
                ...(flags.isRead !== undefined ? { isRead: flags.isRead } : {}),
                ...(flags.isFlagged !== undefined ? { isFlagged: flags.isFlagged } : {}),
              }
            : cur
        );

        if (
          flags.isRead !== undefined &&
          previousSummary &&
          previousSummary.isRead !== flags.isRead
        ) {
          const delta = flags.isRead ? -1 : 1;
          this.adjustFolderUnreadCount(previousSummary.folder, delta);
        }
      }
      return res;
    } finally {
      this._isMutating.set(false);
    }
  }

  public async moveMessage(
    ref: string,
    target: MailMoveTarget
  ): Promise<MailReadApiResult<{ moved: boolean; target: MailMoveTarget; destinationFolder: string }>> {
    this._isMutating.set(true);
    try {
      const encodedRef = encodeURIComponent(ref);
      const res = await this.request<{
        moved: boolean;
        target: MailMoveTarget;
        destinationFolder: string;
      }>(`/api/mail/messages/${encodedRef}/move`, 'POST', { target });

      if (res.success && res.data?.moved) {
        this.removeMessageFromLocalState(ref);
      }
      return res;
    } finally {
      this._isMutating.set(false);
    }
  }

  public async deleteMessage(ref: string): Promise<MailReadApiResult<{ deleted: boolean }>> {
    this._isMutating.set(true);
    try {
      const encodedRef = encodeURIComponent(ref);
      const res = await this.request<{ deleted: boolean }>(
        `/api/mail/messages/${encodedRef}`,
        'DELETE'
      );

      if (res.success && res.data?.deleted) {
        this.removeMessageFromLocalState(ref);
      }
      return res;
    } finally {
      this._isMutating.set(false);
    }
  }

  public async downloadAttachment(
    ref: string,
    attachmentId: string,
    fallbackFilename: string
  ): Promise<MailReadApiResult<{ downloaded: boolean }>> {
    this.resetForAccountChange();
    const token = this.authService.token();
    if (!token) {
      return { success: false, code: 'UNKNOWN', error: 'Session authentifiée introuvable.' };
    }

    try {
      const url = `/api/mail/messages/${encodeURIComponent(ref)}/attachments/${encodeURIComponent(attachmentId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
      });

      if (!response.ok) {
        const errPayload: unknown = await response.json().catch(() => null);
        return {
          success: false,
          code: this.extractErrorCode(errPayload),
          error: getApiErrorMessage(
            errPayload,
            `Impossible de télécharger la pièce jointe (HTTP ${response.status}).`
          ),
        };
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = fallbackFilename || 'piece-jointe';
        link.rel = 'noopener noreferrer';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }

      return { success: true, data: { downloaded: true } };
    } catch {
      return {
        success: false,
        code: 'MAIL_UPSTREAM_UNAVAILABLE',
        error: 'Téléchargement impossible. Vérifiez votre connexion puis réessayez.',
      };
    }
  }

  public async createQuoteFromMessage(
    ref: string
  ): Promise<MailReadApiResult<CreateQuoteFromMailResponseDto>> {
    this._isMutating.set(true);
    try {
      const encodedRef = encodeURIComponent(ref);
      const res = await this.request<CreateQuoteFromMailResponseDto>(
        `/api/mail/messages/${encodedRef}/create-quote`,
        'POST',
        {}
      );

      if (res.success && res.data?.quoteId) {
        const quoteId = res.data.quoteId;
        this._selectedMessage.update((cur) =>
          cur && cur.ref === ref ? { ...cur, linkedQuoteId: quoteId } : cur
        );
      }

      return res;
    } finally {
      this._isMutating.set(false);
    }
  }

  public async forwardAssignMessage(
    ref: string,
    payload: ForwardAssignMailRequestDto
  ): Promise<MailReadApiResult<ForwardAssignMailResponseDto>> {
    this._isSending.set(true);
    try {
      const encodedRef = encodeURIComponent(ref);
      return await this.request<ForwardAssignMailResponseDto>(
        `/api/mail/messages/${encodedRef}/forward-assign`,
        'POST',
        payload
      );
    } finally {
      this._isSending.set(false);
    }
  }

  public async listMailAssignments(
    filter: MailAssignmentFilterDto = {}
  ): Promise<MailReadApiResult<MailAssignmentListResponseDto>> {
    this._isLoadingAssignments.set(true);
    this._assignmentsError.set(null);
    try {
      const params = new URLSearchParams();
      if (filter.period) params.set('period', filter.period);
      if (filter.date) params.set('date', filter.date);
      if (filter.repId && filter.repId !== 'all') params.set('repId', filter.repId);
      if (filter.status && filter.status !== 'all') params.set('status', filter.status);
      const qs = params.toString();
      const path = qs ? `/api/mail/assignments?${qs}` : '/api/mail/assignments';

      const res = await this.get<MailAssignmentListResponseDto>(path);
      if (res.success && res.data) {
        this._assignments.set(res.data);
      } else {
        this._assignmentsError.set(res.error || 'Impossible de charger les mails transférés.');
      }
      return res;
    } finally {
      this._isLoadingAssignments.set(false);
    }
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
    this._searchQuery.set('');
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
    this._isSending.set(false);
    this._isMutating.set(false);
    this._errorCode.set(null);
    this._errorMessage.set(null);
    this._assignments.set(null);
    this._isLoadingAssignments.set(false);
    this._assignmentsError.set(null);
  }

  private removeMessageFromLocalState(ref: string): void {
    const existing = this._messages().find((m) => m.ref === ref) ?? null;
    this._messages.update((items) => items.filter((item) => item.ref !== ref));
    this._totalMessages.update((count) => Math.max(0, count - 1));
    if (this._selectedMessageRef() === ref) {
      this.clearSelectedMessage();
    }
    if (existing && !existing.isRead) {
      this.adjustFolderUnreadCount(existing.folder, -1);
    }
  }

  private adjustFolderUnreadCount(folderPath: string, delta: number): void {
    this._folders.update((folders) =>
      folders.map((folder) => {
        if (folder.path !== folderPath) return folder;
        const nextUnread = Math.max(0, folder.unreadMessages + delta);
        if (folder.specialUse === 'inbox') {
          this._unreadCount.set(nextUnread);
        }
        return { ...folder, unreadMessages: nextUnread };
      })
    );
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
    return this.request<T>(path, 'GET');
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown
  ): Promise<MailReadApiResult<T>> {
    this.resetForAccountChange();
    const requestedUserId = this.authService.currentUser()?.id ?? null;
    const token = this.authService.token();
    if (!token) {
      return { success: false, code: 'UNKNOWN', error: 'Session authentifiée introuvable.' };
    }

    try {
      const response = await fetch(path, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
