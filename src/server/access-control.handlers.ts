import express from 'express';
import { isAccessScopeSupported, resolveEffectivePermissions } from './access-control';
import { getSupabaseAdmin } from './auth';

const actorIdFromRequest = (req: express.Request): string | null => {
  const user = (req as unknown as Record<string, unknown>)['user'] as { id?: string } | undefined;
  return user?.id || null;
};

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
  payload: Record<string, unknown>
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

    if (error) {
      sendMutationError(res, error);
      return;
    }

    res.status(200).json({ success: true, data });
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
    const permissions = await resolveEffectivePermissions(userId);
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
    .select('id, email, first_name, last_name, role, is_active')
    .order('last_name', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('Impossible de lire les utilisateurs pour le contrôle d’accès:', error.message);
    res.status(500).json({ error: 'Impossible de charger la liste des utilisateurs.' });
    return;
  }

  res.json({ users: data || [] });
};

export const getRolePermissionsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const roleId = req.params['roleId'];
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
  const userId = req.params['userId'];
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
  if (typeof subjectUserId === 'string' && subjectUserId) {
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

export const updateAccessRoleHandler = (req: express.Request, res: express.Response): Promise<void> =>
  runAccessMutation(req, res, 'role.update', {
    roleId: req.params['roleId'],
    label: req.body?.label,
    description: req.body?.description,
    isActive: req.body?.isActive,
  });

export const deleteAccessRoleHandler = (req: express.Request, res: express.Response): Promise<void> =>
  runAccessMutation(req, res, 'role.delete', { roleId: req.params['roleId'] });

export const replaceRolePermissionsHandler = (req: express.Request, res: express.Response): Promise<void> => {
  const grants = req.body?.grants;
  if (!Array.isArray(grants) || grants.some((grant: Record<string, unknown>) => !isAccessScopeSupported(grant['scope']))) {
    res.status(400).json({ error: 'Chaque permission doit utiliser un périmètre pris en charge par le serveur.' });
    return Promise.resolve();
  }

  return runAccessMutation(req, res, 'role.permissions.replace', {
    roleId: req.params['roleId'],
    grants: grants.map((grant: Record<string, unknown>) => ({
      permissionKey: grant['permissionKey'],
      scope: grant['scope'],
    })),
  });
};

export const assignAccessRoleHandler = (req: express.Request, res: express.Response): Promise<void> =>
  runAccessMutation(req, res, 'user.role.assign', {
    userId: req.params['userId'],
    roleId: req.body?.roleId,
    expiresAt: req.body?.expiresAt,
  });

export const revokeAccessRoleHandler = (req: express.Request, res: express.Response): Promise<void> =>
  runAccessMutation(req, res, 'user.role.revoke', {
    userId: req.params['userId'],
    roleId: req.params['roleId'],
  });

export const setUserPermissionOverrideHandler = (req: express.Request, res: express.Response): Promise<void> => {
  if (!isAccessScopeSupported(req.body?.scope)) {
    res.status(400).json({ error: 'Le périmètre doit être pris en charge par le serveur.' });
    return Promise.resolve();
  }

  return runAccessMutation(req, res, 'user.permission.override', {
    userId: req.params['userId'],
    permissionKey: req.body?.permissionKey,
    effect: req.body?.effect,
    scope: req.body?.scope,
    reason: req.body?.reason,
    expiresAt: req.body?.expiresAt,
  });
};

export const revokeUserPermissionOverrideHandler = (req: express.Request, res: express.Response): Promise<void> =>
  runAccessMutation(req, res, 'user.permission.override.revoke', {
    userId: req.params['userId'],
    overrideId: req.params['overrideId'],
  });