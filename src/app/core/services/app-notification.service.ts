import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, effect, inject, signal, untracked } from '@angular/core';
import { AppNotification } from '../models/app-notification.model';
import { AuthService } from './auth.service';

interface NotificationsResponse {
  notifications: Record<string, unknown>[];
  unreadCount: number;
}

const isNotificationsResponse = (value: unknown): value is NotificationsResponse => {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Record<string, unknown>;
  const notifications = response['notifications'];
  const unreadCount = response['unreadCount'];
  return Array.isArray(notifications)
    && notifications.every((row: unknown) => typeof row === 'object' && row !== null && !Array.isArray(row))
    && Number.isInteger(unreadCount)
    && Number(unreadCount) >= 0;
};

@Injectable({ providedIn: 'root' })
export class AppNotificationService {
  private static readonly FAILURE_COOLDOWN_MS = 15_000;

  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);

  private dataUserId: string | null | undefined;
  private loadGeneration = 0;
  private loadingUserId: string | null = null;
  private lastFailedAt = 0;
  private activeAbortController: AbortController | null = null;

  private readonly _notifications = signal<AppNotification[]>([]);
  private readonly _unreadCount = signal(0);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  public readonly notifications = this._notifications.asReadonly();
  public readonly unreadCount = this._unreadCount.asReadonly();
  public readonly isLoading = this._isLoading.asReadonly();
  public readonly error = this._error.asReadonly();

  constructor() {
    effect(() => {
      const userId = this.authService.currentUser()?.id ?? null;
      untracked(() => {
        this.resetForAccountChange(userId);
        if (userId && isPlatformBrowser(this.platformId)) {
          void this.load();
        }
      });
    });

    if (isPlatformBrowser(this.platformId)) {
      const interval = setInterval(() => {
        if (this.authService.currentUser()) {
          void this.load();
        }
      }, 60_000);

      this.destroyRef.onDestroy(() => {
        clearInterval(interval);
        this.activeAbortController?.abort();
      });
    }
  }

  public async load(force = false): Promise<boolean> {
    const userId = this.authService.currentUser()?.id ?? null;
    if (!userId || (this._isLoading() && this.loadingUserId === userId)) return false;

    // Protection contre les tempêtes de requêtes lors d'instabilité réseau
    if (!force && Date.now() - this.lastFailedAt < AppNotificationService.FAILURE_COOLDOWN_MS) {
      return false;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return false;
    }

    this.resetForAccountChange(userId);
    const generation = ++this.loadGeneration;
    this.loadingUserId = userId;
    this._isLoading.set(true);

    try {
      const result = await this.request<NotificationsResponse>('/api/notifications', 'GET', userId);
      if (!result || !this.isCurrentUser(userId)) return false;
      if (!isNotificationsResponse(result)) {
        throw new Error('Le serveur a renvoyé des notifications dans un format invalide.');
      }
      this._notifications.set(result.notifications.map((row) => this.mapNotification(row)));
      this._unreadCount.set(result.unreadCount);
      this._error.set(null);
      this.lastFailedAt = 0;
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false;
      }
      this.lastFailedAt = Date.now();
      if (this.isCurrentUser(userId)) {
        const message = error instanceof Error ? error.message : 'Impossible de charger les notifications.';
        this._error.set(message);
      }
      return false;
    } finally {
      if (generation === this.loadGeneration) {
        this.loadingUserId = null;
        this._isLoading.set(false);
      }
    }
  }

  public async markAsRead(notificationId: string): Promise<boolean> {
    const userId = this.authService.currentUser()?.id ?? null;
    if (!userId) return false;
    try {
      await this.request(`/api/notifications/${encodeURIComponent(notificationId)}/read`, 'POST', userId);
      return await this.load(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false;
      }
      if (this.isCurrentUser(userId)) {
        this._error.set(error instanceof Error ? error.message : 'Impossible de mettre à jour la notification.');
      }
      return false;
    }
  }

  public async markAllAsRead(): Promise<boolean> {
    const userId = this.authService.currentUser()?.id ?? null;
    if (!userId) return false;
    try {
      await this.request('/api/notifications/read-all', 'POST', userId);
      return await this.load(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return false;
      }
      if (this.isCurrentUser(userId)) {
        this._error.set(error instanceof Error ? error.message : 'Impossible de mettre à jour les notifications.');
      }
      return false;
    }
  }

  private async request<T>(
    url: string,
    method: 'GET' | 'POST',
    userId: string
  ): Promise<T> {
    const token = this.authService.token();
    if (!token) throw new Error('Session expirée. Veuillez vous reconnecter.');

    this.activeAbortController?.abort();
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    const send = (accessToken: string) => fetch(url, {
      method,
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: abortController.signal,
    });

    let response: Response;
    try {
      response = await send(token);
    } catch {
      if (abortController.signal.aborted) {
        throw new DOMException('Requête annulée.', 'AbortError');
      }
      throw new Error('Connexion réseau interrompue ou instable. Veuillez réessayer.');
    }

    if (!this.isCurrentUser(userId)) throw new Error('La session a changé pendant la requête.');

    if (response.status === 401) {
      const refresh = await this.authService.refreshAccessTokenAfterUnauthorized();
      if (refresh.status === 'refreshed') {
        try {
          response = await send(refresh.accessToken);
        } catch {
          if (abortController.signal.aborted) {
            throw new DOMException('Requête annulée.', 'AbortError');
          }
          throw new Error('Connexion réseau interrompue ou instable. Veuillez réessayer.');
        }
      } else if (refresh.status === 'unavailable') {
        throw new Error('La vérification de session est temporairement indisponible. Réessayez.');
      }
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.status === 401) this.authService.handleUnauthorizedSession();
      throw new Error(response.ok
        ? 'Le serveur a renvoyé une réponse invalide.'
        : `Erreur serveur (${response.status}).`);
    }

    if (!this.isCurrentUser(userId)) throw new Error('La session a changé pendant la requête.');

    if (!response.ok) {
      if (response.status === 401) this.authService.handleUnauthorizedSession();
      const errorMessage = typeof payload === 'object' && payload !== null
        && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Erreur serveur (${response.status}).`;
      throw new Error(errorMessage);
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new Error('Le serveur a renvoyé une réponse invalide.');
    }

    return payload as T;
  }

  private resetForAccountChange(userId: string | null): void {
    if (this.dataUserId === userId) return;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.dataUserId = userId;
    this.loadGeneration++;
    this.loadingUserId = null;
    this.lastFailedAt = 0;
    this._isLoading.set(false);
    this._notifications.set([]);
    this._unreadCount.set(0);
    this._error.set(null);
  }

  private isCurrentUser(userId: string): boolean {
    return this.dataUserId === userId && this.authService.currentUser()?.id === userId;
  }

  private mapNotification(row: Record<string, unknown>): AppNotification {
    return {
      id: String(row['id'] ?? ''),
      notificationType: row['notification_type'] === 'reminder' ? 'reminder' : 'assignment',
      title: String(row['title'] ?? ''),
      message: String(row['message'] ?? ''),
      href: typeof row['href'] === 'string' && row['href'].startsWith('/') && !row['href'].startsWith('//')
        ? row['href']
        : '/',
      sourceType: row['source_type'] === 'quote' || row['source_type'] === 'dossier'
        || row['source_type'] === 'sales_activity' ? row['source_type'] : 'prospect',
      sourceId: String(row['source_id'] ?? ''),
      readAt: typeof row['read_at'] === 'string' ? row['read_at'] : null,
      createdAt: String(row['created_at'] ?? ''),
    };
  }
}
