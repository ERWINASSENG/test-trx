import { Injectable, computed, inject, signal, effect, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CreateUserPayload, UpdateUserPayload, UserProfile } from '../models/auth.model';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { normalizeUserRole } from '../utils/role.utils';

const USERS_STORAGE_KEY = 'transmex_users_store';

@Injectable({
  providedIn: 'root',
})
export class UserService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private checkSupabaseConfigured(): boolean {
    const configured = this.supabaseService.isConfigured;
    if (typeof configured === 'function') {
      return configured();
    }
    return Boolean(configured);
  }

  private async getAuthToken(): Promise<string> {
    if (!this.isBrowser) return '';

    // 1. Récupération prioritaire depuis le signal d'authentification réactif AuthService
    const authSignalToken = this.authService.token();
    if (authSignalToken) return authSignalToken;

    try {
      if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        await this.supabaseService.ensureInitialized();
        const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
        if (sessionData?.session?.access_token) {
          return sessionData.session.access_token;
        }
      }

      // Chercher aussi les tokens sb-*-auth-token stockés automatiquement par Supabase
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('sb-') && key.endsWith('-auth-token'))) {
          try {
            const val = JSON.parse(localStorage.getItem(key) || '{}');
            if (val?.access_token) return val.access_token;
          } catch {
            // Ignorer
          }
        }
      }
    } catch {
      // Ignorer
    }

    return '';
  }

  private readonly _users = signal<UserProfile[]>([]);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);

  public readonly users = this._users.asReadonly();
  public readonly isLoading = this._isLoading.asReadonly();
  public readonly error = this._error.asReadonly();

  // Statistiques calculées pour le tableau de bord et l'administration
  public readonly totalUsersCount = computed(() => this._users().length);
  public readonly activeUsersCount = computed(() => this._users().filter((u) => u.isActive).length);
  public readonly adminCount = computed(() => this._users().filter((u) => u.role === 'admin').length);
  public readonly managerCount = computed(() => this._users().filter((u) => u.role === 'manager').length);
  public readonly caissiereCount = computed(() => this._users().filter((u) => u.role === 'caissiere').length);
  public readonly employeCount = computed(() => this._users().filter((u) => u.role === 'employe').length);

  constructor() {
    this.restoreFromStorage();
    effect(() => {
      const user = this.authService.currentUser();
      if (user && this.isBrowser) {
        void this.loadInitialUsers();
      }
    });
  }

  private restoreFromStorage(): void {
    if (this.isBrowser) {
      try {
        const stored = localStorage.getItem(USERS_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this._users.set(parsed);
          }
        }
      } catch {
        // Ignorer
      }
    }
  }

  /**
   * Charge la liste des utilisateurs depuis l’API serveur.
   */
  public async loadInitialUsers(): Promise<void> {
    this._isLoading.set(true);
    this._error.set(null);

    try {
      if (!this.isBrowser) {
        return;
      }

      const authToken = await this.getAuthToken();
      if (!authToken) {
        // Si l'utilisateur n'est pas encore identifié, préserver le cache local existant sans vider la liste
        this._isLoading.set(false);
        return;
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${authToken}`,
      };

      const res = await fetch('/api/system/collaborators', { method: 'GET', headers });
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        throw new Error(errorData?.error || `Erreur serveur (${res.status}) lors du chargement des utilisateurs.`);
      }

      const data = await res.json();
      if (!data?.users || !Array.isArray(data.users)) {
        throw new Error('Réponse invalide du serveur de gestion des utilisateurs.');
      }

      const mapped: UserProfile[] = data.users.map((row: UserProfile) => ({
        id: row.id,
        email: row.email,
        firstName: row.firstName || 'Utilisateur',
        lastName: row.lastName || 'Transmex',
        role: normalizeUserRole(row.role),
        customRole: row.customRole || null,
        roleLabel: row.roleLabel || null,
        department: row.department || 'Services Généraux',
        phone: row.phone,
        isActive: row.isActive ?? true,
        avatarUrl: row.avatarUrl,
        createdAt: row.createdAt || new Date().toISOString(),
        lastLoginAt: row.lastLoginAt,
      }));

      this._users.set(mapped);
      this.saveToStorage(mapped);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors du chargement des utilisateurs';
      this._error.set(msg);
      // En cas d'erreur de communication réseau, préserver les données locales déjà en mémoire
      if (this._users().length === 0) {
        this.restoreFromStorage();
      }
    } finally {
      this._isLoading.set(false);
    }
  }

  /**
   * Crée un nouvel utilisateur avec attribution de rôle et compte Supabase Auth
   */
  public async createUser(payload: CreateUserPayload): Promise<{ success: boolean; user?: UserProfile; error?: string }> {
    this._isLoading.set(true);
    this._error.set(null);

    try {
      const email = payload.email.trim().toLowerCase();

      // Vérifier si l'email existe déjà dans la liste locale
      const exists = this._users().some((u) => u.email.toLowerCase() === email);
      if (exists) {
        throw new Error(`Un utilisateur avec l'adresse email ${email} existe déjà.`);
      }

      const password = payload.tempPassword?.trim() || 'Transmex@' + Math.floor(1000 + Math.random() * 9000);

      // Création impérative via l'API sécurisée d'administration (/api/system/collaborators)
      if (!this.isBrowser) {
        throw new Error('La création d’utilisateur ne peut être exécutée que depuis le navigateur.');
      }

      const authToken = await this.getAuthToken();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const displayName = `${payload.firstName.trim()} ${payload.lastName.trim()}`.trim();

      const res = await fetch('/api/system/collaborators', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email,
          password,
          firstName: payload.firstName.trim(),
          lastName: payload.lastName.trim(),
          displayName,
          role: payload.role,
          department: payload.department?.trim() || 'Services Généraux',
          phone: payload.phone?.trim() || '',
          isActive: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Erreur serveur (${res.status}) lors de la création de l'utilisateur.`);
      }

      if (!data?.user) {
        throw new Error('Réponse invalide du serveur de synchronisation.');
      }

      const newUser: UserProfile = {
        id: data.user.id,
        email: data.user.email,
        firstName: data.user.firstName,
        lastName: data.user.lastName,
        role: data.user.role,
        roles: [data.user.role],
        department: data.user.department,
        phone: data.user.phone,
        isActive: data.user.isActive ?? true,
        createdAt: data.user.createdAt || new Date().toISOString(),
      };

      const updatedList = [newUser, ...this._users()];
      this._users.set(updatedList);
      this.saveToStorage(updatedList);
      this._isLoading.set(false);

      return { success: true, user: newUser };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la création du compte';
      this._error.set(msg);
      this._isLoading.set(false);
      return { success: false, error: msg };
    }
  }

  /**
   * Met à jour son propre profil depuis la page Mon profil.
   * Cette route ne doit pas passer par l'API d'administration, car les utilisateurs standards
   * n'ont pas les droits d'éditer un autre compte ni de modifier le rôle.
   */
  public async updateCurrentUserProfile(payload: Partial<Pick<UpdateUserPayload, 'firstName' | 'lastName' | 'department' | 'phone'>>): Promise<{ success: boolean; error?: string }> {
    this._isLoading.set(true);
    this._error.set(null);

    try {
      if (!this.isBrowser) {
        return { success: false, error: 'La mise à jour du profil n’est possible que depuis le navigateur.' };
      }

      const authToken = await this.getAuthToken();
      const res = await fetch('/api/profile/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `Erreur serveur (${res.status})`);
      }

      this._isLoading.set(false);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la mise à jour du profil';
      this._error.set(msg);
      this._isLoading.set(false);
      return { success: false, error: msg };
    }
  }

  /**
   * Met à jour les informations ou le rôle d'un utilisateur existant
   */
  public async updateUser(id: string, payload: UpdateUserPayload): Promise<{ success: boolean; error?: string }> {
    this._isLoading.set(true);
    this._error.set(null);

    try {
      if (!this.isBrowser) throw new Error('La mise à jour nécessite un navigateur authentifié.');

      const authToken = await this.getAuthToken();
      const res = await fetch(`/api/system/collaborators/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Erreur serveur (${res.status})`);

      await this.loadInitialUsers();
      this._isLoading.set(false);

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la mise à jour';
      this._error.set(msg);
      this._isLoading.set(false);
      return { success: false, error: msg };
    }
  }

  /**
   * Bascule le statut actif / inactif d'un compte
   */
  public async toggleUserStatus(id: string): Promise<void> {
    const user = this._users().find((u) => u.id === id);
    if (!user) return;
    await this.updateUser(id, { isActive: !user.isActive });
  }

  /**
   * Supprime un collaborateur de l'authentification et de la table des profils
   */
  public async deleteUser(id: string): Promise<{ success: boolean; error?: string }> {
    this._isLoading.set(true);
    try {
      if (!this.isBrowser) throw new Error('La suppression nécessite un navigateur authentifié.');

      const authToken = await this.getAuthToken();
      const res = await fetch(`/api/system/collaborators/${id}`, {
        method: 'DELETE',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Erreur serveur (${res.status})`);

      await this.loadInitialUsers();
      this._isLoading.set(false);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors de la suppression';
      this._error.set(msg);
      this._isLoading.set(false);
      return { success: false, error: msg };
    }
  }

  /**
   * Vide tous les utilisateurs enregistrés localement
   */
  public clearAllUsers(): void {
    this._users.set([]);
    if (this.isBrowser) {
      try {
        localStorage.removeItem(USERS_STORAGE_KEY);
      } catch {
        // Ignorer
      }
    }
  }

  private saveToStorage(list: UserProfile[]): void {
    if (this.isBrowser) {
      try {
        localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(list));
      } catch {
        // Ignorer
      }
    }
  }
}
