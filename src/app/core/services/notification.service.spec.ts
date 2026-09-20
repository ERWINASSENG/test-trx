import { TestBed } from '@angular/core/testing';
import { NotificationService } from './notification.service';
import { vi } from 'vitest';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [NotificationService],
    });
    service = TestBed.inject(NotificationService);
  });

  it('devrait être instancié avec une liste vide de notifications', () => {
    expect(service).toBeTruthy();
    service.notifications$.subscribe((notifs) => {
      expect(notifs).toEqual([]);
    });
  });

  it('devrait ajouter une notification de succès', () => {
    service.success('Action réussie', 'Bravo');
    const notifs = service.getNotifications();
    expect(notifs.length).toBe(1);
    expect(notifs[0].type).toBe('success');
    expect(notifs[0].title).toBe('Bravo');
    expect(notifs[0].message).toBe('Action réussie');
    expect(notifs[0].sticky).toBe(false);
  });

  it('devrait ajouter une notification d avertissement', () => {
    service.warning('Attention aux stocks', 'Avertissement');
    const notifs = service.getNotifications();
    expect(notifs.length).toBe(1);
    expect(notifs[0].type).toBe('warning');
  });

  it('devrait ignorer une notification identique déjà active', () => {
    const firstId = service.error('Accès refusé', 'Erreur');
    const secondId = service.error('Accès refusé', 'Erreur');

    expect(secondId).toBe(firstId);
    expect(service.getNotifications().length).toBe(1);
  });

  it('devrait créer une notification d erreur sticky par défaut', () => {
    service.error('Erreur de validation', 'Erreur critique');
    const notifs = service.getNotifications();
    expect(notifs.length).toBe(1);
    expect(notifs[0].type).toBe('error');
    expect(notifs[0].sticky).toBe(true);
  });

  it('devrait supprimer une notification par dismiss()', () => {
    const id = service.info('Message test');
    expect(service.getNotifications().length).toBe(1);

    service.dismiss(id);
    expect(service.getNotifications().length).toBe(0);
  });

  it('devrait vider toutes les notifications avec clear()', () => {
    service.info('Msg 1');
    service.success('Msg 2');
    expect(service.getNotifications().length).toBe(2);

    service.clear();
    expect(service.getNotifications().length).toBe(0);
  });

  it('devrait auto-dismiss une notification non-sticky après expiration de la durée', () => {
    vi.useFakeTimers();
    service.info('Message temporaire', 'Info', 3000);
    expect(service.getNotifications().length).toBe(1);

    vi.advanceTimersByTime(1500);
    expect(service.getNotifications().length).toBe(1);

    vi.advanceTimersByTime(1600);
    expect(service.getNotifications().length).toBe(0);
    vi.useRealTimers();
  });
});
