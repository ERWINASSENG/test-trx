import express from 'express';
import { AccessScope, EffectivePermission, PermissionEffect } from '../app/core/models/access-control.model';
import { getSupabaseAdmin, loadServerUserProfile } from './auth';
import type { ServerUserProfile } from './auth';

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

export interface LoadedAccessRules {
  roleKeys: string[];
  rules: AccessRule[];
  hasActiveRoleAssignments?: boolean;
}

export const MODULE_CAPABILITY_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  'module.dashboard.view': ['dashboard.'],
  'module.accounting.view': ['cashier.', 'journals.', 'journal_entries.'],
  'module.hr.view': ['hr.', 'users.'],
  'module.prospects.view': ['prospects.'],
  'module.quotes.view': ['quotes.'],
  'module.crm.view': ['crm.'],
  'module.dossiers.view': ['dossiers.'],
  'module.configuration.view': ['configuration.', 'journals.create', 'journals.update', 'journals.delete'],
  'module.access_control.view': ['access.'],
};

export const legacyModuleVisibilityPermissions = (roleKeys?: readonly string[]): string[] => {
  void roleKeys;
  return [];
};

export const deriveModuleVisibilityFromCapabilities = (
  grantedPermissions: readonly string[]
): string[] => {
  const visibleModules: string[] = [];
  for (const [moduleKey, prefixes] of Object.entries(MODULE_CAPABILITY_PREFIXES)) {
    const hasCapability = prefixes.some((prefix) =>
      prefix.endsWith('.')
        ? grantedPermissions.some((perm) => perm.startsWith(prefix))
        : grantedPermissions.includes(prefix)
    );
    if (hasCapability && !visibleModules.includes(moduleKey)) {
      visibleModules.push(moduleKey);
    }
  }
  return visibleModules;
};

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

export const createAccessRulesLoader = (
  loadFromDatabase: (
    userId: string,
    profile?: ServerUserProfile | null
  ) => Promise<LoadedAccessRules | null>
): ((userId: string, profile?: ServerUserProfile | null) => Promise<LoadedAccessRules | null>) => {
  const requests = new Map<string, Promise<LoadedAccessRules | null>>();
  return (userId, profile) => {
    const pending = requests.get(userId);
    if (pending) return pending;

    const request = loadFromDatabase(userId, profile).finally(() => {
      if (requests.get(userId) === request) requests.delete(userId);
    });
    requests.set(userId, request);
    return request;
  };
};

const loadAccessRulesFromDatabase = async (
  userId: string,
  preloadedProfile?: ServerUserProfile | null
): Promise<LoadedAccessRules | null> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) return null;

  const profile = preloadedProfile === undefined
    ? await loadServerUserProfile(adminClient, userId)
    : preloadedProfile;

  if (!profile || profile.is_active !== true) return null;

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
  let roleIds = [...new Set(roleAssignments.map((assignment) => String(assignment.role_id)))];

  if (roleIds.length === 0 && profile.role) {
    const roleLookupResult = await adminClient
      .from('access_roles')
      .select('id, role_key')
      .eq('role_key', profile.role)
      .eq('is_active', true)
      .maybeSingle();
    if (roleLookupResult.data?.id) {
      roleIds = [String(roleLookupResult.data.id)];
    }
  }

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

export const ACCESS_RULES_CACHE_TTL_MS = 60_000;

interface CachedAccessRules {
  rules: LoadedAccessRules | null;
  cachedAt: number;
}

const accessRulesCache = new Map<string, CachedAccessRules>();

export const clearAccessRulesCache = (userId?: string): void => {
  if (userId) {
    accessRulesCache.delete(userId);
  } else {
    accessRulesCache.clear();
  }
};

const rawLoadAccessRules = createAccessRulesLoader(loadAccessRulesFromDatabase);

export const loadAccessRules = async (
  userId: string,
  profile?: ServerUserProfile | null,
  skipCache = false
): Promise<LoadedAccessRules | null> => {
  const now = Date.now();
  if (!skipCache) {
    const cached = accessRulesCache.get(userId);
    if (cached && now - cached.cachedAt < ACCESS_RULES_CACHE_TTL_MS) {
      return cached.rules;
    }
  }

  try {
    const rules = await rawLoadAccessRules(userId, profile);
    if (rules !== null) {
      accessRulesCache.set(userId, { rules, cachedAt: Date.now() });
    }
    return rules;
  } catch (error) {
    const existing = accessRulesCache.get(userId);
    if (existing?.rules) {
      return existing.rules;
    }
    throw error;
  }
};

export const resolveEffectivePermissions = async (
  userId: string,
  profile?: ServerUserProfile | null
): Promise<EffectivePermission[] | null> => {
  const accessRules = await loadAccessRules(userId, profile);
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
  if (!effective.some((p) => p.permissionKey === 'profile.read')) {
    effective.push({ permissionKey: 'profile.read', scope: { type: 'all', version: 1 }, effect: 'allow', sourceRoleKey: primaryRole });
  }

  // Déduire automatiquement la visibilité de module pour tout rôle ayant au moins une capacité métier
  const grantedPermissionKeys = effective
    .filter((p) => p.effect === 'allow')
    .map((p) => p.permissionKey);
  const derivedModules = deriveModuleVisibilityFromCapabilities(grantedPermissionKeys);
  for (const moduleKey of derivedModules) {
    if (!effective.some((p) => p.permissionKey === moduleKey)) {
      effective.push({
        permissionKey: moduleKey,
        scope: { type: 'all', version: 1 },
        effect: 'allow',
        sourceRoleKey: primaryRole,
      });
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
  if (['apps.view', 'profile.read'].includes(permissionKey)) {
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

  // Déduction automatique de module.*.view depuis les capacités accordées au rôle
  const grantedRoleKeys = accessRules.rules
    .filter((r) => !r.isUserOverride && r.effect === 'allow')
    .map((r) => r.permissionKey);
  if (deriveModuleVisibilityFromCapabilities(grantedRoleKeys).includes(permissionKey)) {
    return true;
  }

  // 3. Souveraineté stricte des choix de l'administrateur :
  // Si la permission n'est ni universelle, ni dérivée pour la visibilité du module,
  // ni expressément accordée dans les règles de rôle ou surcharges configurées par l'administrateur,
  // elle est STRICTEMENT refusée (aucun repli permissif implicite).
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
    const authProfile = (req as unknown as Record<string, unknown>)['authProfile'] as ServerUserProfile | null | undefined;
    const accessRules = await loadAccessRules(user.id, authProfile);
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


