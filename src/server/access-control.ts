import express from 'express';
import { AccessScope, EffectivePermission, PermissionEffect } from '../app/core/models/access-control.model';
import { getSupabaseAdmin } from './auth';

export interface AccessResourceContext {
  subjectUserId?: string;
  ownerUserId?: string;
  departmentId?: string;
  [key: string]: unknown;
}

interface AccessActor {
  userId: string;
}

interface AccessRule {
  permissionKey: string;
  effect: PermissionEffect;
  scope: AccessScope;
  isUserOverride: boolean;
  sourceRoleKey?: string;
}

interface LoadedAccessRules {
  roleKeys: string[];
  rules: AccessRule[];
  hasActiveRoleAssignments?: boolean;
}

const LEGACY_MODULE_VISIBILITY_BY_ROLE: Readonly<Record<string, readonly string[]>> = {
  manager: [
    'module.dashboard.view',
    'module.accounting.view',
    'module.hr.view',
    'module.prospects.view',
    'module.dossiers.view',
  ],
  tresorier: [
    'module.dashboard.view',
    'module.accounting.view',
    'module.configuration.view',
  ],
  comptable: [
    'module.dashboard.view',
    'module.accounting.view',
    'module.configuration.view',
  ],
  caissiere: ['module.dashboard.view', 'module.accounting.view'],
  employe: ['module.dashboard.view', 'module.hr.view'],
};

export const legacyModuleVisibilityPermissions = (roleKeys: readonly string[]): string[] =>
  [...new Set(roleKeys.flatMap((roleKey) => LEGACY_MODULE_VISIBILITY_BY_ROLE[roleKey] || []))];

type ScopeEvaluator = (
  scope: AccessScope,
  actor: AccessActor,
  resource: AccessResourceContext | undefined
) => boolean;

const scopeEvaluators = new Map<string, ScopeEvaluator>();

export const registerAccessScopeEvaluator = (scopeType: string, evaluator: ScopeEvaluator): void => {
  const normalizedType = scopeType.trim();
  if (!normalizedType || scopeEvaluators.has(normalizedType)) {
    throw new Error(`Type de périmètre invalide ou déjà enregistré : ${normalizedType}`);
  }
  scopeEvaluators.set(normalizedType, evaluator);
};

registerAccessScopeEvaluator('all', () => true);
registerAccessScopeEvaluator('self', (_scope, actor, resource) => resource?.subjectUserId === actor.userId);
registerAccessScopeEvaluator('owner', (_scope, actor, resource) => resource?.ownerUserId === actor.userId);
registerAccessScopeEvaluator('department', (scope, _actor, resource) => {
  const requiredDepartment = scope['departmentId'];
  return typeof requiredDepartment === 'string' && resource?.departmentId === requiredDepartment;
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isValidScope = (scope: unknown): scope is AccessScope =>
  isRecord(scope) &&
  typeof scope['type'] === 'string' &&
  scope['type'].trim().length > 0 &&
  typeof scope['version'] === 'number' &&
  scope['version'] === 1;

export const isAccessScopeSupported = (scope: unknown): scope is AccessScope =>
  isValidScope(scope) && scopeEvaluators.has(scope.type);

const scopeAllows = (
  scopeValue: unknown,
  actor: AccessActor,
  resource: AccessResourceContext | undefined
): boolean => {
  if (!isAccessScopeSupported(scopeValue)) return false;
  const evaluator = scopeEvaluators.get(scopeValue.type);
  if (!evaluator) return false;

  try {
    return evaluator(scopeValue, actor, resource);
  } catch {
    return false;
  }
};

const isUnexpired = (expiresAt: unknown, currentTime: number): boolean => {
  if (expiresAt === null || expiresAt === undefined) return true;
  if (typeof expiresAt !== 'string') return false;
  const expirationTime = Date.parse(expiresAt);
  return Number.isFinite(expirationTime) && expirationTime > currentTime;
};

export const resolveEffectiveRoleKeys = (
  assignedRoleKeys: readonly string[],
  legacyProfileRole: unknown
): string[] => {
  if (assignedRoleKeys.length > 0) return [...new Set(assignedRoleKeys)];
  return typeof legacyProfileRole === 'string' && legacyProfileRole
    ? [legacyProfileRole]
    : [];
};

const loadAccessRules = async (userId: string): Promise<LoadedAccessRules | null> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) return null;

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('is_active, role')
    .eq('id', userId)
    .maybeSingle();

  if (profileError || !profile || profile.is_active !== true) return null;

  const currentTime = Date.now();
  const [assignmentsResult, overridesResult] = await Promise.all([
    adminClient
      .from('access_user_roles')
      .select('role_id, expires_at')
      .eq('user_id', userId),
    adminClient
      .from('access_user_overrides')
      .select('permission_key, effect, scope, expires_at')
      .eq('user_id', userId),
  ]);

  if (assignmentsResult.error || overridesResult.error) return null;

  const roleAssignments = (assignmentsResult.data || []).filter((assignment) =>
    isUnexpired(assignment.expires_at, currentTime)
  );
  const roleIds = [...new Set(roleAssignments.map((assignment) => String(assignment.role_id)))];
  const roleRowsResult = roleIds.length > 0
    ? await adminClient
        .from('access_roles')
        .select('id, role_key')
        .in('id', roleIds)
        .eq('is_active', true)
    : { data: [], error: null };

  if (roleRowsResult.error) return null;

  const roleRows = (roleRowsResult.data || []) as { id: string; role_key: string }[];
  const activeRoleIds = roleRows.map((role) => role.id);
  const roleKeyById = new Map(roleRows.map((role) => [role.id, role.role_key]));
  const grantsResult = activeRoleIds.length > 0
    ? await adminClient
        .from('access_role_permissions')
        .select('role_id, permission_key, scope')
        .in('role_id', activeRoleIds)
    : { data: [], error: null };

  if (grantsResult.error) return null;

  const roleRules: AccessRule[] = (grantsResult.data || []).map((grant) => ({
    permissionKey: String(grant.permission_key),
    effect: 'allow',
    scope: grant.scope as AccessScope,
    isUserOverride: false,
    sourceRoleKey: roleKeyById.get(String(grant.role_id)),
  }));
  const userRules: AccessRule[] = (overridesResult.data || [])
    .filter((override) => isUnexpired(override.expires_at, currentTime))
    .map((override) => ({
      permissionKey: String(override.permission_key),
      effect: override.effect === 'deny' ? 'deny' : 'allow',
      scope: override.scope as AccessScope,
      isUserOverride: true,
    }));

  const resolvedRoleKeys = resolveEffectiveRoleKeys(
    roleRows.map((role) => role.role_key),
    profile.role
  );

  return {
    roleKeys: resolvedRoleKeys,
    rules: [...roleRules, ...userRules],
    hasActiveRoleAssignments: activeRoleIds.length > 0,
  };
};

