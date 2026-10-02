import { Injectable, computed, inject, signal } from '@angular/core';
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
  private readonly authService = inject(AuthService);

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

  public hasPermission(permissionKey: string): boolean {
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

    // 4. Repli canonique robuste selon le rôle Transmex du collaborateur
    const userRole = this.authService.currentRole();
    if (!userRole) return false;

    switch (userRole) {
      case 'admin':
        return true;
      case 'manager':
        return ['cashier.read', 'cashier.write', 'hr.read', 'hr.write', 'prospects.read', 'prospects.write'].includes(permissionKey);
      case 'tresorier':
      case 'comptable':
        return ['cashier.read', 'cashier.write', 'journals.read', 'journals.write'].includes(permissionKey);
      case 'caissiere':
        return ['cashier.read', 'cashier.write'].includes(permissionKey);
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

  public async loadMyPermissions(): Promise<void> {
    const result = await this.request<{ permissions: EffectivePermission[] }>('/me');
    this._effectivePermissions.set(result.success ? result.data?.permissions || [] : []);
    this._error.set(result.success ? null : result.error || 'Impossible de charger les permissions.');
  }

  public async loadRoles(): Promise<void> {
    const result = await this.request<{ roles: Record<string, unknown>[] }>('/roles');
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les rôles.');
      return;
    }
    this._roles.set((result.data?.roles || []).map((role) => this.mapRole(role)));
    this._error.set(null);
  }

  public async loadPermissions(): Promise<void> {
    const result = await this.request<{ permissions: Record<string, unknown>[] }>('/permissions');
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les permissions.');
      return;
    }
    this._permissions.set((result.data?.permissions || []).map((permission) => this.mapPermission(permission)));
    this._error.set(null);
  }

  public async loadUsers(limit = 200): Promise<void> {
    const result = await this.request<{ users: Record<string, unknown>[] }>(`/users?limit=${encodeURIComponent(String(limit))}`);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les utilisateurs.');
      return;
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
  }

  public async loadRolePermissions(roleId: string): Promise<void> {
    const result = await this.request<{
      role: Record<string, unknown>;
      grants: Record<string, unknown>[];
    }>(`/roles/${encodeURIComponent(roleId)}/permissions`);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les permissions du rôle.');
      return;
    }
    this._selectedRole.set(result.data?.role ? this.mapRole(result.data.role) : null);
    this._roleGrants.set((result.data?.grants || []).map((grant) => this.mapRoleGrant(grant)));
    this._error.set(null);
  }

  public async loadUserAccess(userId: string): Promise<void> {
    const result = await this.request<Record<string, unknown>>(`/users/${encodeURIComponent(userId)}`);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger les accès utilisateur.');
      return;
    }
    this._selectedUserAccess.set(result.data ? this.mapUserAccess(result.data) : null);
    this._error.set(null);
  }

  public async loadAudit(limit = 50, userId?: string): Promise<void> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (userId) query.set('userId', userId);
    const result = await this.request<{ entries: Record<string, unknown>[] }>(`/audit?${query.toString()}`);
    if (!result.success) {
      this._error.set(result.error || 'Impossible de charger le journal d’audit.');
      return;
    }
    this._auditEntries.set((result.data?.entries || []).map((entry) => this.mapAuditEntry(entry)));
    this._error.set(null);
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
    await this.loadMyPermissions();
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

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<AccessApiResult<T>> {
    const token = this.authService.token();
    if (!token) return { success: false, error: 'Session authentifiée introuvable.' };

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
      if (!response.ok) {
        return { success: false, error: payload.error || `Échec de la requête (${response.status}).` };
      }
      return { success: true, data: payload };
    } catch {
      return { success: false, error: 'Le serveur d’autorisations est injoignable.' };
    } finally {
      this._isLoading.set(false);
    }
  }
}