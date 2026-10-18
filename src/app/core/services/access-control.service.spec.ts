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
      id: 'manager-user',
      email: 'manager@example.test',
      firstName: 'Test',
      lastName: 'Manager',
      role: 'manager',
      isActive: true,
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    currentRole = signal<UserRole>('manager');

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

  it('interdit la création et modification de caisse à un manager ne disposant que de cashier.read', async () => {
    // L'administrateur n'a attribué que la lecture seule sur la caisse
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        permissions: [
          {
            permissionKey: 'cashier.read',
            scope: { type: 'all', version: 1 },
            effect: 'allow',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await service.loadMyPermissions();

    // Lecture accordée
    expect(service.hasPermission('cashier.read')).toBe(true);

    // Création, modification et suppression strictement interdites (aucun repli permissif)
    expect(service.hasPermission('cashier.create')).toBe(false);
    expect(service.hasPermission('cashier.write')).toBe(false);
    expect(service.hasPermission('cashier.update')).toBe(false);
    expect(service.hasPermission('cashier.delete')).toBe(false);
    expect(service.hasPermission('cashier.status_update')).toBe(false);
  });

  it('autorise les actions de caisse uniquement lorsque l’administrateur les a accordées', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        permissions: [
          {
            permissionKey: 'cashier.read',
            scope: { type: 'all', version: 1 },
            effect: 'allow',
          },
          {
            permissionKey: 'cashier.create',
            scope: { type: 'all', version: 1 },
            effect: 'allow',
          },
          {
            permissionKey: 'cashier.status_update',
            scope: { type: 'all', version: 1 },
            effect: 'allow',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await service.loadMyPermissions();

    expect(service.hasPermission('cashier.read')).toBe(true);
    expect(service.hasPermission('cashier.create')).toBe(true);
    expect(service.hasPermission('cashier.status_update')).toBe(true);
    expect(service.hasPermission('cashier.delete')).toBe(false);
  });

  it('accorde un contournement universel complet au rôle administrateur', () => {
    currentRole.set('admin');
    currentUser.update((user) => user ? { ...user, role: 'admin' } : null);

    expect(service.hasPermission('cashier.create')).toBe(true);
    expect(service.hasPermission('cashier.delete')).toBe(true);
    expect(service.hasPermission('any.custom.action')).toBe(true);
  });

  it('refuse le droit de mise à jour du statut aux rôles sans cette attribution', () => {
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

  it('does not grant collaborator-list access or unassigned module permissions without explicit assignments', () => {
    currentRole.set('employe');
    currentUser.update((user) => user ? { ...user, role: 'employe', customRole: null } : null);

    // Universal permissions are allowed
    expect(service.hasPermission('apps.view')).toBe(true);
    expect(service.hasPermission('profile.read')).toBe(true);
    // Unassigned modules and data permissions are strictly denied
    expect(service.hasPermission('module.hr.view')).toBe(false);
    expect(service.hasPermission('module.dashboard.view')).toBe(false);
    expect(service.hasPermission('hr.read')).toBe(false);
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

  it('preserves the API business reason for a rejected role request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'Ce rôle est encore attribué à un utilisateur.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    )));

    const result = await service.deleteRole('role-1');

    expect(result).toEqual({
      success: false,
      error: 'Ce rôle est encore attribué à un utilisateur.',
    });
  });

  it('reports a network failure separately from an API rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    expect(await service.loadRoles()).toBe(false);
    expect(service.error()).toBe(
      'Connexion au service d’autorisations impossible. Vérifiez votre connexion puis réessayez.'
    );
  });

  it('reports an invalid successful response instead of treating it as empty data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    expect(await service.loadRoles()).toBe(false);
    expect(service.error()).toBe('Le serveur d’autorisations a renvoyé une réponse invalide.');
    expect(service.roles()).toEqual([]);
  });

  it('accorde l’accès à un rôle dynamique ayant une permission avec scope owner ou self', async () => {
    currentUser.set({
      id: 'dynamic-user',
      email: 'daf@example.test',
      firstName: 'Directeur',
      lastName: 'Financier',
      role: 'employe',
      customRole: 'daf',
      isActive: true,
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    currentRole.set('employe');

    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        permissions: [{
          permissionKey: 'journal_entries.create',
          scope: { type: 'owner', version: 1 },
          effect: 'allow',
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await service.loadMyPermissions();
    expect(service.hasPermission('journal_entries.create')).toBe(true);
  });

  it('déduit la visibilité du module pour un rôle dynamique ayant au moins une permission métier', async () => {
    currentUser.set({
      id: 'sales-user',
      email: 'sales@example.test',
      firstName: 'Sales',
      lastName: 'Rep',
      role: 'employe',
      customRole: 'commercial',
      isActive: true,
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    currentRole.set('employe');

    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        permissions: [{
          permissionKey: 'dossiers.read',
          scope: { type: 'all', version: 1 },
          effect: 'allow',
        }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    await service.loadMyPermissions();
    expect(service.hasPermission('module.dossiers.view')).toBe(true);
    expect(service.hasPermission('module.hr.view')).toBe(false);
  });

  it('strictly denies unassigned modules to a manager without explicit permissions', () => {
    currentUser.set({
      id: 'manager-user',
      email: 'manager@example.test',
      firstName: 'Manager',
      lastName: 'Test',
      role: 'manager',
      customRole: 'manager',
      isActive: true,
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    currentRole.set('manager');

    expect(service.hasPermission('module.dossiers.view')).toBe(false);
    expect(service.hasPermission('module.dashboard.view')).toBe(false);
    expect(service.hasPermission('module.accounting.view')).toBe(false);
    expect(service.hasPermission('apps.view')).toBe(true);
  });
});