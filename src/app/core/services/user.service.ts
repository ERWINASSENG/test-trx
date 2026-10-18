import { Injectable, computed, effect, inject, signal, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CreateUserPayload, UpdateUserPayload, UserProfile } from '../models/auth.model';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { normalizeUserRole } from '../utils/role.utils';
import { getApiErrorMessage } from '../utils/api-error.util';

const USERS_STORAGE_KEY = 'transmex_users_store';

@Injectable({
  providedIn: 'root',
})
export class UserService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);
  private usersLoadedForUserId: string | null = null;

  private checkSupabaseConfigured(): boolean {
    const configured = this.supabaseService.isConfigured;
    if (typeof configured === 'function') {
      return configured();
    }
    return Boolean(configured);
  }

  private getOperationError(error: unknown, fallback: string, networkMessage: string): string {
    if (error instanceof TypeError) return networkMessage;
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    return fallback;
  }

  private async readApiPayload(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private async readApiError(response: Response, fallback: string): Promise<string> {
    return getApiErrorMessage(await this.readApiPayload(response), fallback);
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
    this.clearAllUsers();
    effect(() => {
      const userId = this.authService.currentUser()?.id ?? null;
      if (this.usersLoadedForUserId !== userId) {
        this.usersLoadedForUserId = userId;
        this.clearAllUsers();
      }
    });
  }

  /**
   * Charge la liste des utilisateurs depuis l’API serveur.
   */
  public async loadInitialUsers(): Promise<void> {
    const requestedUserId = this.authService.currentUser()?.id ?? null;
    this.usersLoadedForUserId = requestedUserId;
    this.clearAllUsers();
    this._isLoading.set(true);
    this._error.set(null);

    try {
      if (!this.isBrowser) {
        return;
      }

      const authToken = await this.getAuthToken();
      if (!authToken) {
        this._isLoading.set(false);
        return;
      }

      const headers: Record<string, string> = {
        Authorization: `Bearer ${authToken}`,
      };

      const res = await fetch('/api/system/collaborators', { method: 'GET', headers });
      if (!res.ok) {
        throw new Error(await this.readApiError(
          res,
          `Impossible de charger les utilisateurs (erreur HTTP ${res.status}).`
        ));
      }

      const data = await res.json();
      if (!data?.users || !Array.isArray(data.users)) {
        throw new Error('Réponse invalide du serveur de gestion des utilisateurs.');
      }

      if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) return;

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
    } catch (err: unknown) {
      const msg = this.getOperationError(
        err,
        'Impossible de charger les utilisateurs. Veuillez réessayer.',
        'Connexion au service de gestion des utilisateurs impossible. Vérifiez votre connexion puis réessayez.'
      );
      this._error.set(msg);
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

      const data = await this.readApiPayload(res);
      if (!res.ok) {
        throw new Error(getApiErrorMessage(
          data,
          `Impossible de créer l’utilisateur (erreur HTTP ${res.status}).`
        ));
      }

      if (
        typeof data !== 'object'
        || data === null
        || !('user' in data)
        || typeof data.user !== 'object'
        || data.user === null
      ) {
        throw new Error('Réponse invalide du serveur de synchronisation.');
      }
      const userData = data.user as Record<string, unknown>;
      if (
        typeof userData['id'] !== 'string'
        || typeof userData['email'] !== 'string'
        || typeof userData['firstName'] !== 'string'
        || typeof userData['lastName'] !== 'string'
        || typeof userData['role'] !== 'string'
      ) {
        throw new Error('Réponse invalide du serveur de synchronisation.');
      }
      const role = normalizeUserRole(userData['role']);

      const newUser: UserProfile = {
        id: userData['id'],
        email: userData['email'],
        firstName: userData['firstName'],
        lastName: userData['lastName'],
        role,
        roles: [role],
        department: typeof userData['department'] === 'string' ? userData['department'] : undefined,
        phone: typeof userData['phone'] === 'string' ? userData['phone'] : undefined,
        isActive: typeof userData['isActive'] === 'boolean' ? userData['isActive'] : true,
        createdAt: typeof userData['createdAt'] === 'string' ? userData['createdAt'] : new Date().toISOString(),
      };

      const updatedList = [newUser, ...this._users()];
      this._users.set(updatedList);
      this._isLoading.set(false);

      return { success: true, user: newUser };
    } catch (err: unknown) {
      const msg = this.getOperationError(
        err,
        'Impossible de créer l’utilisateur. Veuillez réessayer.',
        'Connexion au service de gestion des utilisateurs impossible pour créer le compte. Vérifiez votre connexion puis réessayez.'
      );
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

      if (!res.ok) {
        throw new Error(await this.readApiError(res, `Impossible de mettre à jour le profil (erreur HTTP ${res.status}).`));
      }

      this._isLoading.set(false);
      return { success: true };
    } catch (err: unknown) {
      const msg = this.getOperationError(
        err,
        'Impossible de mettre à jour le profil. Veuillez réessayer.',
        'Connexion au service de profil impossible. Vérifiez votre connexion puis réessayez.'
      );
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
      if (!res.ok) {
        throw new Error(await this.readApiError(res, `Impossible de mettre à jour l’utilisateur (erreur HTTP ${res.status}).`));
      }

      await this.loadInitialUsers();
      this._isLoading.set(false);

      return { success: true };
    } catch (err: unknown) {
      const msg = this.getOperationError(
        err,
        'Impossible de mettre à jour l’utilisateur. Veuillez réessayer.',
        'Connexion au service de gestion des utilisateurs impossible pour mettre à jour ce compte. Vérifiez votre connexion puis réessayez.'
      );
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
    this._error.set(null);
    try {
      if (!this.isBrowser) throw new Error('La suppression nécessite un navigateur authentifié.');

      const authToken = await this.getAuthToken();
      const res = await fetch(`/api/system/collaborators/${id}`, {
        method: 'DELETE',
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });
      if (!res.ok) {
        throw new Error(await this.readApiError(res, `Impossible de supprimer l’utilisateur (erreur HTTP ${res.status}).`));
      }

      await this.loadInitialUsers();
      this._isLoading.set(false);
      return { success: true };
    } catch (err: unknown) {
      const msg = this.getOperationError(
        err,
        'Impossible de supprimer l’utilisateur. Veuillez réessayer.',
        'Connexion au service de gestion des utilisateurs impossible pour supprimer ce compte. Vérifiez votre connexion puis réessayez.'
      );
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

}
