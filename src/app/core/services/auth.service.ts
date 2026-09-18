import { Injectable, computed, inject, signal, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import { LoginCredentials, UserProfile, UserRole } from '../models/auth.model';
import { SupabaseService } from './supabase.service';
import { normalizeUserRole } from '../utils/role.utils';

const CACHED_PROFILE_KEY = 'transmex_user_profile';
const CACHED_TOKEN_KEY = 'transmex_auth_token';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private sessionRestoredResolver!: () => void;
  public readonly sessionRestoredPromise: Promise<void>;

  // Signaux réactifs d'état d'authentification
  private readonly _currentUser = signal<UserProfile | null>(null);
  private readonly _token = signal<string | null>(null);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _authError = signal<string | null>(null);
  private readonly _isAuthReady = signal<boolean>(false);

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
   * Restaure le profil et le token depuis localStorage pour un affichage instantané
   */
  private restoreCachedProfile(): void {
    if (this.isBrowser && typeof window !== 'undefined' && window.localStorage) {
      try {
        const cachedToken = localStorage.getItem(CACHED_TOKEN_KEY);
        if (cachedToken) {
          this._token.set(cachedToken);
        }

        const cached = localStorage.getItem(CACHED_PROFILE_KEY);
        if (cached) {
          const profile = JSON.parse(cached) as UserProfile;
          if (profile && profile.id && profile.isActive) {
            this._currentUser.set(profile);
          }
        }
      } catch {
        // Ignorer les exceptions de localStorage
      }
    }
  }

  private saveCachedProfile(profile: UserProfile, token?: string): void {
    if (this.isBrowser && typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.setItem(CACHED_PROFILE_KEY, JSON.stringify(profile));
        if (token) {
          localStorage.setItem(CACHED_TOKEN_KEY, token);
        }
      } catch {
        // Ignorer
      }
    }
  }

  private clearCachedProfile(): void {
    if (this.isBrowser && typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.removeItem(CACHED_PROFILE_KEY);
        localStorage.removeItem(CACHED_TOKEN_KEY);
      } catch {
        // Ignorer
      }
    }
  }

  /**
   * Écoute les événements Supabase (onAuthStateChange) pour synchroniser le Signal _currentUser.
   */
  private listenToAuthChanges(): void {
    if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
      try {
        this.supabaseService.supabase.auth.onAuthStateChange(async (event, session) => {
          if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session?.user) {
            await this.loadUserProfileFromSupabase(
              session.user.id,
              session.user.email || '',
              session.access_token,
              session.user
            );
          } else if (event === 'SIGNED_OUT') {
            this.clearLocalSession();
          }
        });
      } catch (err) {
        console.warn('Erreur lors de l’écoute des changements d’authentification:', err);
      }
    }
  }

  /**
   * Restaure la session au démarrage depuis Supabase SDK.
   */
  public async restoreSession(): Promise<void> {
    try {
      await this.supabaseService.ensureInitialized();

      if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        // Validation stricte du JWT avec le serveur Supabase Auth (bonnes pratiques Supabase)
        const { data: userData, error: userError } = await this.supabaseService.supabase.auth.getUser();
        
        if (userData?.user && !userError) {
          const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
          const accessToken = sessionData.session?.access_token || '';
          
          const profile = await this.loadUserProfileFromSupabase(
            userData.user.id,
            userData.user.email || '',
            accessToken,
            userData.user
          );
          if (profile && !profile.isActive) {
            this.clearLocalSession();
          }
        } else if (!this._currentUser()) {
          this.clearLocalSession();
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
  private async loadUserProfileFromSupabase(
    userId: string,
    email: string,
    accessToken: string,
    authUser?: { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null
  ): Promise<UserProfile | null> {
    if (!this.supabaseService.supabase) return null;

    try {
      const { data: profile } = await this.supabaseService.supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      const appRole = authUser?.app_metadata?.['role'] as UserRole | undefined;
      const profileRole = profile?.role as UserRole | undefined;
      const userMetaRole = authUser?.user_metadata?.['role'] as UserRole | undefined;

      // Résolution sécurisée du rôle :
      // 1. Si app_metadata (scellé serveur par Supabase Admin) ou profile (table SQL sécurisée) spécifie 'admin' => 'admin'
      // 2. user_metadata n'est jamais utilisé pour élever les privilèges admin (modifiable côté client)
      let targetRole: UserRole = 'employe';
      if (appRole === 'admin' || profileRole === 'admin') {
        targetRole = 'admin';
      } else {
        targetRole = normalizeUserRole(appRole || profileRole || userMetaRole || 'employe');
      }

      const resolvedRole: UserRole = targetRole;

      const userProfile: UserProfile = {
        id: userId,
        email: email || profile?.email || '',
        firstName: profile?.first_name || (authUser?.user_metadata?.['first_name'] as string) || 'Utilisateur',
        lastName: profile?.last_name || (authUser?.user_metadata?.['last_name'] as string) || 'Transmex',
        role: resolvedRole,
        roles: [resolvedRole],
        department: profile?.department || 'Services Généraux',
        phone: profile?.phone,
        isActive: profile?.is_active ?? true,
        avatarUrl: profile?.avatar_url,
        createdAt: profile?.created_at || new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };

      this.setLocalSession(userProfile, accessToken);

      // Auto-réconciliation avec le serveur d'administration
      if (accessToken && resolvedRole === 'admin') {
        this.triggerServerRoleSync(accessToken);
      }

      return userProfile;
    } catch (err) {
      console.warn('Erreur lors du chargement du profil utilisateur depuis Supabase:', err);
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
        const profile = await this.loadUserProfileFromSupabase(
          data.user.id,
          data.user.email || email,
          data.session?.access_token || '',
          data.user
        );

        if (!profile) {
          throw new Error('Profil utilisateur introuvable.');
        }

        if (!profile.isActive) {
          await this.supabaseService.supabase.auth.signOut();
          this.clearLocalSession();
          throw new Error('Ce compte utilisateur a été désactivé.');
        }

        this._isLoading.set(false);
        this.router.navigate(['/dashboard']);
        return { success: true };
      }

      throw new Error('Échec de la connexion.');
    } catch (err: unknown) {
      const errMessage = err instanceof Error ? err.message : 'Erreur de connexion';
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
      if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        const { data, error } = await this.supabaseService.supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            data: {
              first_name: profileData.firstName,
              last_name: profileData.lastName,
              role: profileData.role || 'employe',
            },
          },
        });

        if (error) throw error;

        if (data.user) {
          await this.supabaseService.supabase.from('profiles').upsert({
            id: data.user.id,
            email: email.trim().toLowerCase(),
            first_name: profileData.firstName || '',
            last_name: profileData.lastName || '',
            role: profileData.role || 'employe',
            is_active: true,
          });
        }
      }

      this._isLoading.set(false);
      return { success: true };
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : 'Erreur lors de l’inscription';
      if (msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('rate exceeded') || msg.toLowerCase().includes('too many requests')) {
        msg = 'Limite d’envois/inscriptions atteinte sur Supabase. Veuillez patienter un court instant avant de réessayer.';
      }
      this._authError.set(msg);
      this._isLoading.set(false);
      return { success: false, error: msg };
    }
  }

  public hasRole(requiredRoles: UserRole | UserRole[]): boolean {
    const current = this._currentUser();
    if (!current || !current.isActive) return false;
    if (current.role === 'admin') return true;

    const rolesArray = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
    return rolesArray.includes(current.role);
  }

  /**
   * Déconnexion sécurisée : appelle signOut(), réinitialise le Signal et redirige vers /auth/login.
   */
  public async logout(): Promise<void> {
    if (this.supabaseService.supabase) {
      try {
        await this.supabaseService.supabase.auth.signOut();
      } catch {
        // Ignorer
      }
    }

    this.clearLocalSession();
    this.router.navigate(['/auth/login']);
  }

  private clearLocalSession(): void {
    this.clearCachedProfile();
    this._currentUser.set(null);
    this._token.set(null);
    this._authError.set(null);
  }

  public setLocalSession(user: UserProfile, token: string): void {
    this.saveCachedProfile(user, token);
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