export const resolveEffectivePermissions = async (userId: string): Promise<EffectivePermission[] | null> => {
  const accessRules = await loadAccessRules(userId);
  if (!accessRules) return null;

  const effective = accessRules.rules.map((rule) => ({
    permissionKey: rule.permissionKey,
    scope: rule.scope,
    effect: rule.effect,
    sourceRoleKey: rule.sourceRoleKey,
  }));

  // Assurer la présence des permissions universelles pour tout compte actif
  const primaryRole = accessRules.roleKeys[0] || 'employe';
  if (!effective.some((p) => p.permissionKey === 'apps.view')) {
    effective.push({ permissionKey: 'apps.view', scope: { type: 'all', version: 1 }, effect: 'allow', sourceRoleKey: primaryRole });
  }
  if (!effective.some((p) => p.permissionKey === 'dashboard.view')) {
    effective.push({ permissionKey: 'dashboard.view', scope: { type: 'all', version: 1 }, effect: 'allow', sourceRoleKey: primaryRole });
  }
  if (!effective.some((p) => p.permissionKey === 'profile.read')) {
    effective.push({ permissionKey: 'profile.read', scope: { type: 'all', version: 1 }, effect: 'allow', sourceRoleKey: primaryRole });
  }
  if (accessRules.hasActiveRoleAssignments === false) {
    for (const permissionKey of legacyModuleVisibilityPermissions(accessRules.roleKeys)) {
      if (!effective.some((permission) => permission.permissionKey === permissionKey)) {
        effective.push({
          permissionKey,
          scope: { type: 'all', version: 1 },
          effect: 'allow',
          sourceRoleKey: primaryRole,
        });
      }
    }
  }

  return effective;
};

