import { Injectable, computed, inject, signal, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CreateUserPayload, UpdateUserPayload, UserProfile } from '../models/auth.model';
import { SupabaseService } from './supabase.service';
import { normalizeUserRole } from '../utils/role.utils';

const USERS_STORAGE_KEY = 'transmex_users_store';

@Injectable({
  providedIn: 'root',
})
export class UserService {
  private readonly supabaseService = inject(SupabaseService);
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

    try {
      if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        await this.supabaseService.ensureInitialized();
        const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
        if (sessionData?.session?.access_token) {
          return sessionData.session.access_token;
        }
      }

      const cachedToken = localStorage.getItem('transmex_auth_token');
      if (cachedToken) return cachedToken;

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
    this.loadInitialUsers();
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
   * Charge la liste des utilisateurs depuis le stockage ou Supabase
   */
  public async loadInitialUsers(): Promise<void> {
    this._isLoading.set(true);
    this._error.set(null);

    try {
      // 1. Tenter l'appel à l'API sécurisée /api/system/collaborators avec le Bearer token admin
      if (this.isBrowser) {
        try {
          const authToken = await this.getAuthToken();
          const headers: Record<string, string> = {};
          if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
          }

          const res = await fetch('/api/system/collaborators', { method: 'GET', headers });
          if (res.ok) {
            const data = await res.json();
            if (data?.users && Array.isArray(data.users)) {
              const mapped: UserProfile[] = data.users.map((row: UserProfile) => {
                const resolvedRole = normalizeUserRole(row.role);
                return {
                  id: row.id,
                  email: row.email,
                  firstName: row.firstName || 'Utilisateur',
                  lastName: row.lastName || 'Transmex',
                  role: resolvedRole,
                  department: row.department || 'Services Généraux',
                  phone: row.phone,
                  isActive: row.isActive ?? true,
                  avatarUrl: row.avatarUrl,
                  createdAt: row.createdAt || new Date().toISOString(),
                  lastLoginAt: row.lastLoginAt,
                };
              });

              this._users.set(mapped);
              this.saveToStorage(mapped);
              this._isLoading.set(false);
              return;
            }
          }
        } catch {
          // Ignorer et passer aux modes de secours
        }
      }

      if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        const { data, error } = await this.supabaseService.supabase
          .from('profiles')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) {
          throw error;
        }

