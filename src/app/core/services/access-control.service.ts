import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  AccessAuditEntry,
  AccessPermission,
  AccessPermissionOverride,
  AccessRole,
  AccessRolePermission,
  AccessUserRole,
  AssignAccessRoleInput,
  CreateAccessRoleInput,
  EffectivePermission,
  PermissionEffect,
} from '../models/access-control.model';
import { AuthService } from './auth.service';

interface ApiSuccess<T> {
  success?: boolean;
  data?: T;
}

export interface AccessApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface UserAccessDetails {
  user: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
    is_active: boolean;
  };
  roleAssignments: (AccessUserRole & { role: AccessRole | null })[];
  overrides: AccessPermissionOverride[];
}

export interface AccessControlUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  roles: {
    role: AccessRole;
    expiresAt: string | null;
  }[];
}

@Injectable({ providedIn: 'root' })
export class AccessControlService {
  private static readonly PERMISSIONS_CACHE_TTL_MS = 30_000;
  private static readonly GET_CACHE_TTL_MS = 30_000;
  private readonly authService = inject(AuthService);
  private permissionsUserId: string | null | undefined;
  private permissionsLoadedUserId: string | null = null;
  private permissionsLoadedAt = 0;
  private permissionsRequestVersion = 0;
  private permissionsRequest: {
    userId: string;
    promise: Promise<boolean>;
  } | null = null;
  private readonly activeRequests = new Set<number>();
  private nextRequestId = 0;
  private readonly getResponseCache = new Map<string, {
    cachedAt: number;
    result: AccessApiResult<unknown>;
  }>();