const evaluatePermission = (
  userId: string,
  permissionKey: string,
  resource: AccessResourceContext | undefined,
  accessRules: LoadedAccessRules
): boolean => {

  // 1. Règle d'or : le rôle admin possède tous les droits sans exception
  if (accessRules.roleKeys.includes('admin')) {
    return true;
  }

  // 2. Accès garanti aux modules universels pour tout collaborateur actif
  if (['apps.view', 'dashboard.view', 'profile.read'].includes(permissionKey)) {
    return true;
  }

  const actor = { userId };
  const matchingRules = accessRules.rules.filter((rule) => rule.permissionKey === permissionKey);
  const matchingOverrides = matchingRules.filter((rule) => rule.isUserOverride);
  const applicableDenial = matchingOverrides.some(
    (rule) => rule.effect === 'deny' && scopeAllows(rule.scope, actor, resource)
  );
  if (applicableDenial) return false;

  const applicableOverride = matchingOverrides.some(
    (rule) => rule.effect === 'allow' && scopeAllows(rule.scope, actor, resource)
  );
  if (applicableOverride) return true;

  if (matchingRules.some((rule) => !rule.isUserOverride && scopeAllows(rule.scope, actor, resource))) {
    return true;
  }
  if (matchingRules.some((rule) => !rule.isUserOverride)) {
    return false;
  }

  if (
    accessRules.hasActiveRoleAssignments === false &&
    legacyModuleVisibilityPermissions(accessRules.roleKeys).includes(permissionKey)
  ) {
    return true;
  }

  // 3. Repli métier par rôle canonique côté serveur
  const hasRole = (role: string) => accessRules.roleKeys.includes(role);
  if (hasRole('manager') && [
    'cashier.read',
    'cashier.write',
    'dossiers.read',
    'dossiers.create',
    'hr.read',
    'hr.write',
    'users.read',
    'prospects.read',
    'prospects.write',
  ].includes(permissionKey)) {
    return true;
  }
  if (hasRole('tresorier') && [
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
  ].includes(permissionKey)) {
    return true;
  }
  if (hasRole('comptable') && [
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
  ].includes(permissionKey)) {
    return true;
  }
  if (hasRole('caissiere') && [
    'cashier.read',
    'cashier.write',
    'dossiers.read',
    'cashier.status_update',
    'cashier.update',
  ].includes(permissionKey)) {
    return true;
  }
  if (hasRole('employe') && ['hr.read'].includes(permissionKey)) {
    return true;
  }

  return false;
};

export const hasPermission = async (
  userId: string,
  permissionKey: string,
  resource: AccessResourceContext | undefined,
  loadedRules?: LoadedAccessRules
): Promise<boolean> => {
  const accessRules = loadedRules || await loadAccessRules(userId);
  return accessRules ? evaluatePermission(userId, permissionKey, resource, accessRules) : false;
};

export type AccessResourceResolver = (
  req: express.Request
) => AccessResourceContext | undefined | Promise<AccessResourceContext | undefined>;

export const resolveJournalOwnerContext: AccessResourceResolver = async (req) => {
  const rawJournalId = req.params['journalId'] || req.params['id'] || req.body?.['journal_id'];
  const journalId = Array.isArray(rawJournalId) ? String(rawJournalId[0] || '') : String(rawJournalId || '');
  if (!journalId) return undefined;

  const adminClient = getSupabaseAdmin();
  if (!adminClient) return undefined;

  const { data: journal, error } = await adminClient
    .from('journals')
    .select('created_by')
    .eq('id', journalId)
    .maybeSingle();
  if (error || !journal || typeof journal.created_by !== 'string') return undefined;

  return { ownerUserId: journal.created_by };
};

export const requirePermission = (
  permissionKey: string,
  resolveResource?: AccessResourceResolver
): express.RequestHandler => async (req, res, next): Promise<void> => {
  const user = (req as unknown as Record<string, unknown>)['user'] as { id?: string } | undefined;
  if (!user?.id) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  try {
    const accessRules = await loadAccessRules(user.id);
    if (!accessRules) {
      res.status(503).json({ error: 'Les autorisations ne sont pas disponibles.' });
      return;
    }

    const resource = resolveResource ? await resolveResource(req) : undefined;
    if (!await hasPermission(user.id, permissionKey, resource, accessRules)) {
      res.status(403).json({ error: 'Permission insuffisante pour cette action.' });
      return;
    }

    (req as unknown as Record<string, unknown>)['accessControl'] = accessRules;
    next();
  } catch (error) {
    console.error('Échec de résolution des autorisations :', error);
    res.status(503).json({ error: 'Les autorisations ne sont pas disponibles.' });
  }
};

export const requestHasPermission = (
  req: express.Request,
  permissionKey: string,
  resource?: AccessResourceContext
): boolean => {
  const accessRules = (req as unknown as Record<string, unknown>)['accessControl'] as LoadedAccessRules | undefined;
  if (!accessRules) return false;

  const actor = (req as unknown as Record<string, unknown>)['user'] as { id?: string } | undefined;
  if (!actor?.id) return false;

  return evaluatePermission(actor.id, permissionKey, resource, accessRules);
};