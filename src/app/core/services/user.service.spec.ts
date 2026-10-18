import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserService } from './user.service';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';

describe('UserService', () => {
  let service: UserService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        UserService,
        {
          provide: SupabaseService,
          useValue: {
            supabase: null,
            isConfigured: false,
            ensureInitialized: vi.fn().mockResolvedValue(true),
          },
        },
        {
          provide: AuthService,
          useValue: {
            token: () => 'mock-jwt-token',
            currentUser: () => ({ id: 'usr-1', email: 'test@transmex.com' }),
          },
        },
      ],
    });

    localStorage.clear();
    const serverUsers = [
      {
        id: 'usr-1',
        email: 'karim.meziani@transmex.com',
        firstName: 'Karim',
        lastName: 'Meziani',
        role: 'admin',
        department: 'Direction Générale',
        phone: '+213 555 12 34 56',
        isActive: true,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'usr-2',
        email: 'amina.b@transmex.com',
        firstName: 'Amina',
        lastName: 'Brahimi',
        role: 'employe',
        department: 'Ressources Humaines',
        phone: '+213 555 98 76 54',
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/system/collaborators') && (!init?.method || init.method === 'GET')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ users: serverUsers }) });
      }
      if (url.includes('/api/system/collaborators') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            user: {
              id: 'mock-auth-id-123',
              email: 'nouveau.collaborateur@transmex.com',
              firstName: 'Tarik',
              lastName: 'Haddad',
              role: 'employe',
              department: 'Ressources Humaines',
              phone: '+213 555 11 22 33',
              isActive: true,
              createdAt: new Date().toISOString(),
            },
          }),
        });
      }
      if (url.includes('/api/system/collaborators/') && init?.method === 'PATCH') {
        const userId = url.split('/').pop();
        const payload = JSON.parse(String(init.body || '{}')) as Partial<typeof serverUsers[number]>;
        const user = serverUsers.find((candidate) => candidate.id === userId);
        if (user) Object.assign(user, payload);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      }
      if (url.includes('/api/system/collaborators/') && init?.method === 'DELETE') {
        const userId = url.split('/').pop();
        const index = serverUsers.findIndex((candidate) => candidate.id === userId);
        if (index >= 0) serverUsers.splice(index, 1);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    service = TestBed.inject(UserService);
    await service.loadInitialUsers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('devrait être instancié avec une liste d\'utilisateurs par défaut', () => {
    expect(service).toBeTruthy();
    expect(service.users().length).toBe(2);
    expect(service.totalUsersCount()).toBe(2);
    expect(localStorage.getItem('transmex_users_store')).toBeNull();
  });

  it('efface les données de collaborateurs quand le serveur refuse leur lecture', async () => {
    localStorage.setItem('transmex_users_store', JSON.stringify(service.users()));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'Permission insuffisante pour cette action.' }),
    }));

    await service.loadInitialUsers();

    expect(service.users()).toEqual([]);
    expect(service.error()).toContain('Permission insuffisante');
    expect(localStorage.getItem('transmex_users_store')).toBeNull();
  });

  it('distingue une panne réseau lors du chargement des utilisateurs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await service.loadInitialUsers();

    expect(service.users()).toEqual([]);
    expect(service.error()).toBe(
      'Connexion au service de gestion des utilisateurs impossible. Vérifiez votre connexion puis réessayez.'
    );
  });

  it('devrait créer un nouvel utilisateur avec succès et lui assigner un mot de passe temporaire', async () => {
    const initialCount = service.users().length;
    const result = await service.createUser({
      email: 'nouveau.collaborateur@transmex.com',
      firstName: 'Tarik',
      lastName: 'Haddad',
      role: 'employe',
      department: 'Ressources Humaines',
      phone: '+213 555 11 22 33',
      tempPassword: 'Password123!',
    });

    expect(result.success).toBe(true);
    expect(service.users().length).toBe(initialCount + 1);
    expect(service.users()[0].email).toBe('nouveau.collaborateur@transmex.com');
  });

  it('devrait rejeter la création d\'un utilisateur avec un email déjà existant', async () => {
    const result = await service.createUser({
      email: 'karim.meziani@transmex.com',
      firstName: 'Doublon',
      lastName: 'Test',
      role: 'employe',
    });

    expect(result.success).toBe(false);
    expect(service.error()).toBeTruthy();
  });

  it('conserve le motif métier de l’API quand la création échoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ message: 'Cette adresse e-mail est déjà associée à un compte.' }),
    }));

    const result = await service.createUser({
      email: 'nouveau@transmex.com',
      firstName: 'Nouveau',
      lastName: 'Compte',
      role: 'employe',
      tempPassword: 'Password123!',
    });

    expect(result).toEqual({
      success: false,
      error: 'Cette adresse e-mail est déjà associée à un compte.',
    });
  });

  it('signale une réponse de création invalide au lieu de créer un utilisateur incomplet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ user: { id: 'new-id' } }),
    }));
    const initialCount = service.users().length;

    const result = await service.createUser({
      email: 'nouveau@transmex.com',
      firstName: 'Nouveau',
      lastName: 'Compte',
      role: 'employe',
      tempPassword: 'Password123!',
    });

    expect(result).toEqual({
      success: false,
      error: 'Réponse invalide du serveur de synchronisation.',
    });
    expect(service.users()).toHaveLength(initialCount);
  });

  it('devrait modifier les informations et le rôle d\'un utilisateur', async () => {
    const firstUser = service.users()[0];
    const updateResult = await service.updateUser(firstUser.id, {
      department: 'Direction Stratégique',
      role: 'admin',
    });

    expect(updateResult.success).toBe(true);
    const updated = service.users().find((u) => u.id === firstUser.id);
    expect(updated?.department).toBe('Direction Stratégique');
  });

  it('devrait basculer l\'état actif / inactif d\'un compte utilisateur', async () => {
    const user = service.users()[0];
    const initialStatus = user.isActive;

    await service.toggleUserStatus(user.id);
    const updated = service.users().find((u) => u.id === user.id);
    expect(updated?.isActive).toBe(!initialStatus);
  });

  it('devrait supprimer un utilisateur de la liste', async () => {
    const userToDelete = service.users()[0];
    const initialCount = service.users().length;

    const result = await service.deleteUser(userToDelete.id);
    expect(result.success).toBe(true);
    expect(service.users().length).toBe(initialCount - 1);
    expect(service.users().some((u) => u.id === userToDelete.id)).toBe(false);
  });
});
