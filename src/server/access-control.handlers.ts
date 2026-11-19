import express from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { clearAccessRulesCache, isAccessScopeSupported, resolveEffectivePermissions } from './access-control';
import { clearServerProfileCache, getSupabaseAdmin } from './auth';
import type { ServerUserProfile } from './auth';
import { isCanonicalAccessRoleKey } from './access-role-sync';
import { clearUserProfileResponseCache } from './profile';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

const singleParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] || '') : (value || '');

const actorIdFromRequest = (req: express.Request): string | null => {
  const user = (req as unknown as Record<string, unknown>)['user'] as { id?: string } | undefined;
  return user?.id || null;
};

const isCallerAdmin = (req: express.Request): boolean => {
  const user = (req as unknown as Record<string, unknown>)['user'] as { role?: string } | undefined;
  return user?.role === 'admin';
};

const isPrivilegedAccessPermission = (permissionKey: unknown): boolean =>
  typeof permissionKey === 'string' &&
  (permissionKey.startsWith('access.') || permissionKey === 'module.access_control.view');

async function isTargetUserAdmin(adminClient: SupabaseClient, userId: string): Promise<boolean> {
  const { data: profile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  if (profile?.role === 'admin') {
    return true;
  }

  const { data: adminRole } = await adminClient
    .from('access_roles')
    .select('id')
    .eq('role_key', 'admin')
    .eq('is_active', true)
    .maybeSingle();

  if (!adminRole?.id) {
    return false;
  }

  const nowIso = new Date().toISOString();
  const { data: assignment } = await adminClient
    .from('access_user_roles')
    .select('id')
    .eq('user_id', userId)
    .eq('role_id', adminRole.id)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .limit(1)
    .maybeSingle();

  return Boolean(assignment?.id);
}

const sendMutationError = (res: express.Response, error: { code?: string; message?: string }): void => {
  const responseByCode: Record<string, { status: number; message: string }> = {
    '42501': { status: 403, message: 'Accès refusé à cette opération.' },
    '22023': { status: 400, message: 'Les données de la demande sont invalides.' },
    '23503': { status: 409, message: 'Cette modification est bloquée par des dépendances existantes.' },
    '23505': { status: 409, message: 'Une entrée équivalente existe déjà.' },
    P0002: { status: 404, message: 'La ressource demandée est introuvable.' },
  };
  const response = responseByCode[error.code || ''];
  if (response) {
    res.status(response.status).json({ error: response.message });
    return;
  }

  console.error('Échec de mutation du contrôle d’accès:', error.message || 'Erreur inconnue');
  res.status(500).json({ error: 'Impossible d’enregistrer la modification des accès.' });
};

const runAccessMutation = async (
  req: express.Request,
  res: express.Response,
  operation: string,
  payload: Record<string, unknown>,
  afterMutation?: (data: unknown) => Promise<void>
): Promise<void> => {
  const actorUserId = actorIdFromRequest(req);
  if (!actorUserId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  try {
    const { data, error } = await adminClient.rpc('access_control_mutate', {
      p_actor_user_id: actorUserId,
      p_operation: operation,
      p_payload: payload,
    });

    if (!error) {
      if (afterMutation) {
        try {
          await afterMutation(data);
        } catch (cleanupError) {
          console.error('Échec de la synchronisation finale du contrôle d’accès:', cleanupError);
          res.status(500).json({ error: 'Le rôle a été attribué mais la synchronisation des anciens rôles a échoué.' });
          return;
        }
      }

      // Invalidation immédiate des caches serveur
      clearAccessRulesCache();
      clearServerProfileCache();
      clearUserProfileResponseCache();

      res.status(200).json({ success: true, data });
      return;
    }

    // Repli direct résilient pour les administrateurs si la fonction RPC est bloquée
    console.warn(`Repli administratif direct pour l’opération ${operation}:`, error.message);
    const { data: actorProfile } = await adminClient
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', actorUserId)
      .maybeSingle();

    if (!actorProfile || !actorProfile.is_active || actorProfile.role !== 'admin') {
      sendMutationError(res, error);
      return;
    }

    let fallbackData: Record<string, unknown> = {};

    if (operation === 'user.role.assign') {
      const targetUserId = String(payload['userId'] || '');
      const targetRoleId = String(payload['roleId'] || '');
      const expiresAt = (payload['expiresAt'] as string | null | undefined) || null;

      const { data: targetRole, error: roleFetchErr } = await adminClient
        .from('access_roles')
        .select('id, role_key')
        .eq('id', targetRoleId)
        .eq('is_active', true)
        .maybeSingle();

      if (roleFetchErr || !targetRole) {
        res.status(404).json({ error: 'Rôle actif introuvable pour cette affectation.' });
        return;
      }

      // Règle d’unicité : purge préalable des anciens rôles de l'utilisateur
      await adminClient.from('access_user_roles').delete().eq('user_id', targetUserId);

      const { error: upsertErr } = await adminClient.from('access_user_roles').upsert({
        user_id: targetUserId,
        role_id: targetRoleId,
        assigned_by: actorUserId,
        assignment_source: 'admin',
        expires_at: expiresAt,
      }, { onConflict: 'user_id,role_id' });

      if (upsertErr) {
        console.error('Erreur lors du repli direct access_user_roles:', upsertErr.message);
        sendMutationError(res, upsertErr);
        return;
      }

      fallbackData = { userId: targetUserId, roleKey: targetRole.role_key, expiresAt };

      await adminClient.from('access_audit_log').insert({
        actor_user_id: actorUserId,
        subject_user_id: targetUserId,
        action_key: 'user.role.assign',
        role_key: targetRole.role_key,
        reason: 'Attribution de rôle exclusif (repli direct)',
        after_state: fallbackData,
      });
    } else if (operation === 'user.role.revoke') {
      const targetUserId = String(payload['userId'] || '');
      const targetRoleId = String(payload['roleId'] || '');

      await adminClient
        .from('access_user_roles')
        .delete()
        .eq('user_id', targetUserId)
        .eq('role_id', targetRoleId);

      fallbackData = { userId: targetUserId, roleId: targetRoleId, revoked: true };

      await adminClient.from('access_audit_log').insert({
        actor_user_id: actorUserId,
        subject_user_id: targetUserId,
        action_key: 'user.role.revoke',
        reason: 'Révocation de rôle administrative (fallback résilient)',
        after_state: fallbackData,
      });
    } else {
      sendMutationError(res, error);
      return;
    }

    if (afterMutation) {
      try {
        await afterMutation(fallbackData);
      } catch (cleanupError) {
        console.error('Échec de synchronisation finale en repli direct:', cleanupError);
      }
    }

    // Invalidation immédiate des caches serveur
    clearAccessRulesCache();
    clearServerProfileCache();
    clearUserProfileResponseCache();

    res.status(200).json({ success: true, data: fallbackData });
  } catch (error) {
    console.error('Exception lors d’une mutation du contrôle d’accès:', error);
    res.status(500).json({ error: 'Impossible d’enregistrer la modification des accès.' });
  }
};

export const getMyAccessPermissionsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const userId = actorIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  try {
    const authProfile = (req as unknown as Record<string, unknown>)['authProfile'] as ServerUserProfile | null | undefined;
    const permissions = await resolveEffectivePermissions(userId, authProfile);
    if (!permissions) {
      res.status(503).json({ error: 'Les autorisations sont temporairement indisponibles.' });
      return;
    }
    res.json({ permissions });
  } catch (error) {
    console.error('Impossible de charger les permissions effectives:', error);
    res.status(503).json({ error: 'Les autorisations sont temporairement indisponibles.' });
  }
};

export const listAccessRolesHandler = async (_req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  const { data, error } = await adminClient
    .from('access_roles')
    .select('id, role_key, label, description, is_system, is_active, created_at, updated_at')
    .order('label', { ascending: true });

  if (error) {
    console.error('Impossible de lire les rôles:', error.message);
    res.status(500).json({ error: 'Impossible de charger les rôles.' });
    return;
  }

  res.json({ roles: data || [] });
};

export const listAccessPermissionsHandler = async (_req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  const { data, error } = await adminClient
    .from('access_permissions')
    .select('permission_key, resource_key, action_key, label, description, is_sensitive')
    .order('resource_key', { ascending: true })
    .order('action_key', { ascending: true });

  if (error) {
    console.error('Impossible de lire le catalogue des permissions:', error.message);
    res.status(500).json({ error: 'Impossible de charger le catalogue des permissions.' });
    return;
  }

  res.json({ permissions: data || [] });
};

export const listAccessUsersHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, email, first_name, last_name, is_active')
    .order('last_name', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('Impossible de lire les utilisateurs pour le contrôle d’accès:', error.message);
    res.status(500).json({ error: 'Impossible de charger la liste des utilisateurs.' });
    return;
  }

  const userIds = (data || []).map((user) => user.id);
  const { data: assignments, error: assignmentsError } = userIds.length > 0
    ? await adminClient
      .from('access_user_roles')
      .select('user_id, role_id, expires_at')
      .in('user_id', userIds)
    : { data: [], error: null };

  if (assignmentsError) {
    console.error('Impossible de lire les affectations des utilisateurs:', assignmentsError.message);
    res.status(500).json({ error: 'Impossible de charger les rôles des utilisateurs.' });
    return;
  }

  const roleIds = [...new Set((assignments || []).map((assignment) => assignment.role_id))];
  const { data: roles, error: rolesError } = roleIds.length > 0
    ? await adminClient
      .from('access_roles')
      .select('id, role_key, label, description, is_system, is_active, created_at, updated_at')
      .in('id', roleIds)
    : { data: [], error: null };

  if (rolesError) {
    console.error('Impossible de lire les rôles affectés:', rolesError.message);
    res.status(500).json({ error: 'Impossible de charger les rôles des utilisateurs.' });
    return;
  }

  const rolesById = new Map((roles || []).map((role) => [role.id, role]));
  const assignmentsByUserId = new Map<string, Record<string, unknown>[]>();
  for (const assignment of assignments || []) {
    const userAssignments = assignmentsByUserId.get(assignment.user_id) || [];
    const role = rolesById.get(assignment.role_id);
    if (role) {
      userAssignments.push({
        role,
        expires_at: assignment.expires_at,
      });
    }
    assignmentsByUserId.set(assignment.user_id, userAssignments);
  }

  res.json({
    users: (data || []).map((user) => ({
      ...user,
      roles: assignmentsByUserId.get(user.id) || [],
    })),
  });
};

