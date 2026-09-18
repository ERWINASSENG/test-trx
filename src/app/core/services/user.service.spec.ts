import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UserService } from './user.service';
import { SupabaseService } from './supabase.service';

describe('UserService', () => {
  let service: UserService;

  beforeEach(() => {
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
      ],
    });

    localStorage.clear();
    const mockUsers = [
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
    localStorage.setItem('transmex_users_store', JSON.stringify(mockUsers));
    service = TestBed.inject(UserService);

    // Mock global fetch for backend /api/system/collaborators
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/system/collaborators')) {
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
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('devrait être instancié avec une liste d\'utilisateurs par défaut', () => {
    expect(service).toBeTruthy();
    expect(service.users().length).toBe(2);
    expect(service.totalUsersCount()).toBe(2);
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