  private readonly _roles = signal<AccessRole[]>([]);
  private readonly _users = signal<AccessControlUser[]>([]);
  private readonly _permissions = signal<AccessPermission[]>([]);
  private readonly _effectivePermissions = signal<EffectivePermission[]>([]);
  private readonly _roleGrants = signal<AccessRolePermission[]>([]);
  private readonly _selectedRole = signal<AccessRole | null>(null);
  private readonly _selectedUserAccess = signal<UserAccessDetails | null>(null);
  private readonly _auditEntries = signal<AccessAuditEntry[]>([]);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  public readonly roles = computed(() => this._roles());
  public readonly users = computed(() => this._users());
  public readonly permissions = computed(() => this._permissions());
  public readonly effectivePermissions = computed(() => this._effectivePermissions());
  public readonly roleGrants = computed(() => this._roleGrants());
  public readonly selectedRole = computed(() => this._selectedRole());
  public readonly selectedUserAccess = computed(() => this._selectedUserAccess());
  public readonly auditEntries = computed(() => this._auditEntries());
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());

  constructor() {
    effect(() => {
      this.authService.currentUser();
      this.resetForAccountChange();
    });
  }

  public hasPermission(permissionKey: string): boolean {
    this.resetForAccountChange();

    // 1. Règle d'or : l'administrateur système possède tous les droits
    if (this.authService.isAdmin() || this.authService.currentUser()?.role === 'admin') {
      return true;
    }

    // 2. Accès universel garanti aux espaces communs pour tout utilisateur authentifié
    if (['apps.view', 'dashboard.view', 'profile.read'].includes(permissionKey)) {
      return true;
    }

    // 3. Évaluation granulaire issue de l'API /api/access-control/me
    const matchingPermissions = this._effectivePermissions().filter(
      (permission) => permission.permissionKey === permissionKey
    );
    if (matchingPermissions.some((permission) => permission.effect === 'deny' && permission.scope.type === 'all')) return false;
    if (matchingPermissions.some((permission) => permission.effect === 'allow' && permission.scope.type === 'all')) return true;
    if (matchingPermissions.length > 0) return false;

    // Dynamic roles must not inherit privileges from their normalized legacy role.
    if (this.authService.currentUser()?.customRole) return false;

    // 4. Repli canonique robuste selon le rôle Transmex du collaborateur
    const userRole = this.authService.currentRole();
    if (!userRole) return false;

    switch (userRole) {
      case 'admin':
        return true;
      case 'manager':
        return [
          'cashier.read',
          'cashier.write',
          'users.read',
          'dossiers.read',
          'dossiers.create',
          'hr.read',
          'hr.write',
          'prospects.read',
          'prospects.write',
        ].includes(permissionKey);
      case 'tresorier':
        return [
          'cashier.read',
          'cashier.write',
          'dossiers.read',
          'cashier.update',
          'cashier.status_update',
          'cashier.duplicate',
          'journals.read',
          'journals.write',
          'journals.create',
          'journals.update',
          'journals.delete',
          'journal_entries.read',
          'journal_entries.chart_read',
          'journal_entries.create',
          'journal_entries.update',
          'journal_entries.delete',
        ].includes(permissionKey);
      case 'comptable':
        return [
          'cashier.read',
          'cashier.write',
          'dossiers.read',
          'cashier.duplicate',
          'journals.read',
          'journals.write',
          'journals.create',
          'journals.update',
          'journals.delete',
          'journal_entries.read',
          'journal_entries.chart_read',
          'journal_entries.create',
          'journal_entries.update',
          'journal_entries.delete',
        ].includes(permissionKey);
      case 'caissiere':
        return ['cashier.read', 'cashier.write', 'dossiers.read', 'cashier.status_update', 'cashier.update'].includes(permissionKey);
      case 'employe':
        return ['hr.read'].includes(permissionKey);
      default:
        return false;
    }
  }
  
  public hasPermissionForResource(
    permissionKey: string,
    resource: { subjectUserId?: string; ownerUserId?: string; departmentId?: string }
  ): boolean {
    this.resetForAccountChange();

    if (this.authService.isAdmin() || this.authService.currentUser()?.role === 'admin') {
      return true;
    }

    const actorId = this.authService.currentUser()?.id;
    if (!actorId) return false;
    const matchingPermissions = this._effectivePermissions().filter(
      (permission) => permission.permissionKey === permissionKey
    );
    const scopeMatches = (scope: EffectivePermission['scope']): boolean => {
      switch (scope.type) {
        case 'all': return true;
        case 'self': return resource.subjectUserId === actorId;
        case 'owner': return resource.ownerUserId === actorId;
        case 'department': return typeof scope['departmentId'] === 'string' && resource.departmentId === scope['departmentId'];
        default: return false;
      }
    };
    if (matchingPermissions.some((permission) => permission.effect === 'deny' && scopeMatches(permission.scope))) return false;
    return matchingPermissions.some((permission) => permission.effect === 'allow' && scopeMatches(permission.scope));
  }

  public loadMyPermissions(forceRefresh = false): Promise<boolean> {
    this.resetForAccountChange();
    const requestedUserId = this.authService.currentUser()?.id ?? null;
    if (!requestedUserId) return Promise.resolve(false);

    if (
      !forceRefresh &&
      this.permissionsLoadedUserId === requestedUserId &&
      Date.now() - this.permissionsLoadedAt < AccessControlService.PERMISSIONS_CACHE_TTL_MS
    ) {
      return Promise.resolve(true);
    }

    if (!forceRefresh && this.permissionsRequest?.userId === requestedUserId) {
      return this.permissionsRequest.promise;
    }

    const requestVersion = ++this.permissionsRequestVersion;
    const request = (async () => {
      const result = await this.request<{ permissions: EffectivePermission[] }>('/me', 'GET', undefined, false);
      if (
        (this.authService.currentUser()?.id ?? null) !== requestedUserId ||
        requestVersion !== this.permissionsRequestVersion
      ) return false;

      this._effectivePermissions.set(result.success ? result.data?.permissions || [] : []);
      this._error.set(result.success ? null : result.error || 'Impossible de charger les permissions.');
      if (result.success) {
        this.permissionsLoadedUserId = requestedUserId;
        this.permissionsLoadedAt = Date.now();
      }
      return result.success;
    })();
    const trackedRequest = request.finally(() => {
      if (this.permissionsRequest?.promise === trackedRequest) {
        this.permissionsRequest = null;
      }
    });
    this.permissionsRequest = { userId: requestedUserId, promise: trackedRequest };
    return trackedRequest;
  }

  private resetForAccountChange(): void {
    const userId = this.authService.currentUser()?.id ?? null;
    if (this.permissionsUserId === userId) return;

    this.permissionsUserId = userId;
    this.permissionsLoadedUserId = null;
    this.permissionsLoadedAt = 0;
    this.permissionsRequestVersion += 1;
    this.permissionsRequest = null;
    this.getResponseCache.clear();
    this._roles.set([]);
    this._users.set([]);
    this._permissions.set([]);
    this._effectivePermissions.set([]);
    this._roleGrants.set([]);
    this._selectedRole.set(null);
    this._selectedUserAccess.set(null);
    this._auditEntries.set([]);
    this.activeRequests.clear();
    this._isLoading.set(false);
    this._error.set(null);
  }

  public async loadRoles(forceRefresh = false): Promise<boolean> {
    const result = await this.request<{ roles: Record<string, unknown>[] }>('/roles', 'GET', undefined, !forceRefresh);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les rôles.');
      return false;
    }
    this._roles.set((result.data?.roles || []).map((role) => this.mapRole(role)));
    this._error.set(null);
    return true;
  }

  public async loadPermissions(forceRefresh = false): Promise<boolean> {
    const result = await this.request<{ permissions: Record<string, unknown>[] }>('/permissions', 'GET', undefined, !forceRefresh);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les permissions.');
      return false;
    }
    this._permissions.set((result.data?.permissions || []).map((permission) => this.mapPermission(permission)));
    this._error.set(null);
    return true;
  }

  public async loadUsers(limit = 200, forceRefresh = false): Promise<boolean> {
    const result = await this.request<{ users: Record<string, unknown>[] }>(
      `/users?limit=${encodeURIComponent(String(limit))}`,
      'GET',
      undefined,
      !forceRefresh
    );
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les utilisateurs.');
      return false;
    }
    this._users.set((result.data?.users || []).map((user) => ({
      id: String(user['id'] ?? ''),
      email: String(user['email'] ?? ''),
      firstName: String(user['first_name'] ?? ''),
      lastName: String(user['last_name'] ?? ''),
      isActive: user['is_active'] === true,
      roles: Array.isArray(user['roles'])
        ? user['roles']
          .filter((assignment): assignment is Record<string, unknown> => Boolean(assignment && typeof assignment === 'object'))
          .map((assignment) => ({
            role: this.mapRole((assignment['role'] || {}) as Record<string, unknown>),
            expiresAt: typeof assignment['expires_at'] === 'string' ? assignment['expires_at'] : null,
          }))
        : [],
    })));
    this._error.set(null);
    return true;
  }

  public async loadRolePermissions(roleId: string, forceRefresh = false): Promise<boolean> {
    const result = await this.request<{
      role: Record<string, unknown>;
      grants: Record<string, unknown>[];
    }>(`/roles/${encodeURIComponent(roleId)}/permissions`, 'GET', undefined, !forceRefresh);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les permissions du rôle.');
      return false;
    }
    this._selectedRole.set(result.data?.role ? this.mapRole(result.data.role) : null);
    this._roleGrants.set((result.data?.grants || []).map((grant) => this.mapRoleGrant(grant)));
    this._error.set(null);
    return true;
  }

  public async loadUserAccess(userId: string): Promise<boolean> {
    const result = await this.request<Record<string, unknown>>(`/users/${encodeURIComponent(userId)}`);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les accès utilisateur.');
      return false;
    }
    this._selectedUserAccess.set(result.data ? this.mapUserAccess(result.data) : null);
    this._error.set(null);
    return true;
  }

  public async loadAudit(limit = 50, userId?: string, forceRefresh = false): Promise<boolean> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (userId) query.set('userId', userId);
    const result = await this.request<{ entries: Record<string, unknown>[] }>(
      `/audit?${query.toString()}`,
      'GET',
      undefined,
      !forceRefresh
    );
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger le journal d’audit.');
      return false;
    }
    this._auditEntries.set((result.data?.entries || []).map((entry) => this.mapAuditEntry(entry)));
    this._error.set(null);
    return true;
  }

  public async createRole(input: CreateAccessRoleInput): Promise<AccessApiResult<AccessRole>> {
    return this.mutate<AccessRole>('/roles', 'POST', input);
  }

  public async updateRole(roleId: string, update: Partial<Pick<AccessRole, 'label' | 'description' | 'isActive'>>): Promise<AccessApiResult<AccessRole>> {
    return this.mutate<AccessRole>(`/roles/${encodeURIComponent(roleId)}`, 'PATCH', {
      label: update.label,
      description: update.description,
      isActive: update.isActive,
    });
  }

  public async deleteRole(roleId: string): Promise<AccessApiResult<{ deleted: boolean }>> {
    return this.mutate<{ deleted: boolean }>(`/roles/${encodeURIComponent(roleId)}`, 'DELETE');
  }

  public async replaceRolePermissions(
    roleId: string,
    grants: Pick<AccessRolePermission, 'permissionKey' | 'scope'>[]
  ): Promise<AccessApiResult<AccessRolePermission[]>> {
    return this.mutate<AccessRolePermission[]>(`/roles/${encodeURIComponent(roleId)}/permissions`, 'PUT', { grants });
  }

  public async assignRole(input: AssignAccessRoleInput): Promise<AccessApiResult<AccessUserRole>> {
    return this.mutate<AccessUserRole>(`/users/${encodeURIComponent(input.userId)}/roles`, 'POST', {
      roleId: input.roleId,
      expiresAt: input.expiresAt,
    });
  }

  public async revokeRole(userId: string, roleId: string): Promise<AccessApiResult<{ revoked: boolean }>> {
    return this.mutate<{ revoked: boolean }>(`/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`, 'DELETE');
  }

  public async setPermissionOverride(input: {
    userId: string;
    permissionKey: string;
    effect: PermissionEffect;
    scope: AccessPermissionOverride['scope'];
    reason: string;
    expiresAt?: string | null;
  }): Promise<AccessApiResult<AccessPermissionOverride>> {
    return this.mutate<AccessPermissionOverride>(`/users/${encodeURIComponent(input.userId)}/overrides`, 'PUT', {
      permissionKey: input.permissionKey,
      effect: input.effect,
      scope: input.scope,
      reason: input.reason,
      expiresAt: input.expiresAt,
    });
  }

  public async revokePermissionOverride(userId: string, overrideId: string): Promise<AccessApiResult<{ revoked: boolean }>> {
    return this.mutate<{ revoked: boolean }>(`/users/${encodeURIComponent(userId)}/overrides/${encodeURIComponent(overrideId)}`, 'DELETE');
  }

  private async mutate<T>(path: string, method: string, body?: unknown): Promise<AccessApiResult<T>> {
    const result = await this.request<ApiSuccess<T>>(path, method, body);
    if (!result.success) return { success: false, error: result.error };
    this.getResponseCache.clear();
    await this.loadMyPermissions(true);
    return { success: true, data: result.data?.data };
  }

  private mapRole(row: Record<string, unknown>): AccessRole {
    return {
      id: String(row['id'] ?? ''),
      roleKey: String(row['role_key'] ?? row['roleKey'] ?? ''),
      label: String(row['label'] ?? ''),
      description: String(row['description'] ?? ''),
      isSystem: row['is_system'] === true || row['isSystem'] === true,
      isActive: row['is_active'] === true || row['isActive'] === true,
      createdAt: String(row['created_at'] ?? row['createdAt'] ?? ''),
      updatedAt: String(row['updated_at'] ?? row['updatedAt'] ?? ''),
    };
  }

  private mapPermission(row: Record<string, unknown>): AccessPermission {
    return {
      permissionKey: String(row['permission_key'] ?? row['permissionKey'] ?? ''),
      resourceKey: String(row['resource_key'] ?? row['resourceKey'] ?? ''),
      actionKey: String(row['action_key'] ?? row['actionKey'] ?? ''),
      label: String(row['label'] ?? ''),
      description: String(row['description'] ?? ''),
      isSensitive: row['is_sensitive'] === true || row['isSensitive'] === true,
    };
  }

  private mapRoleGrant(row: Record<string, unknown>): AccessRolePermission {
    return {
      roleId: String(row['role_id'] ?? row['roleId'] ?? ''),
      permissionKey: String(row['permission_key'] ?? row['permissionKey'] ?? ''),
      scope: row['scope'] as AccessRolePermission['scope'],
      grantedBy: typeof (row['granted_by'] ?? row['grantedBy']) === 'string'
        ? String(row['granted_by'] ?? row['grantedBy'])
        : null,
      createdAt: String(row['created_at'] ?? row['createdAt'] ?? ''),
    };
  }

  private mapUserAccess(row: Record<string, unknown>): UserAccessDetails {
    const userRow = (row['user'] || {}) as Record<string, unknown>;
    const assignments = Array.isArray(row['roleAssignments']) ? row['roleAssignments'] as Record<string, unknown>[] : [];
    const overrides = Array.isArray(row['overrides']) ? row['overrides'] as Record<string, unknown>[] : [];

    return {
      user: {
        id: String(userRow['id'] ?? ''),
        email: String(userRow['email'] ?? ''),
        first_name: String(userRow['first_name'] ?? ''),
        last_name: String(userRow['last_name'] ?? ''),
        is_active: userRow['is_active'] === true,
      },
      roleAssignments: assignments.map((assignment) => ({
        userId: String(assignment['user_id'] ?? ''),
        roleId: String(assignment['role_id'] ?? ''),
        assignedBy: typeof assignment['assigned_by'] === 'string' ? assignment['assigned_by'] : null,
        assignmentSource: assignment['assignment_source'] as AccessUserRole['assignmentSource'],
        createdAt: String(assignment['created_at'] ?? ''),
        expiresAt: typeof assignment['expires_at'] === 'string' ? assignment['expires_at'] : null,
        role: assignment['role'] && typeof assignment['role'] === 'object'
          ? this.mapRole(assignment['role'] as Record<string, unknown>)
          : null,
        roleKey: typeof (assignment['role'] as Record<string, unknown> | undefined)?.['role_key'] === 'string'
          ? String((assignment['role'] as Record<string, unknown>)['role_key'])
          : '',
      })),
      overrides: overrides.map((override) => ({
        id: String(override['id'] ?? ''),
        userId: String(override['user_id'] ?? ''),
        permissionKey: String(override['permission_key'] ?? ''),
        effect: override['effect'] as PermissionEffect,
        scope: override['scope'] as AccessPermissionOverride['scope'],
        reason: String(override['reason'] ?? ''),
        grantedBy: String(override['granted_by'] ?? ''),
        createdAt: String(override['created_at'] ?? ''),
        expiresAt: typeof override['expires_at'] === 'string' ? override['expires_at'] : null,
      })),
    };
  }

  private mapAuditEntry(row: Record<string, unknown>): AccessAuditEntry {
    return {
      id: Number(row['id']),
      actorUserId: typeof row['actor_user_id'] === 'string' ? row['actor_user_id'] : null,
      subjectUserId: typeof row['subject_user_id'] === 'string' ? row['subject_user_id'] : null,
      actionKey: String(row['action_key'] ?? ''),
      roleKey: typeof row['role_key'] === 'string' ? row['role_key'] : null,
      permissionKey: typeof row['permission_key'] === 'string' ? row['permission_key'] : null,
      reason: typeof row['reason'] === 'string' ? row['reason'] : null,
      beforeState: row['before_state'] && typeof row['before_state'] === 'object' ? row['before_state'] as Record<string, unknown> : null,
      afterState: row['after_state'] && typeof row['after_state'] === 'object' ? row['after_state'] as Record<string, unknown> : null,
      requestId: typeof row['request_id'] === 'string' ? row['request_id'] : null,
      createdAt: String(row['created_at'] ?? ''),
    };
  }

  private async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    useGetCache = true
  ): Promise<AccessApiResult<T>> {
    // 1. Attendre la résolution initiale de la session d'authentification
    await this.authService.waitForSession();
    this.resetForAccountChange();
    const requestedUserId = this.authService.currentUser()?.id ?? null;

    let token = this.authService.token();
    if (!token && typeof window !== 'undefined' && window.sessionStorage) {
      token = sessionStorage.getItem('transmex_session_token');
    }
    if (!token) return { success: false, error: 'Session authentifiée introuvable.' };

    const cacheKey = method === 'GET' && useGetCache && requestedUserId
      ? `${requestedUserId}:${path}`
      : null;
    if (cacheKey) {
      const cached = this.getResponseCache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < AccessControlService.GET_CACHE_TTL_MS) {
        return cached.result as AccessApiResult<T>;
      }
      if (cached) this.getResponseCache.delete(cacheKey);
    }

    const requestId = ++this.nextRequestId;
    this.activeRequests.add(requestId);
    this._isLoading.set(true);
    try {
      const response = await fetch(`/api/access-control${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => ({})) as T & { error?: string };
      if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) {
        return { success: false, error: 'La session a changé pendant la requête.' };
      }
      if (!response.ok) {
        return { success: false, error: payload.error || `Échec de la requête (${response.status}).` };
      }
      const result: AccessApiResult<T> = { success: true, data: payload };
      if (cacheKey) this.getResponseCache.set(cacheKey, { cachedAt: Date.now(), result });
      return result;
    } catch {
      return { success: false, error: 'Le serveur d’autorisations est injoignable.' };
    } finally {
      this.activeRequests.delete(requestId);
      this._isLoading.set(this.activeRequests.size > 0);
    }
  }
}