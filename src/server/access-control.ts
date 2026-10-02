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
}

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

const loadAccessRules = async (userId: string): Promise<LoadedAccessRules | null> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) return null;

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('is_active')
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

  return {
    roleKeys: roleRows.map((role) => role.role_key),
    rules: [...roleRules, ...userRules],
  };
};

export const resolveEffectivePermissions = async (userId: string): Promise<EffectivePermission[] | null> => {
  const accessRules = await loadAccessRules(userId);
  if (!accessRules) return null;

  return accessRules.rules.map((rule) => ({
    permissionKey: rule.permissionKey,
    scope: rule.scope,
    effect: rule.effect,
    sourceRoleKey: rule.sourceRoleKey,
  }));
};

export const hasPermission = async (
  userId: string,
  permissionKey: string,
  resource: AccessResourceContext | undefined,
  loadedRules?: LoadedAccessRules
): Promise<boolean> => {
  const accessRules = loadedRules || await loadAccessRules(userId);
  if (!accessRules) return false;

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

  return matchingRules.some(
    (rule) => !rule.isUserOverride && scopeAllows(rule.scope, actor, resource)
  );
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

  const matchingRules = accessRules.rules.filter((rule) => rule.permissionKey === permissionKey);
  const matchingOverrides = matchingRules.filter((rule) => rule.isUserOverride);
  if (matchingOverrides.some((rule) => rule.effect === 'deny' && scopeAllows(rule.scope, { userId: actor.id! }, resource))) {
    return false;
  }
  if (matchingOverrides.some((rule) => rule.effect === 'allow' && scopeAllows(rule.scope, { userId: actor.id! }, resource))) {
    return true;
  }
  return matchingRules.some((rule) => !rule.isUserOverride && scopeAllows(rule.scope, { userId: actor.id! }, resource));
};