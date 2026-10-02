import express from 'express';
import { normalizeUserRole } from '../app/core/utils/role.utils';
import { getSupabaseAdmin } from './auth';
import { syncUserAccessRole } from './access-role-sync';

/**
 * Modification d'un compte collaborateur (PATCH /api/collaborators/:id & /api/users/:id)
 * 
 * Correction P0 #2 :
 * Ordre de mutation cohérent avec la base PostgreSQL comme source de vérité :
 * 1. Synchronisation transactionnelle PostgreSQL (access_user_roles + profiles.role via syncUserAccessRole).
 * 2. Mise à jour des informations de profil complémentaires.
 * 3. Répercussion dans auth.app_metadata et user_metadata.
 */
export const updateCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const rawUserId = req.params['id'];
  const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
  if (!userId) {
    res.status(400).json({ error: 'Identifiant collaborateur requis' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
  const callerId = authenticatedUser?.id || null;

  const { firstName, lastName, role, department, phone, isActive } = req.body;
  const normalizedRole = role !== undefined ? normalizeUserRole(role) : undefined;
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    // 1. Récupération de l'email pour garantir l'intégrité du profil
    let userEmail: string | undefined;
    const { data: authUserData } = await adminClient.auth.admin.getUserById(userId);
    if (authUserData?.user?.email) userEmail = authUserData.user.email;

    // 2. Synchronisation prioritaire et atomique du rôle dans PostgreSQL si modifié
    if (normalizedRole !== undefined) {
      await syncUserAccessRole(adminClient, userId, normalizedRole, callerId, 'admin');
    }

    // 3. Mise à jour des champs complémentaires du profil
    const profileUpdates: Record<string, unknown> = {
      id: userId,
      updated_at: new Date().toISOString(),
    };
    if (userEmail) profileUpdates['email'] = userEmail;
    if (firstName !== undefined) profileUpdates['first_name'] = firstName;
    if (lastName !== undefined) profileUpdates['last_name'] = lastName;
    if (normalizedRole !== undefined) profileUpdates['role'] = normalizedRole;
    if (department !== undefined) profileUpdates['department'] = department;
    if (phone !== undefined) profileUpdates['phone'] = phone;
    if (isActive !== undefined) profileUpdates['is_active'] = isActive;

    const { error: profileUpdateError } = await adminClient
      .from('profiles')
      .upsert(profileUpdates, { onConflict: 'id' });

    if (profileUpdateError) {
      console.error('Échec de la mise à jour public.profiles:', profileUpdateError.message);
      res.status(500).json({ error: 'Impossible de mettre à jour le profil du collaborateur.' });
      return;
    }

    // 4. Synchronisation secondaire dans Auth (app_metadata et user_metadata)
    const authUpdates: Record<string, unknown> = {};
    if (normalizedRole !== undefined) {
      const existingAppMeta = authUserData?.user?.app_metadata || {};
      authUpdates['app_metadata'] = { ...existingAppMeta, role: normalizedRole };
    }
    if (firstName !== undefined || lastName !== undefined) {
      const existingUserMeta = authUserData?.user?.user_metadata || {};
      authUpdates['user_metadata'] = {
        ...existingUserMeta,
        first_name: firstName !== undefined ? firstName : existingUserMeta['first_name'],
        last_name: lastName !== undefined ? lastName : existingUserMeta['last_name'],
        display_name: `${firstName || ''} ${lastName || ''}`.trim() || existingUserMeta['display_name'],
      };
    }
    if (Object.keys(authUpdates).length > 0) {
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, authUpdates);
      if (authUpdateError) {
        console.warn('Avertissement : synchronisation partielle auth.users après succès DB:', authUpdateError.message);
      }
    }

    res.json({ success: true, message: 'Collaborateur mis à jour avec succès' });
  } catch (err: unknown) {
    console.error('Erreur updateCollaboratorHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la mise à jour du collaborateur.' });
  }
};

/**
 * Suppression d'un compte collaborateur (DELETE /api/collaborators/:id & /api/users/:id)
 */
export const deleteCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const rawUserId = req.params['id'];
  const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
  if (!userId) {
    res.status(400).json({ error: 'Identifiant collaborateur requis' });
    return;
  }

  const currentAdminUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string } | undefined;
  if (currentAdminUser?.id && currentAdminUser.id === userId) {
    res.status(400).json({ error: 'Action refusée : vous ne pouvez pas supprimer votre propre compte administrateur.' });
    return;
  }

  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    // 1. Suppression dans auth.users
    const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(userId);
    if (authDeleteError) {
      console.error('Échec suppression auth.users:', authDeleteError.message);
      res.status(500).json({ error: 'Impossible de supprimer le compte d’accès du collaborateur.' });
      return;
    }

    // 2. Nettoyage de sécurité dans profiles et access_user_roles (en cascade ou explicite)
    await adminClient.from('access_user_roles').delete().eq('user_id', userId);
    await adminClient.from('profiles').delete().eq('id', userId);

    res.json({ success: true, message: 'Compte collaborateur supprimé avec succès' });
  } catch (err: unknown) {
    console.error('Erreur deleteCollaboratorHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la suppression du collaborateur.' });
  }
};
