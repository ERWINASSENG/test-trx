import express from 'express';
import { getSupabaseAdmin } from './auth';

type AccessRoleAssignment = {
  created_at: string;
  expires_at: string | null;
  access_roles: { role_key: string; label: string; is_active: boolean } |
    { role_key: string; label: string; is_active: boolean }[] | null;
};

export function getActiveAccessRole(assignments: AccessRoleAssignment[], now = Date.now()): {
  customRole: string;
  roleLabel: string;
} | null {
  const activeAssignment = assignments
    .filter((assignment) => {
      const accessRole = Array.isArray(assignment.access_roles)
        ? assignment.access_roles[0]
        : assignment.access_roles;
      const expiresAt = assignment.expires_at ? Date.parse(assignment.expires_at) : Number.POSITIVE_INFINITY;
      return accessRole?.is_active === true && expiresAt > now;
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!activeAssignment) return null;

  const accessRole = Array.isArray(activeAssignment.access_roles)
    ? activeAssignment.access_roles[0]
    : activeAssignment.access_roles;
  return accessRole ? { customRole: accessRole.role_key, roleLabel: accessRole.label } : null;
}

export const getCurrentUserProfileHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const user = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
  const userId = user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Session utilisateur introuvable.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    const { data: profile, error } = await adminClient
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('Échec de lecture du profil utilisateur:', error.message);
      res.status(500).json({ error: 'Impossible de récupérer votre profil.' });
      return;
    }

    if (!profile) {
      res.status(404).json({ error: 'Profil utilisateur introuvable.' });
      return;
    }

    const { data: roleAssignmentsData, error: roleAssignmentsError } = await adminClient
      .from('access_user_roles')
      .select('created_at, expires_at, access_roles!inner(role_key, label, is_active)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (roleAssignmentsError) {
      console.error('Échec de lecture du rôle attribué à l’utilisateur:', roleAssignmentsError.message);
      res.status(500).json({ error: 'Impossible de récupérer le rôle attribué.' });
      return;
    }

    const now = Date.now();
    const activeAccessRole = getActiveAccessRole(
      (roleAssignmentsData || []) as AccessRoleAssignment[],
      now
    );

    res.json({
      profile,
      role: user.role || profile.role,
      customRole: activeAccessRole?.customRole || null,
      roleLabel: activeAccessRole?.roleLabel || null,
    });
  } catch (err: unknown) {
    console.error('Erreur getCurrentUserProfileHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la récupération du profil.' });
  }
};

export const updateCurrentUserProfileHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const user = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string } | undefined;
  const userId = user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Session utilisateur introuvable.' });
    return;
  }

  const { firstName, lastName, department, phone } = req.body;
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    const profileUpdates: Record<string, unknown> = {
      id: userId,
      updated_at: new Date().toISOString(),
    };

    if (firstName !== undefined) profileUpdates['first_name'] = firstName;
    if (lastName !== undefined) profileUpdates['last_name'] = lastName;
    if (department !== undefined) profileUpdates['department'] = department;
    if (phone !== undefined) profileUpdates['phone'] = phone;

    const { error: profileUpdateError } = await adminClient
      .from('profiles')
      .update(profileUpdates)
      .eq('id', userId)
      .select('id');

    if (profileUpdateError) {
      console.error('Échec de la mise à jour du profil utilisateur:', profileUpdateError.message);
      res.status(400).json({ error: 'Impossible de mettre à jour votre profil.' });
      return;
    }

    const authMeta: Record<string, unknown> = {};
    if (firstName !== undefined || lastName !== undefined) {
      authMeta['user_metadata'] = {
        first_name: firstName ?? undefined,
        last_name: lastName ?? undefined,
        display_name: `${firstName ?? ''} ${lastName ?? ''}`.trim(),
      };
    }

    if (Object.keys(authMeta).length > 0) {
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, authMeta);
      if (authUpdateError) {
        console.error('Échec de synchronisation auth.users:', authUpdateError.message);
        res.status(500).json({ error: 'Impossible de synchroniser vos informations de compte.' });
        return;
      }
    }

    res.json({ success: true, message: 'Profil mis à jour avec succès' });
  } catch (err: unknown) {
    console.error('Erreur updateCurrentUserProfileHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la mise à jour de votre profil.' });
  }
};
