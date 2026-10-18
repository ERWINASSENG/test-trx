import express from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { normalizeUserRole } from '../app/core/utils/role.utils';
import { UserRole } from '../app/core/models/auth.model';

let cachedAdminClient: {
  url: string;
  serviceRoleKey: string;
  client: SupabaseClient;
} | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env['SUPABASE_URL'] || '';
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] || '';
  if (!url || !serviceRoleKey) {
    return null;
  }

  if (cachedAdminClient?.url === url && cachedAdminClient.serviceRoleKey === serviceRoleKey) {
    return cachedAdminClient.client;
  }

  const client = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  cachedAdminClient = { url, serviceRoleKey, client };
  return client;
}

export const AUTH_TOKEN_CACHE_TTL_MS = 60_000;
export const SERVER_PROFILE_CACHE_TTL_MS = 60_000;

interface CachedUserLookup {
  result: Awaited<ReturnType<SupabaseClient['auth']['getUser']>>;
  cachedAt: number;
}

const verifiedTokenCache = new Map<string, CachedUserLookup>();

export const clearVerifiedTokenCache = (): void => {
  verifiedTokenCache.clear();
};

interface CachedServerProfile {
  profile: ServerUserProfile | null;
  cachedAt: number;
}

const serverProfileCache = new Map<string, CachedServerProfile>();

export const clearServerProfileCache = (userId?: string): void => {
  if (userId) {
    serverProfileCache.delete(userId);
  } else {
    serverProfileCache.clear();
  }
};

export async function updateExistingUserProfileRole(
  adminClient: SupabaseClient,
  userId: string,
  role: UserRole,
  email?: string | null
) {
  clearServerProfileCache(userId);
  const profileUpdates: { role: UserRole; email?: string; updated_at: string } = {
    role,
    updated_at: new Date().toISOString(),
  };
  if (email) profileUpdates.email = email;

  return adminClient.from('profiles').update(profileUpdates).eq('id', userId);
}

export interface ServerUserProfile {
  role: string;
  is_active: boolean;
}

export async function loadServerUserProfile(
  supabaseAdmin: SupabaseClient,
  userId: string,
  skipCache = false
): Promise<ServerUserProfile | null> {
  const now = Date.now();
  const cached = serverProfileCache.get(userId);
  if (!skipCache) {
    if (cached && now - cached.cachedAt < SERVER_PROFILE_CACHE_TTL_MS) {
      return cached.profile;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('role, is_active')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    // Si une erreur transitoire survient (ex. coupure réseau, timeout DB)
    // et qu'un profil valide était déjà en cache, on le préserve pour éviter
    // une déconnexion intempestive ou un faux 403.
    if (cached?.profile) {
      return cached.profile;
    }
    return null;
  }

  const profile = !data ? null : data;
  serverProfileCache.set(userId, { profile, cachedAt: now });
  return profile;
}

export const createInFlightTokenLookup = <T>(
  lookup: (token: string) => Promise<T>
): ((token: string) => Promise<T>) => {
  const requests = new Map<string, Promise<T>>();
  return (token) => {
    const pending = requests.get(token);
    if (pending) return pending;

    const request = lookup(token).finally(() => {
      if (requests.get(token) === request) requests.delete(token);
    });
    requests.set(token, request);
    return request;
  };
};

const rawLookupVerifiedUser = createInFlightTokenLookup((token: string) => {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) throw new Error('Service d’authentification indisponible.');
  return supabaseAdmin.auth.getUser(token);
});