export const getRolePermissionsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const roleId = singleParam(req.params['roleId']);
  if (!isUuid(roleId)) {
    res.status(400).json({ error: 'Identifiant de rôle invalide.' });
    return;
  }
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  const { data: role, error: roleError } = await adminClient
    .from('access_roles')
    .select('id, role_key, label, is_system, is_active')
    .eq('id', roleId)
    .maybeSingle();
  if (roleError || !role) {
    res.status(roleError ? 500 : 404).json({ error: 'Rôle introuvable.' });
    return;
  }

  const { data, error } = await adminClient
    .from('access_role_permissions')
    .select('role_id, permission_key, scope, granted_by, created_at')
    .eq('role_id', roleId)
    .order('permission_key', { ascending: true });
  if (error) {
    console.error('Impossible de lire les permissions du rôle:', error.message);
    res.status(500).json({ error: 'Impossible de charger les permissions du rôle.' });
    return;
  }

  res.json({ role, grants: data || [] });
};

export const getUserAccessHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const userId = singleParam(req.params['userId']);
  if (!isUuid(userId)) {
    res.status(400).json({ error: 'Identifiant utilisateur invalide.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  const { data: profile, error: profileError } = await adminClient
    .from('profiles')
    .select('id, email, first_name, last_name, is_active')
    .eq('id', userId)
    .maybeSingle();
  if (profileError || !profile) {
    res.status(profileError ? 500 : 404).json({ error: 'Utilisateur introuvable.' });
    return;
  }

  const [assignmentsResult, overridesResult] = await Promise.all([
    adminClient
      .from('access_user_roles')
      .select('user_id, role_id, assigned_by, assignment_source, created_at, expires_at')
      .eq('user_id', userId),
    adminClient
      .from('access_user_overrides')
      .select('id, user_id, permission_key, effect, scope, reason, granted_by, created_at, expires_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
  ]);
  if (assignmentsResult.error || overridesResult.error) {
    res.status(500).json({ error: 'Impossible de charger les accès de cet utilisateur.' });
    return;
  }

  const roleIds = [...new Set((assignmentsResult.data || []).map((assignment) => assignment.role_id))];
  const { data: roleRows, error: roleError } = roleIds.length > 0
    ? await adminClient.from('access_roles').select('id, role_key, label, is_active').in('id', roleIds)
    : { data: [], error: null };
  if (roleError) {
    res.status(500).json({ error: 'Impossible de charger les rôles affectés.' });
    return;
  }

  const rolesById = new Map((roleRows || []).map((role) => [role.id, role]));
  const roleAssignments = (assignmentsResult.data || []).map((assignment) => ({
    ...assignment,
    role: rolesById.get(assignment.role_id) || null,
  }));

  res.json({
    user: profile,
    roleAssignments,
    overrides: overridesResult.data || [],
  });
};

export const listAccessAuditHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  let query = adminClient
    .from('access_audit_log')
    .select('id, actor_user_id, subject_user_id, action_key, role_key, permission_key, reason, before_state, after_state, request_id, ip_address, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  const subjectUserId = req.query['userId'];
  if (subjectUserId !== undefined && subjectUserId !== '') {
    if (!isUuid(subjectUserId)) {
      res.status(400).json({ error: 'Identifiant utilisateur invalide pour le filtre d’audit.' });
      return;
    }
    query = query.eq('subject_user_id', subjectUserId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('Impossible de lire le journal d’audit des accès:', error.message);
    res.status(500).json({ error: 'Impossible de charger le journal d’audit.' });
    return;
  }

  res.json({ entries: data || [] });
};

export const createAccessRoleHandler = (req: express.Request, res: express.Response): Promise<void> =>
  runAccessMutation(req, res, 'role.create', {
    roleKey: req.body?.roleKey,
    label: req.body?.label,
    description: req.body?.description,
  });

export const updateAccessRoleHandler = (req: express.Request, res: express.Response): Promise<void> => {
  const roleId = singleParam(req.params['roleId']);
  if (!isUuid(roleId)) {
    res.status(400).json({ error: 'Identifiant de rôle invalide.' });
    return Promise.resolve();
  }
  return runAccessMutation(req, res, 'role.update', {
    roleId,
    label: req.body?.label,
    description: req.body?.description,
    isActive: req.body?.isActive,
  });
};

export const deleteAccessRoleHandler = (req: express.Request, res: express.Response): Promise<void> => {
  const roleId = singleParam(req.params['roleId']);
  if (!isUuid(roleId)) {
    res.status(400).json({ error: 'Identifiant de rôle invalide.' });
    return Promise.resolve();
  }
  return runAccessMutation(req, res, 'role.delete', { roleId });
};

export const replaceRolePermissionsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const roleId = singleParam(req.params['roleId']);
  if (!isUuid(roleId)) {
    res.status(400).json({ error: 'Identifiant de rôle invalide.' });
    return;
  }

  const grants = req.body?.grants;
  if (!Array.isArray(grants) || grants.some((grant: Record<string, unknown>) => !isAccessScopeSupported(grant['scope']))) {
    res.status(400).json({ error: 'Chaque permission doit utiliser un périmètre pris en charge par le serveur.' });
    return;
  }

  // S1 : Anti-élévation de privilèges pour tout non-admin
  if (!isCallerAdmin(req)) {
    const adminClient = getSupabaseAdmin();
    if (!adminClient) {
      res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
      return;
    }

    const { data: targetRole, error: roleError } = await adminClient
      .from('access_roles')
      .select('id, role_key')
      .eq('id', roleId)
      .maybeSingle();

    if (roleError) {
      res.status(500).json({ error: 'Impossible de vérifier le rôle ciblé.' });
      return;
    }
    if (!targetRole) {
      res.status(404).json({ error: 'Rôle introuvable.' });
      return;
    }
    if (targetRole.role_key === 'admin') {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut modifier les permissions du rôle administrateur.' });
      return;
    }
    if (grants.some((grant: Record<string, unknown>) => isPrivilegedAccessPermission(grant['permissionKey']))) {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut attribuer des permissions de gestion des accès.' });
      return;
    }
  }

  await runAccessMutation(req, res, 'role.permissions.replace', {
    roleId,
    grants: grants.map((grant: Record<string, unknown>) => ({
      permissionKey: grant['permissionKey'],
      scope: grant['scope'],
    })),
  });
};

export const assignAccessRoleHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const userId = singleParam(req.params['userId']);
  const roleId = req.body?.roleId;
  const callerId = actorIdFromRequest(req);
  const adminClient = getSupabaseAdmin();

  if (!isUuid(userId) || !isUuid(roleId)) {
    res.status(400).json({ error: 'Utilisateur et rôle valides sont obligatoires.' });
    return;
  }

  if (!callerId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  if (!adminClient) {
    res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
    return;
  }

  const { data: role, error: roleError } = await adminClient
    .from('access_roles')
    .select('role_key')
    .eq('id', roleId)
    .eq('is_active', true)
    .maybeSingle();
  if (roleError || !role) {
    res.status(404).json({ error: 'Rôle actif introuvable.' });
    return;
  }

  // S1 : Anti-élévation de privilèges pour tout non-admin
  if (!isCallerAdmin(req)) {
    if (callerId === userId) {
      res.status(403).json({ error: 'Action refusée : vous ne pouvez pas modifier votre propre rôle.' });
      return;
    }
    if (role.role_key === 'admin') {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut attribuer le rôle administrateur.' });
      return;
    }
    if (await isTargetUserAdmin(adminClient, userId)) {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut modifier le rôle d’un compte administrateur.' });
      return;
    }
  }

  // Protection du dernier administrateur actif si changement de rôle
  if (role.role_key !== 'admin') {
    const { data: adminAssignments } = await adminClient
      .from('access_user_roles')
      .select('user_id, access_roles!inner(role_key)')
      .eq('access_roles.role_key', 'admin');

    const adminUserIds = [...new Set((adminAssignments || []).map((r) => r.user_id))];
    if (adminUserIds.length <= 1 && adminUserIds.includes(userId)) {
      res.status(403).json({ error: 'Impossible de remplacer le rôle du dernier administrateur actif de l’application.' });
      return;
    }
  }

  await runAccessMutation(
    req,
    res,
    'user.role.assign',
    { userId, roleId, expiresAt: req.body?.expiresAt },
    async (data) => {
      const roleKey = (data as { roleKey?: unknown } | null)?.roleKey;
      if (typeof roleKey !== 'string') throw new Error('La réponse de la mutation ne contient pas de rôle valide.');

      // Règle d'unicité : suppression de tout autre rôle affecté à cet utilisateur
      await adminClient
        .from('access_user_roles')
        .delete()
        .eq('user_id', userId)
        .neq('role_id', roleId);

      // Synchronisation du profil
      const legacyRole = isCanonicalAccessRoleKey(roleKey) ? roleKey : 'employe';
      const { error: profileError } = await adminClient
        .from('profiles')
        .update({ role: legacyRole, updated_at: new Date().toISOString() })
        .eq('id', userId);
      if (profileError) throw profileError;

      // Synchronisation des métadonnées de session Supabase Auth (compatibilité tokens)
      const { data: authUser, error: authReadError } = await adminClient.auth.admin.getUserById(userId);
      if (!authReadError && authUser?.user) {
        await adminClient.auth.admin.updateUserById(userId, {
          app_metadata: {
            ...(authUser.user.app_metadata || {}),
            role: roleKey,
            custom_role: roleKey,
            legacy_role: legacyRole,
          },
        });
      }
    }
  );
};

export const revokeAccessRoleHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const userId = singleParam(req.params['userId']);
  const roleId = singleParam(req.params['roleId']);
  const callerId = actorIdFromRequest(req);

  if (!isUuid(userId) || !isUuid(roleId)) {
    res.status(400).json({ error: 'Identifiants utilisateur et rôle invalides.' });
    return;
  }

  if (!callerId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  if (!isCallerAdmin(req)) {
    if (callerId === userId) {
      res.status(403).json({ error: 'Action refusée : vous ne pouvez pas révoquer votre propre rôle.' });
      return;
    }

    const adminClient = getSupabaseAdmin();
    if (!adminClient) {
      res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
      return;
    }

    const { data: targetRole } = await adminClient
      .from('access_roles')
      .select('role_key')
      .eq('id', roleId)
      .maybeSingle();

    if (targetRole?.role_key === 'admin' || await isTargetUserAdmin(adminClient, userId)) {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut révoquer un rôle administrateur.' });
      return;
    }
  }

  await runAccessMutation(req, res, 'user.role.revoke', { userId, roleId });
};

export const setUserPermissionOverrideHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const userId = singleParam(req.params['userId']);
  const callerId = actorIdFromRequest(req);

  if (!isUuid(userId)) {
    res.status(400).json({ error: 'Identifiant utilisateur invalide.' });
    return;
  }

  if (!callerId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  if (!isAccessScopeSupported(req.body?.scope)) {
    res.status(400).json({ error: 'Le périmètre doit être pris en charge par le serveur.' });
    return;
  }

  if (!isCallerAdmin(req)) {
    if (callerId === userId) {
      res.status(403).json({ error: 'Action refusée : vous ne pouvez pas définir d’exception sur votre propre compte.' });
      return;
    }
    if (isPrivilegedAccessPermission(req.body?.permissionKey)) {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut accorder ou modifier une permission de gestion des accès.' });
      return;
    }

    const adminClient = getSupabaseAdmin();
    if (!adminClient) {
      res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
      return;
    }
    if (await isTargetUserAdmin(adminClient, userId)) {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut modifier les exceptions d’un compte administrateur.' });
      return;
    }
  }

  await runAccessMutation(req, res, 'user.permission.override', {
    userId,
    permissionKey: req.body?.permissionKey,
    effect: req.body?.effect,
    scope: req.body?.scope,
    reason: req.body?.reason,
    expiresAt: req.body?.expiresAt,
  });
};

export const revokeUserPermissionOverrideHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const userId = singleParam(req.params['userId']);
  const overrideId = singleParam(req.params['overrideId']);
  const callerId = actorIdFromRequest(req);

  if (!isUuid(userId) || !isUuid(overrideId)) {
    res.status(400).json({ error: 'Identifiants utilisateur et exception invalides.' });
    return;
  }

  if (!callerId) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  if (!isCallerAdmin(req)) {
    if (callerId === userId) {
      res.status(403).json({ error: 'Action refusée : vous ne pouvez pas révoquer une exception sur votre propre compte.' });
      return;
    }

    const adminClient = getSupabaseAdmin();
    if (!adminClient) {
      res.status(503).json({ error: 'Le service d’autorisations est indisponible.' });
      return;
    }
    if (await isTargetUserAdmin(adminClient, userId)) {
      res.status(403).json({ error: 'Action refusée : seul un administrateur peut modifier les exceptions d’un compte administrateur.' });
      return;
    }
  }

  await runAccessMutation(req, res, 'user.permission.override.revoke', {
    userId,
    overrideId,
  });
};