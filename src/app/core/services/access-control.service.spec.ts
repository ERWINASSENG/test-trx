import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, beforeEach, expect, it, vi } from 'vitest';
import { UserProfile, UserRole } from '../models/auth.model';
import { AuthService } from './auth.service';
import { AccessControlService } from './access-control.service';

describe('AccessControlService', () => {
  let service: AccessControlService;
  let currentUser: ReturnType<typeof signal<UserProfile | null>>;
  let currentRole: ReturnType<typeof signal<UserRole>>;

  beforeEach(() => {
    currentUser = signal<UserProfile | null>({
      id: 'cashier-user',
      email: 'cashier@example.test',
      firstName: 'Test',
      lastName: 'Cashier',
      role: 'caissiere',
      isActive: true,
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    currentRole = signal<UserRole>('caissiere');

    TestBed.configureTestingModule({
      providers: [
        AccessControlService,
        {
          provide: AuthService,
          useValue: {
            currentUser,
            currentRole,
            token: () => 'test-token',
            waitForSession: vi.fn().mockResolvedValue(undefined),
            isAdmin: () => currentRole() === 'admin',
          },
        },
      ],
    });
    service = TestBed.inject(AccessControlService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('autorise la caissière à mettre à jour le statut des opérations', () => {
    expect(service.hasPermission('cashier.status_update')).toBe(true);
    expect(service.hasPermission('cashier.update')).toBe(true);
    expect(service.hasPermission('dossiers.read')).toBe(true);
  });

  it('refuse le droit de mise à jour du statut au comptable par défaut', () => {
    currentRole.set('comptable');
    currentUser.update((user) => user ? { ...user, role: 'comptable' } : null);

    expect(service.hasPermission('cashier.status_update')).toBe(false);
    expect(service.hasPermission('cashier.update')).toBe(false);
  });

  it('does not grant employee fallback permissions to a dynamically assigned DAF role', () => {
    currentRole.set('employe');
    currentUser.update((user) => user ? { ...user, role: 'employe', customRole: 'daf' } : null);

    expect(service.hasPermission('hr.read')).toBe(false);
    expect(service.hasPermission('users.read')).toBe(false);
  });

  it('does not grant collaborator-list access to the legacy employee role', () => {
    currentRole.set('employe');
    currentUser.update((user) => user ? { ...user, role: 'employe', customRole: null } : null);

    expect(service.hasPermission('hr.read')).toBe(true);
    expect(service.hasPermission('users.read')).toBe(false);
  });

  it('coalesces permission reads and reuses the fresh result for the same user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        permissions: [{
          permissionKey: 'module.hr.view',
          scope: { type: 'all', version: 1 },
          effect: 'allow',
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const [first, concurrent] = await Promise.all([
      service.loadMyPermissions(),
      service.loadMyPermissions(),
    ]);

    expect(first).toBe(true);
    expect(concurrent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.hasPermission('module.hr.view')).toBe(true);

    await service.loadMyPermissions();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await service.loadMyPermissions(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the loading state active until every concurrent request completes', async () => {
    let resolveRoles!: (response: Response) => void;
    let resolvePermissions!: (response: Response) => void;
    const rolesResponse = new Promise<Response>((resolve) => {
      resolveRoles = resolve;
    });
    const permissionsResponse = new Promise<Response>((resolve) => {
      resolvePermissions = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/roles') ? rolesResponse : permissionsResponse
    );
    vi.stubGlobal('fetch', fetchMock);

    const rolesLoad = service.loadRoles();
    const permissionsLoad = service.loadPermissions();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(service.isLoading()).toBe(true);

    resolvePermissions(new Response(JSON.stringify({ permissions: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await permissionsLoad;
    expect(service.isLoading()).toBe(true);

    resolveRoles(new Response(JSON.stringify({ roles: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await rolesLoad;
    expect(service.isLoading()).toBe(false);
  });

  it('caches successful access-control reads briefly and supports explicit refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ roles: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await service.loadRoles();
    await service.loadRoles();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await service.loadRoles(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});