export const lookupVerifiedUser = async (
  token: string,
  skipCache = false
): Promise<Awaited<ReturnType<SupabaseClient['auth']['getUser']>>> => {
  const now = Date.now();
  if (!skipCache) {
    const cached = verifiedTokenCache.get(token);
    if (cached && now - cached.cachedAt < AUTH_TOKEN_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const result = await rawLookupVerifiedUser(token);
  if (!result.error && result.data?.user) {
    verifiedTokenCache.set(token, { result, cachedAt: now });
  }
  return result;
};

const getAdminEmailsFromEnv = (): string[] => {
  return (process.env['ADMIN_EMAILS'] || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
};

const getBearerToken = (req: express.Request): string => {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader.replace('Bearer ', '');
};

export async function resolveServerRole(
  supabaseAdmin: SupabaseClient,
  user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> },
  preloadedProfile?: ServerUserProfile | null
): Promise<UserRole | null> {
  const profile = preloadedProfile === undefined
    ? await loadServerUserProfile(supabaseAdmin, user.id)
    : preloadedProfile;

  if (!profile || profile.is_active !== true) {
    return null;
  }

  const email = (user.email || '').toLowerCase().trim();
  if (email && getAdminEmailsFromEnv().includes(email)) {
    return 'admin';
  }

  return normalizeUserRole(profile.role);
}

export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({ error: 'Jeton d’authentification manquant dans l’en-tête Authorization' });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Service d’authentification indisponible : configuration serveur SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const { data, error } = await lookupVerifiedUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Jeton d’authentification invalide ou expiré' });
      return;
    }

    const user = data.user;
    const profile = await loadServerUserProfile(supabaseAdmin, user.id);
    const resolvedRole = await resolveServerRole(supabaseAdmin, user, profile);
    if (!resolvedRole) {
      res.status(403).json({ error: 'Compte inactif ou profil utilisateur indisponible.' });
      return;
    }

    (req as unknown as Record<string, unknown>)['user'] = {
      id: user.id,
      email: user.email,
      role: resolvedRole,
      app_metadata: user.app_metadata,
      user_metadata: user.user_metadata,
    };
    (req as unknown as Record<string, unknown>)['authProfile'] = profile;
    next();
  } catch (err: unknown) {
    console.error('Échec de la validation de session:', err);
    res.status(401).json({ error: 'Session invalide ou expirée.' });
  }
}

export function requireRole(allowedRoles: UserRole[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const user = (req as unknown as Record<string, unknown>)['user'] as { role?: UserRole; email?: string } | undefined;
    const userRole = user?.role;
    const isAllowed = userRole && (
      allowedRoles.includes(userRole) ||
      (userRole === 'tresorier' && allowedRoles.includes('manager'))
    );
    if (!isAllowed) {
      res.status(403).json({ error: 'Accès refusé. Privilèges insuffisants pour exécuter cette opération.' });
      return;
    }
    next();
  };
}

export async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const token = getBearerToken(req);

  if (!token) {
    res.status(401).json({ error: 'Accès non autorisé. Jeton de sécurité requis.' });
    return;
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Service d’administration indisponible : configuration serveur manquante' });
    return;
  }

  try {
    const { data: authData, error: authError } = await lookupVerifiedUser(token);
    const user = authData?.user;
    if (authError || !user) {
      res.status(401).json({ error: 'Session invalide ou expirée' });
      return;
    }

    const resolvedRole = await resolveServerRole(supabaseAdmin, user);
    if (resolvedRole !== 'admin') {
      res.status(403).json({
        error: `Accès refusé. Cette opération exige les privilèges administrateur (connecté en tant que: ${user.email || 'anonyme'}).`,
      });
      return;
    }

    const appRole = normalizeUserRole(user.app_metadata?.['role'] as string);
    if (appRole !== 'admin') {
      try {
        await supabaseAdmin.auth.admin.updateUserById(user.id, {
          app_metadata: { ...user.app_metadata, role: 'admin' },
        });
        const { error: profileUpdateError } = await updateExistingUserProfileRole(
          supabaseAdmin,
          user.id,
          'admin',
          user.email
        );
        if (profileUpdateError) {
          console.warn('Auto-réparation du profil admin échouée :', profileUpdateError.message);
        }
      } catch (syncErr) {
        console.warn('Auto-réparation du rôle admin (non-bloquante) :', syncErr);
      }
    }

    (req as unknown as Record<string, unknown>)['user'] = {
      id: user.id,
      email: user.email,
      role: 'admin',
      app_metadata: { ...user.app_metadata, role: 'admin' },
      user_metadata: user.user_metadata,
    };
    next();
  } catch {
    res.status(403).json({ error: 'Accès refusé. Rôle administrateur requis.' });
  }
}
