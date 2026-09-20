import express from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { normalizeUserRole } from '../app/core/utils/role.utils';
import { UserRole } from '../app/core/models/auth.model';

export function getSupabaseAdmin(): SupabaseClient | null {
  const url = process.env['SUPABASE_URL'] || '';
  const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'] || '';
  if (!url || !serviceRoleKey) {
    return null;
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

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
  user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> }
): Promise<UserRole> {
  const email = (user.email || '').toLowerCase().trim();
  if (email && getAdminEmailsFromEnv().includes(email)) {
    return 'admin';
  }

  const appRole = normalizeUserRole(user.app_metadata?.['role'] as string);
  if (appRole !== 'employe') {
    return appRole;
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  return profile?.role ? normalizeUserRole(profile.role) : 'employe';
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
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({ error: 'Jeton d’authentification invalide ou expiré' });
      return;
    }

    const user = data.user;
    const resolvedRole = await resolveServerRole(supabaseAdmin, user);
    (req as unknown as Record<string, unknown>)['user'] = {
      id: user.id,
      email: user.email,
      role: resolvedRole,
      app_metadata: user.app_metadata,
      user_metadata: user.user_metadata,
    };
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
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
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
        await supabaseAdmin.from('profiles').upsert(
          {
            id: user.id,
            email: user.email,
            role: 'admin',
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        );
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
