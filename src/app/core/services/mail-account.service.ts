import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  AdminMailSettingsResponse,
  MailGlobalSettings,
  MailInboxAccountDto,
  MailSyncSummaryDto,
  MyMailAccountResponse,
} from '../models/mail-account.model';
import { getApiErrorMessage } from '../utils/api-error.util';
import { AuthService } from './auth.service';

export interface MailApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class MailAccountService {
  private readonly authService = inject(AuthService);
  private dataUserId: string | null | undefined;

  private readonly _myAccount = signal<MailInboxAccountDto | null>(null);
  private readonly _configuredOnServer = signal<boolean>(false);
  private readonly _isLoadingMyAccount = signal<boolean>(false);

  private readonly _adminSettings = signal<MailGlobalSettings | null>(null);
  private readonly _encryptionReady = signal<boolean>(false);
  private readonly _teamMailboxes = signal<MailInboxAccountDto[]>([]);
  private readonly _isLoadingAdmin = signal<boolean>(false);

  public readonly myAccount = computed(() => this._myAccount());
  public readonly configuredOnServer = computed(() => this._configuredOnServer());
  public readonly isLoadingMyAccount = computed(() => this._isLoadingMyAccount());

  public readonly adminSettings = computed(() => this._adminSettings());
  public readonly encryptionReady = computed(() => this._encryptionReady());
  public readonly teamMailboxes = computed(() => this._teamMailboxes());
  public readonly isLoadingAdmin = computed(() => this._isLoadingAdmin());

  constructor() {
    effect(() => {
      this.authService.currentUser();
      this.resetForAccountChange();
    });
  }

  public async loadMyMailAccount(): Promise<MailApiResult<MyMailAccountResponse>> {
    this._isLoadingMyAccount.set(true);
    try {
      const res = await this.request<MyMailAccountResponse>('/api/profile/mail-account', 'GET');
      if (res.success && res.data) {
        this._configuredOnServer.set(Boolean(res.data.configuredOnServer));
        this._myAccount.set(res.data.account ?? null);
      }
      return res;
    } finally {
      this._isLoadingMyAccount.set(false);
    }
  }

  public async connectMyMailAccount(
    email: string,
    password: string
  ): Promise<MailApiResult<MailInboxAccountDto>> {
    const res = await this.request<{ account: MailInboxAccountDto }>(
      '/api/profile/mail-account',
      'PUT',
      { email, password }
    );
    if (res.success && res.data?.account) {
      this._myAccount.set(res.data.account);
      this._configuredOnServer.set(true);
      return { success: true, data: res.data.account };
    }
    return { success: false, error: res.error };
  }

  public async syncMyMailAccount(): Promise<MailApiResult<MailSyncSummaryDto>> {
    const res = await this.request<{ summary: MailSyncSummaryDto }>(
      '/api/profile/mail-account/sync',
      'POST',
      {}
    );
    if (res.success && res.data?.summary) {
      const syncedAt = res.data.summary.lastSyncedAt;
      this._myAccount.update((cur) =>
        cur ? { ...cur, lastSyncedAt: syncedAt, lastError: null } : null
      );
      return { success: true, data: res.data.summary };
    }
    return { success: false, error: res.error };
  }

  public async disconnectMyMailAccount(): Promise<MailApiResult<{ disconnected: boolean }>> {
    const res = await this.request<{ disconnected: boolean }>(
      '/api/profile/mail-account',
      'DELETE'
    );
    if (res.success) {
      this._myAccount.set(null);
    }
    return res;
  }

  public async loadTeamMailboxesStatus(): Promise<MailApiResult<MailInboxAccountDto[]>> {
    const res = await this.request<{ mailboxes: MailInboxAccountDto[] }>(
      '/api/quotes/mailboxes-status',
      'GET'
    );
    if (res.success && Array.isArray(res.data?.mailboxes)) {
      this._teamMailboxes.set(res.data.mailboxes);
      return { success: true, data: res.data.mailboxes };
    }
    return { success: false, error: res.error };
  }

  public async loadAdminMailSettings(): Promise<MailApiResult<AdminMailSettingsResponse>> {
    this._isLoadingAdmin.set(true);
    try {
      const res = await this.request<AdminMailSettingsResponse>(
        '/api/configuration/mail-settings',
        'GET'
      );
      if (res.success && res.data) {
        this._encryptionReady.set(Boolean(res.data.encryptionReady));
        this._adminSettings.set(res.data.settings ?? null);
        this._teamMailboxes.set(Array.isArray(res.data.mailboxes) ? res.data.mailboxes : []);
      }
      return res;
    } finally {
      this._isLoadingAdmin.set(false);
    }
  }

  public async saveAdminMailSettings(
    settings: MailGlobalSettings
  ): Promise<MailApiResult<MailGlobalSettings>> {
    const payload = {
      imapHost: settings.imapHost,
      imapPort: settings.imapPort,
      imapTls: settings.imapTls,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpTls: settings.smtpTls,
      watchedFolder: settings.watchedFolder,
      subjectKeywords: settings.subjectKeywords,
      excludedSenders: settings.excludedSenders,
      isEnabled: settings.isEnabled,
    };
    const res = await this.request<{ saved: boolean; settings: MailGlobalSettings }>(
      '/api/configuration/mail-settings',
      'PUT',
      payload
    );
    if (res.success && res.data?.settings) {
      this._adminSettings.set(res.data.settings);
      return { success: true, data: res.data.settings };
    }
    return { success: false, error: res.error };
  }

  private resetForAccountChange(): void {
    const userId = this.authService.currentUser()?.id ?? null;
    if (this.dataUserId === userId) return;

    this.dataUserId = userId;
    this._myAccount.set(null);
    this._configuredOnServer.set(false);
    this._adminSettings.set(null);
    this._encryptionReady.set(false);
    this._teamMailboxes.set([]);
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown
  ): Promise<MailApiResult<T>> {
    this.resetForAccountChange();
    const requestedUserId = this.authService.currentUser()?.id ?? null;
    const token = this.authService.token();
    if (!token) {
      return { success: false, error: 'Session authentifiée introuvable.' };
    }

    try {
      const response = await fetch(path, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const payload: unknown = await response.json().catch(() => null);
      if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) {
        return { success: false, error: 'La session a changé pendant la requête.' };
      }

      if (!response.ok) {
        return {
          success: false,
          error: getApiErrorMessage(
            payload,
            `Impossible de contacter le service mail (erreur HTTP ${response.status}).`
          ),
        };
      }

      if (typeof payload !== 'object' || payload === null) {
        return { success: false, error: 'Réponse invalide du service mail.' };
      }

      return { success: true, data: payload as T };
    } catch {
      return {
        success: false,
        error: 'Connexion au service mail impossible. Vérifiez votre réseau puis réessayez.',
      };
    }
  }
}
