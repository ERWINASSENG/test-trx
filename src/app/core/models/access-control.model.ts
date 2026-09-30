export type AccessScopeValue =
  | string
  | number
  | boolean
  | null
  | AccessScopeValue[]
  | { [key: string]: AccessScopeValue };

export interface AccessScope {
  type: string;
  version: number;
  [key: string]: AccessScopeValue;
}

export type PermissionEffect = 'allow' | 'deny';
export type RoleAssignmentSource = 'admin' | 'legacy_profile';

export interface AccessRole {
  id: string;
  roleKey: string;
  label: string;
  description: string;
  isSystem: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccessPermission {
  permissionKey: string;
  resourceKey: string;
  actionKey: string;
  label: string;
  description: string;
  isSensitive: boolean;
}

export interface AccessRolePermission {
  roleId: string;
  permissionKey: string;
  scope: AccessScope;
  grantedBy: string | null;
  createdAt: string;
}

export interface AccessUserRole {
  userId: string;
  roleId: string;
  roleKey: string;
  assignedBy: string | null;
  assignmentSource: RoleAssignmentSource;
  createdAt: string;
  expiresAt: string | null;
}

export interface AccessPermissionOverride {
  id: string;
  userId: string;
  permissionKey: string;
  effect: PermissionEffect;
  scope: AccessScope;
  reason: string;
  grantedBy: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface EffectivePermission {
  permissionKey: string;
  scope: AccessScope;
  effect: PermissionEffect;
  sourceRoleKey?: string;
}

export interface AccessAuditEntry {
  id: number;
  actorUserId: string | null;
  subjectUserId: string | null;
  actionKey: string;
  roleKey: string | null;
  permissionKey: string | null;
  reason: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
}

export interface CreateAccessRoleInput {
  roleKey: string;
  label: string;
  description: string;
}

export interface AssignAccessRoleInput {
  userId: string;
  roleId: string;
  expiresAt?: string | null;
}