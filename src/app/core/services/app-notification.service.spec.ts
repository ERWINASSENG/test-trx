import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { AppNotificationService } from './app-notification.service';

const notification = (id: string) => ({
  id,
  notification_type: 'assignment',
  title: 'Dossier attribué',
  message: 'Un dossier vous a été attribué.',
  href: '/dossiers',
  source_type: 'dossier',
  source_id: id,
  read_at: null,
  created_at: '2026-10-15T10:00:00Z',
});

const response = (id: string) => new Response(JSON.stringify({
  notifications: [notification(id)],
  unreadCount: 1,
}), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

describe('AppNotificationService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('loads for a new account while an old account request is still pending', async () => {
    const currentUser = signal<{ id: string } | null>({ id: 'first-user' });
    let resolveFirstResponse!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve;
    });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(response('second-notification'));
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [
        AppNotificationService,
        { provide: PLATFORM_ID, useValue: 'server' },
        {
          provide: AuthService,
          useValue: {
            currentUser,
            token: () => 'test-token',
            refreshAccessTokenAfterUnauthorized: vi.fn(),
            handleUnauthorizedSession: vi.fn(),
          },
        },
      ],
    });
    const service = TestBed.inject(AppNotificationService);
    TestBed.flushEffects();

    const firstLoad = service.load();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentUser.set({ id: 'second-user' });
    TestBed.flushEffects();
    await expect(service.load()).resolves.toBe(true);

    resolveFirstResponse(response('first-notification'));
    await firstLoad;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.notifications().map((item) => item.id)).toEqual(['second-notification']);
    expect(service.unreadCount()).toBe(1);
    expect(service.isLoading()).toBe(false);
  });
});
