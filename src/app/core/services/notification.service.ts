import { Injectable, computed, signal } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export type NotificationType = 'success' | 'warning' | 'error' | 'info';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  duration?: number; // en ms, 0 ou undefined pour sticky
  sticky?: boolean;
  timestamp: Date;
}

@Injectable({
  providedIn: 'root',
})
export class NotificationService {
  private readonly _notifications = signal<AppNotification[]>([]);
  public readonly notifications = computed(() => this._notifications());

  private readonly notificationsSubject = new BehaviorSubject<AppNotification[]>([]);
  public readonly notifications$: Observable<AppNotification[]> = this.notificationsSubject.asObservable();

  private defaultDuration = 5000;

  /**
   * Retourne la liste actuelle des notifications actives
   */
  public getNotifications(): AppNotification[] {
    return this._notifications();
  }

  /**
   * Affiche une notification générique
   */
  public show(notification: Omit<AppNotification, 'id' | 'timestamp'>): string {
    const existing = this._notifications().find(
      (active) =>
        active.type === notification.type &&
        active.title === notification.title &&
        active.message === notification.message,
    );
    if (existing) {
      return existing.id;
    }

    const id = `notif-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const newNotif: AppNotification = {
      ...notification,
      id,
      timestamp: new Date(),
    };

    const updated = [...this._notifications(), newNotif];
    this._notifications.set(updated);
    this.notificationsSubject.next(updated);

    const isSticky = newNotif.sticky || newNotif.duration === 0;
    const duration = newNotif.duration ?? (isSticky ? 0 : this.defaultDuration);

    if (!isSticky && duration > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }

    return id;
  }

  /**
   * Notification de Succès
   */
  public success(message: string, title = 'Succès', duration?: number): string {
    return this.show({
      type: 'success',
      title,
      message,
      duration,
      sticky: false,
    });
  }

  /**
   * Notification d'Avertissement
   */
  public warning(message: string, title = 'Avertissement', duration?: number): string {
    return this.show({
      type: 'warning',
      title,
      message,
      duration,
      sticky: false,
    });
  }

  /**
   * Notification d'Erreur (sticky par défaut pour garantir la lecture par l'utilisateur)
   */
  public error(message: string, title = 'Erreur', sticky = true, duration?: number): string {
    return this.show({
      type: 'error',
      title,
      message,
      duration: sticky ? 0 : duration,
      sticky,
    });
  }

  /**
   * Notification d'Information
   */
  public info(message: string, title = 'Information', duration?: number): string {
    return this.show({
      type: 'info',
      title,
      message,
      duration,
      sticky: false,
    });
  }

  /**
   * Ferme une notification par son identifiant
   */
  public dismiss(id: string): void {
    const updated = this._notifications().filter((notif) => notif.id !== id);
    this._notifications.set(updated);
    this.notificationsSubject.next(updated);
  }

  /**
   * Supprime toutes les notifications actives
   */
  public clear(): void {
    this._notifications.set([]);
    this.notificationsSubject.next([]);
  }
}
