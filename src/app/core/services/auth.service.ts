import { Injectable, computed, inject, signal, PLATFORM_ID, REQUEST } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { LoginCredentials, UserProfile, UserRole } from '../models/auth.model';
import { SupabaseService } from './supabase.service';
import { normalizeUserRole } from '../utils/role.utils';

const CACHED_PROFILE_KEY = 'transmex_user_profile';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private readonly serverRequest = inject(REQUEST, { optional: true });

  private sessionRestoredResolver!: () => void;
  public readonly sessionRestoredPromise: Promise<void>;

  // Signaux réactifs d'état d'authentification
  private readonly _currentUser = signal<UserProfile | null>(null);
  private readonly _token = signal<string | null>(null);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _authError = signal<string | null>(null);
  private readonly _isAuthReady = signal<boolean>(false);
  private authListenerRegistered = false;
  private profileLoadError: string | null = null;
  private readonly profileLoadRequests = new Map<
    string,
    { token: string; promise: Promise<UserProfile | null> }
  >();

  // Exposition en lecture seule des Signaux réactifs
  public readonly currentUser = this._currentUser.asReadonly();
  public readonly token = this._token.asReadonly();
  public readonly isLoading = this._isLoading.asReadonly();
  public readonly authError = this._authError.asReadonly();
  public readonly isAuthReady = this._isAuthReady.asReadonly();

  // Signaux dérivés réactifs
  public readonly isAuthenticated = computed(() => this._currentUser() !== null);
  public readonly currentRole = computed<UserRole | null>(() => this._currentUser()?.role ?? null);
  public readonly isAdmin = computed(() => this._currentUser()?.role === 'admin');
  public readonly isManager = computed(() => this._currentUser()?.role === 'manager' || this._currentUser()?.role === 'tresorier' || this._currentUser()?.role === 'admin');
  public readonly isTresorier = computed(() => this._currentUser()?.role === 'tresorier' || this._currentUser()?.role === 'admin');
  public readonly isComptable = computed(() => this._currentUser()?.role === 'comptable' || this._currentUser()?.role === 'admin');
  public readonly isCaissiere = computed(() => this._currentUser()?.role === 'caissiere' || this._currentUser()?.role === 'admin');
  public readonly isEmploye = computed(() => this._currentUser()?.role === 'employe' || this._currentUser()?.role === 'admin');

  constructor() {
    this.sessionRestoredPromise = new Promise<void>((resolve) => {
      this.sessionRestoredResolver = resolve;
    });

    this.restoreCachedProfile();
    this.restoreSession();
    this.listenToAuthChanges();
  }

  private checkSupabaseConfigured(): boolean {
    const configured = this.supabaseService.isConfigured;
    if (typeof configured === 'function') {
      return configured();
    }
    return Boolean(configured);
  }

  private getAuthErrorMessage(error: unknown, fallback: string, networkMessage: string): string {
    if (error instanceof TypeError) return networkMessage;
    if (typeof error !== 'object' || error === null) return fallback;

    const details = error as Record<string, unknown>;
    if (details['name'] === 'AuthRetryableFetchError' || details['status'] === 0) {
      return networkMessage;
    }

    for (const key of ['error', 'message'] as const) {
      const message = details[key];
      if (typeof message === 'string' && message.trim()) return message.trim();
    }

    return fallback;
  }

  /**
   * Attend la résolution initiale du chargement/restauration de la session.
   * Requis par l'AuthGuard pour éviter les clignotements de redirection.
   */
  public async waitForSession(): Promise<void> {
    if (this.sessionRestoredPromise) {
      await this.sessionRestoredPromise;
    }
  }

  /**
   * Alias de prévenance pour rétrocompatibilité
   */
  public async ensureSessionRestored(): Promise<void> {
    return this.waitForSession();
  }

  /**
   * Restaure le profil et le jeton depuis le stockage sécurisé du navigateur pour un affichage instantané.
   */
  private restoreCachedProfile(): void {
    if (this.isBrowser && typeof window !== 'undefined') {
      try {
        const cached = window.localStorage ? localStorage.getItem(CACHED_PROFILE_KEY) : null;
        if (cached) {
          const profile = JSON.parse(cached) as UserProfile;
          if (profile && profile.id && profile.isActive) {
            this._currentUser.set(profile);
          }
        }
        const cachedToken = window.sessionStorage ? sessionStorage.getItem('transmex_session_token') : null;
        if (cachedToken) {
          this._token.set(cachedToken);
        }
      } catch {
        // Ignorer les exceptions de stockage
      }
    }
  }

  private saveSessionToken(token: string): void {
    if (this.isBrowser && typeof window !== 'undefined' && window.sessionStorage) {
      try {
        if (token) {
          sessionStorage.setItem('transmex_session_token', token);
        } else {
          sessionStorage.removeItem('transmex_session_token');
        }
      } catch {
        // Ignorer
      }
    }
  }

  private clearSessionToken(): void {
    if (this.isBrowser && typeof window !== 'undefined' && window.sessionStorage) {
      try {
        sessionStorage.removeItem('transmex_session_token');
      } catch {
        // Ignorer
      }
    }
  }

  private saveCachedProfile(profile: UserProfile): void {
    if (this.isBrowser && typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.setItem(CACHED_PROFILE_KEY, JSON.stringify(profile));
      } catch {
        // Ignorer
      }
    }
  }

  private clearCachedProfile(): void {
    if (this.isBrowser && typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.removeItem(CACHED_PROFILE_KEY);
      } catch {
        // Ignorer
      }
    }
  }

  /**
   * Écoute les événements Supabase (onAuthStateChange) pour synchroniser le Signal _currentUser et rafraîchir le jeton.
   */
  private listenToAuthChanges(): void {
    if (this.authListenerRegistered) return;
    if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
      try {
        this.authListenerRegistered = true;
        this.supabaseService.supabase.auth.onAuthStateChange(async (event, session) => {
          if (session?.access_token) {
            this._token.set(session.access_token);
            this.saveSessionToken(session.access_token);
          }

          if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session?.user) {
            const profile = await this.loadUserProfileFromSupabase(
              session.user.id,
              session.user.email || '',
              session.access_token,
              session.user
            );
            if (profile && !profile.isActive) {
              this.clearInvalidLocalSession();
            }
          } else if (event === 'SIGNED_OUT') {
            this.clearLocalSession();
          }
        });
      } catch (err) {
        this.authListenerRegistered = false;
        console.warn('Erreur lors de l’écoute des changements d’authentification:', err);
      }
    }
  }

  /**
   * Restaure la session au démarrage depuis Supabase SDK.
   */
  public async restoreSession(): Promise<void> {
    try {
      if (typeof this.supabaseService.ensureInitialized === 'function') {
        await this.supabaseService.ensureInitialized();
      }
      this.listenToAuthChanges();

      if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        // 1. Restauration immédiate depuis la session locale Supabase
        const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
        const session = sessionData?.session;

        if (!session?.access_token) {
          this.clearLocalSession();
          return;
        }

        this._token.set(session.access_token);
        this.saveSessionToken(session.access_token);

        // 2. Validation / rafraîchissement avec le serveur Supabase Auth
        const auth = this.supabaseService.supabase.auth;
        let accessToken = session.access_token;
        let { data: userData, error: userError } = await auth.getUser(accessToken);

        if (userError?.status === 401) {
          const refresh = await this.refreshAccessTokenAfterUnauthorized();
          if (refresh.status === 'unavailable') return;
          if (refresh.status === 'invalid') {
            this.clearInvalidLocalSession();
            return;
          }

          accessToken = refresh.accessToken;
          const refreshedUser = await auth.getUser(accessToken);
          userData = refreshedUser.data;
          userError = refreshedUser.error;
        }

        if (userData?.user && !userError) {
          const profile = await this.loadUserProfileFromSupabase(
            userData.user.id,
            userData.user.email || '',
            accessToken,
            userData.user
          );
          if (profile && !profile.isActive) {
            this.clearLocalSession();
          }
        } else if (userError?.status === 401 || (!userError && !userData?.user)) {
          this.clearInvalidLocalSession();
        }
      }
    } catch (err) {
      console.warn('Erreur lors de la restauration de session Supabase:', err);
    } finally {
      this._isAuthReady.set(true);
      this.sessionRestoredResolver?.();
    }
  }

  /**
   * Charge le profil complet de l'utilisateur depuis Supabase public.profiles.
   * Sécurité : le rôle provient exclusivement de app_metadata (serveur scellé) ou de public.profiles (protégé RLS).
   * user_metadata n'est jamais utilisé pour accorder un rôle car il est modifiable par le client.
   */
  private loadUserProfileFromSupabase(
    userId: string,
    email: string,
    accessToken: string,
    authUser?: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null
  ): Promise<UserProfile | null> {
    if (!accessToken) return Promise.resolve(null);

    const pending = this.profileLoadRequests.get(userId);
    if (pending?.token === accessToken) return pending.promise;

    const request = this.fetchUserProfileFromSupabase(userId, email, accessToken, authUser);
    const trackedRequest = request.finally(() => {
      if (this.profileLoadRequests.get(userId)?.promise === trackedRequest) {
        this.profileLoadRequests.delete(userId);
      }
    });
    this.profileLoadRequests.set(userId, { token: accessToken, promise: trackedRequest });
    return trackedRequest;
  }

  private async fetchUserProfileFromSupabase(
    userId: string,
    email: string,
    accessToken: string,
    authUser?: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null
  ): Promise<UserProfile | null> {
    this.profileLoadError = null;
    try {
      const profileEndpoint = this.getProfileEndpoint();
      if (!profileEndpoint) {
        this.profileLoadError = 'Le service de vérification du profil utilisateur est indisponible.';
        return null;
      }

      // Les profils ne sont plus lus directement depuis PostgREST côté navigateur.
      // Le serveur valide le Bearer token puis lit public.profiles avec service_role.
      const response = await fetch(profileEndpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        console.warn(`Lecture profil serveur échouée (HTTP ${response.status}).`);
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        this.profileLoadError = this.getAuthErrorMessage(
          payload,
          response.status === 403
            ? 'Vous n’êtes pas autorisé à charger ce profil utilisateur.'
            : 'Impossible de vérifier le profil utilisateur.',
          'Connexion au service de vérification du profil impossible. Vérifiez votre connexion puis réessayez.'
        );
        if (response.status === 401 || response.status === 403) {
          this.handleUnauthorizedSession();
        }
        return null;
      }

      const payload = await response.json() as {
        profile?: Record<string, unknown>;
        role?: string;
        customRole?: string | null;
        roleLabel?: string | null;
      };
      const profile = payload.profile;
      if (!profile || profile['id'] !== userId) {
        this.profileLoadError = 'Le profil utilisateur est introuvable ou invalide.';
        return null;
      }

      const customRole = typeof payload.customRole === 'string' && payload.customRole.trim()
        ? payload.customRole.trim()
        : undefined;
      const serverRole = typeof payload.role === 'string' ? payload.role : undefined;
      const appRole = (authUser?.app_metadata?.['custom_role'] as string | undefined)
        || (authUser?.app_metadata?.['role'] as UserRole | undefined);
      const profileRole = profile['role'] as UserRole | undefined;
      const resolvedRole: UserRole = normalizeUserRole(customRole || serverRole || appRole || profileRole || 'employe');

      const userProfile: UserProfile = {
        id: userId,
        email: email || String(profile['email'] || ''),
        firstName: String(profile['first_name'] || authUser?.user_metadata?.['first_name'] || 'Utilisateur'),
        lastName: String(profile['last_name'] || authUser?.user_metadata?.['last_name'] || 'Transmex'),
        role: resolvedRole,
        roles: [resolvedRole],
        customRole: customRole || (typeof payload.customRole === 'string' ? payload.customRole : null),
        roleLabel: typeof payload.roleLabel === 'string' ? payload.roleLabel : null,
        department: String(profile['department'] || 'Services Généraux'),
        phone: typeof profile['phone'] === 'string' ? profile['phone'] : undefined,
        isActive: profile['is_active'] !== false,
        avatarUrl: typeof profile['avatar_url'] === 'string' ? profile['avatar_url'] : undefined,
        createdAt: typeof profile['created_at'] === 'string' ? profile['created_at'] : new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };

      this.setLocalSession(userProfile, accessToken);

      if (accessToken && resolvedRole === 'admin' && authUser?.app_metadata?.['role'] !== 'admin') {
        void this.triggerServerRoleSync(accessToken);
      }

      return userProfile;
    } catch (err) {
      console.warn('Erreur lors du chargement du profil utilisateur depuis le serveur:', err);
      this.profileLoadError = this.getAuthErrorMessage(
        err,
        'Impossible de vérifier le profil utilisateur.',
        'Connexion au service de vérification du profil impossible. Vérifiez votre connexion puis réessayez.'
      );
      return null;
    }
  }

  /**
   * Connexion via Supabase Auth (signInWithPassword).
   */
  public async login(credentials: LoginCredentials): Promise<{ success: boolean; error?: string }> {
    this._isLoading.set(true);
    this._authError.set(null);

    const email = credentials.email.trim().toLowerCase();
    const password = credentials.password;

    try {
      await this.supabaseService.ensureInitialized();
      this.listenToAuthChanges();

      if (!this.checkSupabaseConfigured() || !this.supabaseService.supabase) {
        throw new Error("Le service Supabase n'est pas configuré.");
      }

      const { data, error } = await this.supabaseService.supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        let friendlyError = error.message;
        if (error.message.includes('Invalid login credentials')) {
          friendlyError = 'Identifiants invalides : email ou mot de passe incorrect.';
        } else if (error.message.toLowerCase().includes('rate limit') || error.message.toLowerCase().includes('rate exceeded') || error.message.toLowerCase().includes('too many requests')) {
          friendlyError = 'Limite de tentatives atteinte sur le serveur Supabase. Veuillez patienter un instant avant de réessayer.';
        }
        throw new Error(friendlyError);
      }

      if (data.user) {
        const accessToken = data.session?.access_token || '';
        if (accessToken) {
          this._token.set(accessToken);
          this.saveSessionToken(accessToken);
        }

        const profile = await this.loadUserProfileFromSupabase(
          data.user.id,
          data.user.email || email,
          accessToken,
          data.user
        );

        if (!profile) {
          throw new Error(this.profileLoadError ?? 'Le profil utilisateur est introuvable ou invalide.');
        }

        if (!profile.isActive) {
          void this.supabaseService.supabase.auth.signOut().catch(() => undefined);
          this.clearLocalSession();
          throw new Error('Ce compte utilisateur a été désactivé.');
        }

        this._isLoading.set(false);
        void this.router.navigate(['/apps']);
        return { success: true };
      }

      throw new Error('Échec de la connexion.');
    } catch (err: unknown) {
      const errMessage = this.getAuthErrorMessage(
        err,
        'Impossible de vous connecter. Veuillez réessayer.',
        'Connexion au service d’authentification impossible. Vérifiez votre connexion puis réessayez.'
      );
      this._authError.set(errMessage);
      this._isLoading.set(false);
      return { success: false, error: errMessage };
    }
  }

  /**
   * Inscription d'un utilisateur dans Supabase Auth
   */
  public async signUp(email: string, password: string, profileData: Partial<UserProfile>): Promise<{ success: boolean; error?: string }> {
    this._isLoading.set(true);
    this._authError.set(null);

    try {
      if (!this.checkSupabaseConfigured() || !this.supabaseService.supabase) {
        throw new Error('L’inscription est indisponible : le service Supabase n’est pas configuré.');
      }

      const { error } = await this.supabaseService.supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: {
            first_name: profileData.firstName,
            last_name: profileData.lastName,
          },
        },
      });

      if (error) throw error;
      this._isLoading.set(false);
      return { success: true };
    } catch (err: unknown) {
      let msg = this.getAuthErrorMessage(
        err,
        'Impossible de créer le compte. Veuillez réessayer.',
        'Connexion au service d’inscription impossible. Vérifiez votre connexion puis réessayez.'
      );
      if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('rate exceeded') || msg.toLowerCase().includes('too many requests')) {
        msg = 'Limite d’envois/inscriptions atteinte sur Supabase. Veuillez patienter un court instant avant de réessayer.';
      }
      this._authError.set(msg);
      this._isLoading.set(false);
      return { success: false, error: msg };
    }
  }

  public async updatePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.supabaseService.ensureInitialized();

      if (!this.checkSupabaseConfigured() || !this.supabaseService.supabase) {
        return { success: false, error: 'Le service Supabase n’est pas configuré.' };
      }

      const current = this._currentUser();
      if (!current?.email) {
        return { success: false, error: 'Utilisateur non connecté.' };
      }

      const { error: signInError } = await this.supabaseService.supabase.auth.signInWithPassword({
        email: current.email,
        password: currentPassword,
      });

      if (signInError) {
        return {
          success: false,
          error: 'Le mot de passe actuel est incorrect.',
        };
      }

      const { error: updateError } = await this.supabaseService.supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        return { success: false, error: updateError.message };
      }

      return { success: true };
    } catch (err: unknown) {
      return {
        success: false,
        error: this.getAuthErrorMessage(
          err,
          'Impossible de modifier le mot de passe. Veuillez réessayer.',
          'Connexion au service d’authentification impossible pour modifier le mot de passe. Vérifiez votre connexion puis réessayez.'
        ),
      };
    }
  }

  public hasRole(requiredRoles: UserRole | UserRole[]): boolean {
    const current = this._currentUser();
    if (!current || !current.isActive) return false;
    if (current.role === 'admin') return true;

    const rolesArray = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
    return rolesArray.includes(current.role) || (current.customRole ? rolesArray.includes(current.customRole as UserRole) : false);
  }

  /**
   * Déconnexion sécurisée : réinitialise immédiatement l'état local et redirige vers /auth/login,
   * puis révoque la session Supabase en arrière-plan sans bloquer l'interface.
   */
  public async logout(): Promise<void> {
    this.clearLocalSession();
    void this.router.navigate(['/auth/login']);

    const auth = this.supabaseService.supabase?.auth;
    if (auth) {
      void auth.signOut().catch(() => undefined);
    }
  }

  public async refreshAccessTokenAfterUnauthorized(): Promise<
    | { status: 'refreshed'; accessToken: string }
    | { status: 'invalid' }
    | { status: 'unavailable' }
  > {
    const auth = this.supabaseService.supabase?.auth;
    if (!auth) return { status: 'invalid' };

    try {
      const { data, error } = await auth.refreshSession();
      if (error) {
        return error.status === 0 || error.name === 'AuthRetryableFetchError'
          ? { status: 'unavailable' }
          : { status: 'invalid' };
      }

      const accessToken = data.session?.access_token;
      if (!accessToken) return { status: 'invalid' };

      this._token.set(accessToken);
      this.saveSessionToken(accessToken);
      return { status: 'refreshed', accessToken };
    } catch {
      return { status: 'unavailable' };
    }
  }

  public handleUnauthorizedSession(): void {
    const returnUrl = this.router.url;
    this.clearInvalidLocalSession();
    if (!returnUrl.startsWith('/auth/login')) {
      void this.router.navigate(['/auth/login'], { queryParams: { returnUrl } });
    }
  }

  private clearInvalidLocalSession(): void {
    this.clearLocalSession();
    const auth = this.supabaseService.supabase?.auth;
    if (auth) {
      void auth.signOut({ scope: 'local' }).catch(() => undefined);
    }
  }

  private clearLocalSession(): void {
    this.clearCachedProfile();
    this.clearSessionToken();
    this._currentUser.set(null);
    this._token.set(null);
    this._authError.set(null);
  }

  private getProfileEndpoint(): string | null {
    if (this.isBrowser) return '/api/profile/me';

    if (typeof process !== 'undefined' && process.env) {
      const configuredOrigin = process.env['APP_BASE_URL'] || process.env['VERCEL_URL'];
      if (configuredOrigin) {
        const baseUrl = configuredOrigin.startsWith('http')
          ? configuredOrigin
          : `https://${configuredOrigin}`;
        return new URL('/api/profile/me', baseUrl).toString();
      }
    }

    if (this.serverRequest && typeof process !== 'undefined' && process.env['NODE_ENV'] !== 'production') {
      const requestUrl = new URL(this.serverRequest.url);
      if (requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1') {
        return new URL('/api/profile/me', requestUrl.origin).toString();
      }
    }

    return null;
  }

  public setLocalSession(user: UserProfile, token: string): void {
    this.saveCachedProfile(user);
    this.saveSessionToken(token);
    this._currentUser.set(user);
    this._token.set(token);
    this._authError.set(null);
  }

  /**
   * Déclenche la réconciliation et le scellement du rôle administrateur auprès du serveur.
   * Empêche toute perte ou rétrogradation de droits.
   */
  private async triggerServerRoleSync(accessToken: string): Promise<void> {
    try {
      const response = await fetch('/api/auth/sync-role', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        if (data && data.role && this._currentUser()) {
          const current = this._currentUser()!;
          if (current.role !== data.role) {
            const updatedProfile: UserProfile = {
              ...current,
              role: data.role as UserRole,
              roles: [data.role as UserRole],
            };
            this.setLocalSession(updatedProfile, accessToken);
          }
        }
      }
    } catch (e) {
      console.warn('Synchronisation serveur du rôle (non-bloquante) :', e);
    }
  }
}
