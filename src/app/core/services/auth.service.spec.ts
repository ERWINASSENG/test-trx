import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';
import { UserProfile } from '../models/auth.model';

describe('AuthService', () => {
  let service: AuthService;
  let routerSpy: { navigate: ReturnType<typeof vi.fn>; url: string };
  let supabaseServiceMock: {
    supabase: unknown;
    isConfigured: ReturnType<typeof signal<boolean>>;
    ensureInitialized: ReturnType<typeof vi.fn>;
  };

  const configureSupabaseAuth = (
    session: unknown,
    userResult: { data: { user: unknown }; error: unknown }
  ) => {
    const auth = {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      getUser: vi.fn().mockResolvedValue(userResult),
      onAuthStateChange: vi.fn(),
      refreshSession: vi.fn().mockResolvedValue({ data: { session: null }, error: { status: 400 } }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    };
    supabaseServiceMock.supabase = { auth };
    supabaseServiceMock.isConfigured.set(true);
    supabaseServiceMock.ensureInitialized = vi.fn().mockResolvedValue(true);
    return auth;
  };

  const createCachedUser = (): UserProfile => ({
    id: 'usr-123',
    email: 'test@transmex.com',
    firstName: 'Jean',
    lastName: 'Dupont',
    role: 'employe',
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  beforeEach(() => {
    routerSpy = { navigate: vi.fn(), url: '/dossiers' };
    supabaseServiceMock = {
      supabase: null,
      isConfigured: signal(false),
      ensureInitialized: vi.fn().mockResolvedValue(false),
    };

    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: Router, useValue: routerSpy },
        { provide: SupabaseService, useValue: supabaseServiceMock },
      ],
    });

    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    service = TestBed.inject(AuthService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('devrait être créé avec un état non authentifié par défaut sans fausses données', () => {
    expect(service).toBeTruthy();
    expect(service.isAuthenticated()).toBe(false);
    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
  });

  it('ne doit JAMAIS écrire le token JWT dans le localStorage lors de la création d une session (anti-XSS)', () => {
    const mockUser: UserProfile = {
      id: 'usr-123',
      email: 'test@transmex.com',
      firstName: 'Jean',
      lastName: 'Dupont',
      role: 'employe',
      roles: ['employe'],
      department: 'Exploitation',
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    const mockToken = 'secret.jwt.token.never.in.localstorage';

    service.setLocalSession(mockUser, mockToken);

    // Vérification mémoire
    expect(service.isAuthenticated()).toBe(true);
    expect(service.currentUser()?.email).toBe('test@transmex.com');
    expect(service.token()).toBe(mockToken);

    // Vérification absence stricte dans le localStorage
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('transmex_auth_session')).toBeNull();
      expect(localStorage.getItem('sb-token')).toBeNull();
    }
  });

  it('devrait échouer proprement lors d une tentative avec des identifiants inconnus', async () => {
    const result = await service.login({
      email: 'inconnu@transmex.com',
      password: 'password123',
    });

    expect(result.success).toBe(false);
    expect(service.authError()).toBeTruthy();
  });

  it('devrait vider la session en mémoire et rediriger vers le login lors de la déconnexion', async () => {
    await service.logout();
    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
    expect(service.isAuthenticated()).toBe(false);
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/auth/login']);
  });

  it('efface le profil en cache quand Supabase ne retrouve aucune session', async () => {
    const user = createCachedUser();
    service.setLocalSession(user, 'stale-token');
    const auth = configureSupabaseAuth(null, { data: { user: null }, error: null });

    await service.restoreSession();

    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it('efface la session locale si la validation distante renvoie 401', async () => {
    const user = createCachedUser();
    service.setLocalSession(user, 'stale-token');
    const auth = configureSupabaseAuth(
      { access_token: 'stale-token' },
      { data: { user: null }, error: { status: 401 } }
    );

    await service.restoreSession();

    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('conserve la session en mémoire sur une panne réseau transitoire', async () => {
    const user = createCachedUser();
    service.setLocalSession(user, 'possibly-valid-token');
    const auth = configureSupabaseAuth(
      { access_token: 'possibly-valid-token' },
      { data: { user: null }, error: { status: 0, name: 'AuthRetryableFetchError' } }
    );

    await service.restoreSession();

    expect(service.currentUser()).toEqual(user);
    expect(service.token()).toBe('possibly-valid-token');
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('efface la session si le serveur rejette le token lors de la lecture du profil', async () => {
    const user = createCachedUser();
    service.setLocalSession(user, 'server-rejected-token');
    const auth = configureSupabaseAuth(
      { access_token: 'server-rejected-token' },
      { data: { user: { id: user.id, email: user.email } }, error: null }
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await service.restoreSession();

    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/auth/login'], {
      queryParams: { returnUrl: '/dossiers' },
    });
  });

  it('rafraîchit le token après un 401 confirmé par une API', async () => {
    const auth = configureSupabaseAuth(null, { data: { user: null }, error: null });
    service.setLocalSession(createCachedUser(), 'expired-token');
    auth.refreshSession.mockResolvedValue({
      data: { session: { access_token: 'fresh-token' } },
      error: null,
    });

    await expect(service.refreshAccessTokenAfterUnauthorized()).resolves.toEqual({
      status: 'refreshed',
      accessToken: 'fresh-token',
    });
    expect(service.token()).toBe('fresh-token');
  });

  it('distingue un refresh invalide d’une indisponibilité réseau', async () => {
    const auth = configureSupabaseAuth(null, { data: { user: null }, error: null });
    service.setLocalSession(createCachedUser(), 'expired-token');
    auth.refreshSession.mockResolvedValueOnce({
      data: { session: null },
      error: { status: 0, name: 'AuthRetryableFetchError' },
    });

    await expect(service.refreshAccessTokenAfterUnauthorized()).resolves.toEqual({ status: 'unavailable' });
    expect(service.token()).toBe('expired-token');

    auth.refreshSession.mockResolvedValueOnce({ data: { session: null }, error: { status: 400 } });
    await expect(service.refreshAccessTokenAfterUnauthorized()).resolves.toEqual({ status: 'invalid' });
  });

  it('invalide uniquement la session locale quand une API rejette le token', () => {
    const auth = configureSupabaseAuth(null, { data: { user: null }, error: null });
    service.setLocalSession(createCachedUser(), 'stale-token');

    service.handleUnauthorizedSession();

    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/auth/login'], {
      queryParams: { returnUrl: '/dossiers' },
    });
  });
});
