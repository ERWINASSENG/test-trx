import express from 'express';
import { normalizeUserRole } from '../app/core/utils/role.utils';
import { getSupabaseAdmin } from './auth';

export const updateCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const rawUserId = req.params['id'];
  const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
  if (!userId) {
    res.status(400).json({ error: 'Identifiant collaborateur requis' });
    return;
  }

  const { firstName, lastName, role, department, phone, isActive } = req.body;
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    let userEmail: string | undefined;
    const { data: authUserData } = await adminClient.auth.admin.getUserById(userId);
    if (authUserData?.user?.email) userEmail = authUserData.user.email;

    const profileUpdates: Record<string, unknown> = {
      id: userId,
      updated_at: new Date().toISOString(),
    };
    if (userEmail) profileUpdates['email'] = userEmail;
    if (firstName !== undefined) profileUpdates['first_name'] = firstName;
    if (lastName !== undefined) profileUpdates['last_name'] = lastName;
    if (role !== undefined) profileUpdates['role'] = normalizeUserRole(role);
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

    const authUpdates: Record<string, unknown> = {};
    if (role !== undefined) authUpdates['app_metadata'] = { role: normalizeUserRole(role) };
    if (firstName !== undefined || lastName !== undefined) {
      authUpdates['user_metadata'] = {
        first_name: firstName,
        last_name: lastName,
        display_name: `${firstName || ''} ${lastName || ''}`.trim(),
      };
    }
    if (Object.keys(authUpdates).length > 0) {
      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, authUpdates);
      if (authUpdateError) {
        console.error('Échec mise à jour auth.users:', authUpdateError.message);
        res.status(500).json({ error: 'Impossible de synchroniser les autorisations du collaborateur.' });
        return;
      }
    }

    res.json({ success: true, message: 'Collaborateur mis à jour avec succès' });
  } catch (err: unknown) {
    console.error('Erreur updateCollaboratorHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la mise à jour du collaborateur.' });
  }
};

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
    const { error: authDeleteError } = await adminClient.auth.admin.deleteUser(userId);
    if (authDeleteError) {
      console.error('Échec suppression auth.users:', authDeleteError.message);
      res.status(500).json({ error: 'Impossible de supprimer le compte d’accès du collaborateur.' });
      return;
    }

    const { error: profileDeleteError } = await adminClient.from('profiles').delete().eq('id', userId);
    if (profileDeleteError) {
      console.error('Échec suppression public.profiles:', profileDeleteError.message);
      res.status(500).json({ error: 'Impossible de supprimer le profil du collaborateur.' });
      return;
    }

    res.json({ success: true, message: 'Compte collaborateur supprimé avec succès' });
  } catch (err: unknown) {
    console.error('Erreur deleteCollaboratorHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la suppression du collaborateur.' });
  }
};
