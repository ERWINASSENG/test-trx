import express from 'express';
import { clearServerProfileCache, getSupabaseAdmin } from './auth';
import { BoundedCache } from './cache.utils';

interface AccessRoleAssignment {
  created_at: string;
  expires_at: string | null;
  access_roles: { role_key: string; label: string; is_active: boolean } |
    { role_key: string; label: string; is_active: boolean }[] | null;
}

export const USER_PROFILE_RESPONSE_CACHE_TTL_MS = 60_000;

interface CachedProfilePayload {
  profile: Record<string, unknown>;
  customRole: string | null;
  roleLabel: string | null;
  cachedAt: number;
}

// Cache borné LRU (règle S11 : taille max 500 pour protection anti-DoS OOM)
const profilePayloadCache = new BoundedCache<string, CachedProfilePayload>({
  maxSize: 500,
  defaultTtlMs: USER_PROFILE_RESPONSE_CACHE_TTL_MS,
});
const inFlightProfileLoads = new Map<string, Promise<CachedProfilePayload | null>>();

export const clearUserProfileResponseCache = (userId?: string): void => {
  if (userId) {
    profilePayloadCache.delete(userId);
    inFlightProfileLoads.delete(userId);
  } else {
    profilePayloadCache.clear();
    inFlightProfileLoads.clear();
  }
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
    const cached = profilePayloadCache.get(userId);
    if (cached) {
      const effectiveRole = user.role === 'admin'
        ? 'admin'
        : (cached.customRole || user.role || (cached.profile['role'] as string) || 'employe');

      res.json({
        profile: {
          ...cached.profile,
          role: effectiveRole,
        },
        role: effectiveRole,
        customRole: cached.customRole,
        roleLabel: cached.roleLabel,
      });
      return;
    }

    let pending = inFlightProfileLoads.get(userId);
    if (!pending) {
      pending = (async (): Promise<CachedProfilePayload | null> => {
        const [profileResult, roleAssignmentsResult] = await Promise.all([
          adminClient
            .from('profiles')
            .select('id, email, first_name, last_name, role, department, phone, avatar_url, is_active, must_change_password, user_code, last_login_at, created_at, updated_at')
            .eq('id', userId)
            .maybeSingle(),
          adminClient
            .from('access_user_roles')
            .select('created_at, expires_at, access_roles!inner(role_key, label, is_active)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false }),
        ]);

        if (profileResult.error) {
          throw new Error(`PROFILE_READ_ERROR:${profileResult.error.message}`);
        }
        if (roleAssignmentsResult.error) {
          throw new Error(`ROLE_READ_ERROR:${roleAssignmentsResult.error.message}`);
        }
        if (!profileResult.data) {
          return null;
        }

        const activeAccessRole = getActiveAccessRole(
          (roleAssignmentsResult.data || []) as AccessRoleAssignment[],
          Date.now()
        );

        const entry: CachedProfilePayload = {
          profile: profileResult.data as Record<string, unknown>,
          customRole: activeAccessRole?.customRole || null,
          roleLabel: activeAccessRole?.roleLabel || null,
          cachedAt: Date.now(),
        };
        profilePayloadCache.set(userId, entry, USER_PROFILE_RESPONSE_CACHE_TTL_MS);
        return entry;
      })().finally(() => {
        inFlightProfileLoads.delete(userId);
      });
      inFlightProfileLoads.set(userId, pending);
    }

    const loaded = await pending;
    if (!loaded) {
      res.status(404).json({ error: 'Profil utilisateur introuvable.' });
      return;
    }

    const effectiveRole = user.role === 'admin'
      ? 'admin'
      : (loaded.customRole || user.role || (loaded.profile['role'] as string) || 'employe');

    res.json({
      profile: {
        ...loaded.profile,
        role: effectiveRole,
      },
      role: effectiveRole,
      customRole: loaded.customRole,
      roleLabel: loaded.roleLabel,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('PROFILE_READ_ERROR:')) {
      console.error('Échec de lecture du profil utilisateur:', message);
      res.status(500).json({ error: 'Impossible de récupérer votre profil.' });
      return;
    }
    if (message.startsWith('ROLE_READ_ERROR:')) {
      console.error('Échec de lecture du rôle attribué à l’utilisateur:', message);
      res.status(500).json({ error: 'Impossible de récupérer le rôle attribué.' });
      return;
    }
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

  const payload = req.body || {};
  const { firstName, lastName, department, phone } = payload;
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  // Règle S3 : Validation stricte des entrées et typage explicite
  const profileUpdates: Record<string, unknown> = {
    id: userId,
    updated_at: new Date().toISOString(),
  };

  let hasUpdates = false;

  if (firstName !== undefined) {
    if (typeof firstName !== 'string' || firstName.length > 100) {
      res.status(400).json({ error: 'Le prénom est invalide (maximum 100 caractères).' });
      return;
    }
    profileUpdates['first_name'] = firstName.trim();
    hasUpdates = true;
  }

  if (lastName !== undefined) {
    if (typeof lastName !== 'string' || lastName.length > 100) {
      res.status(400).json({ error: 'Le nom est invalide (maximum 100 caractères).' });
      return;
    }
    profileUpdates['last_name'] = lastName.trim();
    hasUpdates = true;
  }

  if (department !== undefined) {
    if (typeof department !== 'string' || department.length > 100) {
      res.status(400).json({ error: 'Le département est invalide (maximum 100 caractères).' });
      return;
    }
    profileUpdates['department'] = department.trim();
    hasUpdates = true;
  }

  if (phone !== undefined) {
    if (typeof phone !== 'string' || phone.length > 40) {
      res.status(400).json({ error: 'Le numéro de téléphone est invalide (maximum 40 caractères).' });
      return;
    }
    profileUpdates['phone'] = phone.trim();
    hasUpdates = true;
  }

  if (!hasUpdates) {
    res.status(400).json({ error: 'Aucun champ valide à mettre à jour fourni.' });
    return;
  }

  try {
    clearUserProfileResponseCache(userId);
    clearServerProfileCache(userId);

    const { data: updatedProfile, error: profileUpdateError } = await adminClient
      .from('profiles')
      .update(profileUpdates)
      .eq('id', userId)
      .select('id, first_name, last_name, phone')
      .maybeSingle();

    if (profileUpdateError) {
      console.error('Échec de la mise à jour du profil utilisateur:', profileUpdateError.message);
      res.status(400).json({ error: 'Impossible de mettre à jour votre profil.' });
      return;
    }

    if (firstName !== undefined || lastName !== undefined || phone !== undefined) {
      const { data: existingUser } = await adminClient.auth.admin.getUserById(userId);
      const currentMeta = (existingUser?.user?.user_metadata as Record<string, unknown> | undefined) || {};
      const resolvedFirstName = typeof updatedProfile?.first_name === 'string'
        ? updatedProfile.first_name
        : (firstName !== undefined ? String(profileUpdates['first_name'] ?? '') : String(currentMeta['first_name'] ?? ''));
      const resolvedLastName = typeof updatedProfile?.last_name === 'string'
        ? updatedProfile.last_name
        : (lastName !== undefined ? String(profileUpdates['last_name'] ?? '') : String(currentMeta['last_name'] ?? ''));
      const resolvedPhone = updatedProfile?.phone !== undefined
        ? updatedProfile.phone
        : (phone !== undefined ? String(profileUpdates['phone'] ?? '') : currentMeta['phone']);

      const authMeta: Record<string, unknown> = {
        user_metadata: {
          ...currentMeta,
          first_name: resolvedFirstName,
          last_name: resolvedLastName,
          display_name: `${resolvedFirstName} ${resolvedLastName}`.trim(),
          ...(resolvedPhone !== undefined ? { phone: resolvedPhone } : {}),
        },
      };

      const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(userId, authMeta);
      if (authUpdateError) {
        console.error('Échec de synchronisation auth.users:', authUpdateError.message);
        res.status(500).json({ error: 'Impossible de synchroniser vos informations de compte.' });
        return;
      }
    }

    clearUserProfileResponseCache(userId);
    res.json({ success: true, message: 'Profil mis à jour avec succès' });
  } catch (err: unknown) {
    console.error('Erreur updateCurrentUserProfileHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la mise à jour de votre profil.' });
  }
};
