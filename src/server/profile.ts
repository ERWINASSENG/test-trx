import express from 'express';
import { getSupabaseAdmin } from './auth';

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