        if (data) {
          const mapped: UserProfile[] = data.map((row) => {
            const resolvedRole = normalizeUserRole(row.role);
            return {
              id: row.id,
              email: row.email,
              firstName: row.first_name || 'Utilisateur',
              lastName: row.last_name || 'Transmex',
              role: resolvedRole,
              department: row.department || 'Services Généraux',
              phone: row.phone,
              isActive: row.is_active ?? true,
              avatarUrl: row.avatar_url,
              createdAt: row.created_at,
              lastLoginAt: row.last_sign_in_at || undefined,
            };
          });

          this._users.set(mapped);
          this.saveToStorage(mapped);
          this._isLoading.set(false);
          return;
        }
      }

      // Si aucune donnée n'est récupérée mais qu'il y avait déjà des utilisateurs en cache, les préserver
      if (this._users().length === 0) {
        if (this.isBrowser) {
          localStorage.removeItem(USERS_STORAGE_KEY);
        }
        this._users.set([]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur lors du chargement des utilisateurs';
      this._error.set(msg);
      // Ne pas écraser les données locales si une erreur survient
      if (this._users().length === 0) {
        this._users.set([]);
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
   * Met à jour les informations ou le rôle d'un utilisateur existant
   */
  public async updateUser(id: string, payload: UpdateUserPayload): Promise<{ success: boolean; error?: string }> {
    this._isLoading.set(true);
    this._error.set(null);

    try {
      let updateSucceeded = false;
      let lastErrorMessage = '';

      if (this.isBrowser) {
        try {
          const authToken = await this.getAuthToken();
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
          }

          const res = await fetch(`/api/system/collaborators/${id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify(payload),
          });

          if (res.ok) {
            updateSucceeded = true;
          } else {
            const errData = await res.json().catch(() => null);
            lastErrorMessage = errData?.error || `Erreur serveur (${res.status})`;
          }
        } catch (fetchErr) {
          lastErrorMessage = fetchErr instanceof Error ? fetchErr.message : 'Erreur de connexion';
        }
      }

      // Repli direct Supabase si l'API Express n'a pas pu être atteinte.
      // IMPORTANT : jamais pour un changement de rôle. Seule l'API serveur (clé service_role)
      // met à jour auth.users.app_metadata.role, qui est la source de vérité prioritaire côté
      // serveur (resolveServerRole) et dans la liste des collaborateurs. Un repli qui ne touche
      // que public.profiles.role laisserait l'ancien rôle "scellé" dans app_metadata reprendre
      // le dessus, et donnerait l'impression trompeuse que le changement n'a pas été enregistré.
      if (!updateSucceeded && payload.role !== undefined) {
        throw new Error(
          lastErrorMessage ||
            "Le changement de rôle nécessite le service d'administration serveur, actuellement injoignable. Réessayez."
        );
      }

      if (!updateSucceeded && this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        const updateData: Record<string, unknown> = {};
        if (payload.firstName !== undefined) updateData['first_name'] = payload.firstName;
        if (payload.lastName !== undefined) updateData['last_name'] = payload.lastName;
        if (payload.department !== undefined) updateData['department'] = payload.department;
        if (payload.phone !== undefined) updateData['phone'] = payload.phone;
        if (payload.isActive !== undefined) updateData['is_active'] = payload.isActive;
        if (payload.avatarUrl !== undefined) updateData['avatar_url'] = payload.avatarUrl;

        // .select('id') est indispensable ici : sans lui, un UPDATE bloqué par une policy RLS
        // (0 ligne affectée) renvoie quand même error === null, et le code affichait alors
        // un succès trompeur alors que rien n'avait été écrit en base.
        const { data: directData, error: directErr } = await this.supabaseService.supabase
          .from('profiles')
          .update(updateData)
          .eq('id', id)
          .select('id');

        if (!directErr && directData && directData.length > 0) {
          updateSucceeded = true;
        } else if (!directErr && (!directData || directData.length === 0)) {
          lastErrorMessage = lastErrorMessage || 'Aucune ligne modifiée (droits insuffisants ou compte introuvable).';
        } else if (directErr && !lastErrorMessage) {
          lastErrorMessage = directErr.message;
        }
      }

      if (!updateSucceeded) {
        throw new Error(lastErrorMessage || 'Échec de l’enregistrement du rôle en base de données.');
      }

      const updatedList = this._users().map((u) => {
        if (u.id === id) {
          return {
            ...u,
            firstName: payload.firstName ?? u.firstName,
            lastName: payload.lastName ?? u.lastName,
            role: payload.role ?? u.role,
            roles: payload.role ? [payload.role] : u.roles,
            department: payload.department ?? u.department,
            phone: payload.phone ?? u.phone,
            isActive: payload.isActive ?? u.isActive,
            avatarUrl: payload.avatarUrl ?? u.avatarUrl,
          };
        }
        return u;
      });

      this._users.set(updatedList);
      this.saveToStorage(updatedList);
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
      if (this.isBrowser) {
        try {
          let authToken = '';
          if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
            const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
            authToken = sessionData.session?.access_token || '';
          }

          const headers: Record<string, string> = {};
          if (authToken) {
            headers['Authorization'] = `Bearer ${authToken}`;
          }

          await fetch(`/api/system/collaborators/${id}`, { method: 'DELETE', headers });
        } catch {
          // Si endpoint indisponible (mode test), continuer
        }
      }

      if (this.checkSupabaseConfigured() && this.supabaseService.supabase) {
        await this.supabaseService.supabase.from('profiles').delete().eq('id', id);
      }

      const updatedList = this._users().filter((u) => u.id !== id);
      this._users.set(updatedList);
      this.saveToStorage(updatedList);
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
