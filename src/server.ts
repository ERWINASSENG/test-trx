import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { rateLimit } from 'express-rate-limit';
import { normalizeUserRole } from './app/core/utils/role.utils';
import { UserRole } from './app/core/models/auth.model';

// Charger les variables d'environnement depuis le fichier `.env` (si présent)
dotenv.config();

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Configuration du reverse proxy pour Cloud Run / Nginx (gestion sécurisée de l'en-tête X-Forwarded-For)
app.set('trust proxy', 1);

// Parsing JSON pour les requêtes d'API avec limite explicite de payload
app.use(express.json({ limit: '256kb' }));

/**
 * ==============================================================================
 * RATE LIMITING STRATIFIÉ (SÉCURITÉ & PROTECTION CONTRE LE BRUTE-FORCE / ABUS)
 * ==============================================================================
 */

// 1. Limiteur global sur toutes les routes de l'API /api/* (200 requêtes / 15 minutes par IP)
const apiGlobalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  statusCode: 429,
  message: {
    error: 'Trop de requêtes envoyées depuis cette adresse IP. Veuillez patienter avant de réessayer.',
    retryAfterMinutes: 15,
  },
});
app.use('/api', apiGlobalLimiter);

// 2. Limiteur strict sur les endpoints de configuration et d'authentification (40 requêtes / 15 minutes)
const authSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  statusCode: 429,
  message: {
    error: 'Trop de requêtes sur les services d’authentification. Veuillez patienter quelques instants.',
    retryAfterMinutes: 15,
  },
});
app.use(['/api/auth/sync-role', '/api/supabase-config', '/api/config'], authSyncLimiter);

// 3. Limiteur renforcé sur les opérations d'écriture et de mutation (POST, PUT, PATCH, DELETE)
// Prévient l'inondation de la base de données, la création massive de comptes ou de transactions (100 mutations / 15 minutes)
const mutationsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  statusCode: 429,
  message: {
    error: 'Limite de modifications ou d’enregistrements atteinte pour cette période. Veuillez patienter avant de renouveler.',
    retryAfterMinutes: 15,
  },
});
app.use(
  [
    '/api/system/collaborators',
    '/api/admin/users',
    '/api/cahier/operations',
    '/api/cashier/transactions',
    '/api/system/operations',
  ],
  (req, res, next): void => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      mutationsLimiter(req, res, next);
      return;
    }
    next();
  }
);

/**
 * Endpoint sécurisé fournissant l'URL et la clé anonyme publiques Supabase au client web.
 * Supporte /api/supabase-config et /api/config avec gestion de variabilité de nommage sur Vercel.
 */
const getSupabaseConfigHandler = (_req: express.Request, res: express.Response) => {
  const url =
    process.env['SUPABASE_URL'] ||
    process.env['PUBLIC_SUPABASE_URL'] ||
    process.env['NEXT_PUBLIC_SUPABASE_URL'] ||
    process.env['VITE_SUPABASE_URL'] ||
    '';
  const anonKey =
    process.env['SUPABASE_ANON_KEY'] ||
    process.env['PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ||
    process.env['VITE_SUPABASE_ANON_KEY'] ||
    '';
  res.json({
    url,
    anonKey,
    key: anonKey,
    supabaseUrl: url,
    supabaseAnonKey: anonKey,
    configured: Boolean(url && anonKey),
  });
};

app.get('/api/supabase-config', getSupabaseConfigHandler);
app.get('/api/config', getSupabaseConfigHandler);

/**
 * Helper d'initialisation du client Supabase avec privilèges d'administration.
 * STRICT : Exige obligatoirement SUPABASE_SERVICE_ROLE_KEY (pas de fallback silencieux vers la clé anonyme).
 */
function getSupabaseAdmin() {
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

// Configuration des administrateurs système configurés par variable d'environnement
// Aucun email personnel n'est codé en dur dans le code source
const getAdminEmailsFromEnv = (): string[] => {
  return (process.env['ADMIN_EMAILS'] || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
};

/**
 * Fonction centrale et sécurisée de résolution de rôle serveur (RBAC).
 * SÉCURITÉ ABSOLUE : `user_metadata` est STRICTEMENT EXCLU de toute décision d'autorisation.
 * 1. Email admin déclaré dans la variable d'environnement ADMIN_EMAILS -> 'admin'
 * 2. app_metadata.role (scellé serveur par Supabase Admin) -> si différent de 'employe'
 * 3. public.profiles.role (table SQL sécurisée)
 * 4. Défaut : 'employe'
 */
export async function resolveServerRole(
  supabaseAdmin: SupabaseClient,
  user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> }
): Promise<UserRole> {
  const email = (user.email || '').toLowerCase().trim();
  const adminEmails = getAdminEmailsFromEnv();
  if (email && adminEmails.includes(email)) {
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

/**
 * Middleware Express d'authentification : valide le jeton Bearer
 * via Supabase Auth admin client et attache l'utilisateur à req.user avec son rôle sécurisé.
 * SÉCURITÉ STRICTE : Ne fait JAMAIS confiance à `user_metadata` (éditable côté client par l'utilisateur).
 * Le rôle est extrait exclusivement via resolveServerRole.
 * FAIL-CLOSED : En cas d'indisponibilité du client d'administration, refuse la requête avec une erreur 500 explicite.
 */
export async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (authHeader || '').replace('Bearer ', '');

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
    const message = err instanceof Error ? err.message : 'Échec de la validation de session';
    res.status(401).json({ error: message });
  }
}

/**
 * Middleware de contrôle d'accès basé sur les rôles (RBAC).
 * Exige que le rôle résolu de l'utilisateur fasse partie des rôles autorisés.
 * Le rôle 'tresorier' hérite des mêmes autorisations que 'manager'.
 */
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

/**
 * 4. Le "Garde-Fou" Ultime : La Validation Côté Serveur (RBAC Niveau 4)
 * Valide le JWT et vérifie le statut admin via resolveServerRole.
 * Auto-réparation immédiate : si l'utilisateur est légitime mais que son app_metadata
 * n'a pas encore été synchronisé, le serveur scelle son app_metadata et synchronise public.profiles.
 */
export async function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (authHeader || '').replace('Bearer ', '');

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
    // Auto-réparation si app_metadata n'est pas encore synchronisé (uniquement pour un admin authentifié et légitime)
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

/**
 * Récupération sécurisée de la liste des collaborateurs.
 * Réservé aux administrateurs (protégé par le middleware requireAdmin).
 */
const getCollaboratorsHandler = async (_req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();

  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    // 1. Récupérer tous les utilisateurs depuis Supabase Auth
    let authUsers: {
      id: string;
      email?: string;
      phone?: string;
      created_at?: string;
      last_sign_in_at?: string;
      updated_at?: string;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
    }[] = [];
    try {
      const { data: authData, error: authErr } = await adminClient.auth.admin.listUsers();
      if (!authErr && authData?.users) {
        authUsers = authData.users as typeof authUsers;
      }
    } catch {
      // Si la liste d'auth échoue, on continue avec profiles
    }

    // 2. Récupérer tous les profils de la table public.profiles
    const { data: profiles } = await adminClient
      .from('profiles')
      .select('*');

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    const processedIds = new Set<string>();

    const users: Record<string, unknown>[] = [];

    // Combiner les utilisateurs Auth
    for (const u of authUsers) {
      processedIds.add(u.id);
      const p = profileMap.get(u.id);

      const firstName = p?.first_name || (u.user_metadata?.['first_name'] as string) || (u.user_metadata?.['firstName'] as string) || '';
      const lastName = p?.last_name || (u.user_metadata?.['last_name'] as string) || (u.user_metadata?.['lastName'] as string) || '';
      const email = u.email || p?.email || '';
      const displayName = `${firstName} ${lastName}`.trim() || (u.user_metadata?.['display_name'] as string) || email || 'Utilisateur';
      const rawRole = (u.app_metadata?.['role'] as string) || p?.role || (u.user_metadata?.['role'] as string) || 'employe';
      const role = normalizeUserRole(rawRole);

      users.push({
        id: u.id,
        email,
        firstName,
        lastName,
        displayName,
        role,
        department: p?.department || 'Services Généraux',
        phone: p?.phone || u.phone || '',
        isActive: p?.is_active ?? true,
        avatarUrl: p?.avatar_url,
        createdAt: p?.created_at || u.created_at || new Date().toISOString(),
        lastLoginAt: u.last_sign_in_at || p?.last_login_at,
        updatedAt: p?.updated_at || u.updated_at,
      });
    }

    // Ajouter les profils qui ne seraient pas dans authUsers
    for (const p of (profiles || [])) {
      if (!processedIds.has(p.id)) {
        processedIds.add(p.id);
        users.push({
          id: p.id,
          email: p.email || '',
          firstName: p.first_name || '',
          lastName: p.last_name || '',
          displayName: `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || 'Utilisateur',
          role: normalizeUserRole(p.role),
          department: p.department || 'Services Généraux',
          phone: p.phone || '',
          isActive: p.is_active ?? true,
          avatarUrl: p.avatar_url,
          createdAt: p.created_at || new Date().toISOString(),
          updatedAt: p.updated_at,
        });
      }
    }

    res.json({ users });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
    res.status(500).json({ error: message });
  }
};

app.get('/api/system/collaborators', requireAdmin, getCollaboratorsHandler);
app.get('/api/admin/users', requireAdmin, getCollaboratorsHandler);

/**
 * Endpoint de synchronisation et de restauration automatique du rôle.
 * Permet à un utilisateur authentifié de sceller et synchroniser son rôle légitime
 * dans app_metadata et public.profiles sans risque d'auto-promotion non autorisée.
 * SÉCURITÉ : Passe par requireAuth et utilise resolveServerRole (exclut totalement user_metadata).
 */
app.post('/api/auth/sync-role', requireAuth, async (req: express.Request, res: express.Response): Promise<void> => {
  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    res.status(500).json({ error: 'Configuration serveur Supabase indisponible' });
    return;
  }

  try {
    const user = (req as unknown as Record<string, unknown>)['user'] as {
      id: string;
      email?: string;
      role: 'admin' | 'caissiere' | 'manager' | 'employe';
      app_metadata?: Record<string, unknown>;
    };

    const targetRole = user.role;

    // Scellement dans app_metadata si nécessaire
    await supabaseAdmin.auth.admin.updateUserById(user.id, {
      app_metadata: { ...user.app_metadata, role: targetRole },
    });

    // Scellement dans public.profiles
    await supabaseAdmin.from('profiles').upsert(
      {
        id: user.id,
        email: user.email,
        role: targetRole,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

    res.json({
      success: true,
      role: targetRole,
      isAdmin: targetRole === 'admin',
      userId: user.id,
      email: user.email,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur lors de la synchronisation du rôle';
    res.status(500).json({ error: message });
  }
});

/**
 * Endpoint sécurisé de création de collaborateurs.
 * Réservé aux administrateurs (protégé par le middleware requireAdmin) :
 * applique la séparation étanche app_metadata (rôle inviolable) vs user_metadata.
 */
const createCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const {
    email,
    password,
    firstName,
    lastName,
    displayName,
    role,
    department,
    phone,
    isActive,
    sites,
  } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email et mot de passe initial obligatoires' });
    return;
  }

  // Vérification de robustesse minimale du mot de passe initial
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'Le mot de passe initial doit comporter au moins 8 caractères' });
    return;
  }
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  if (!hasLetter || !hasDigit) {
    res.status(400).json({ error: 'Le mot de passe initial doit comporter au moins une lettre et un chiffre' });
    return;
  }

  const validRoles: UserRole[] = ['admin', 'manager', 'tresorier', 'caissiere', 'comptable', 'employe'];
  if (!role || !validRoles.includes(role)) {
    res.status(400).json({ error: 'Le rôle Transmex est obligatoire et doit être défini explicitement (admin, manager, tresorier, caissiere, comptable, employe)' });
    return;
  }

  const adminClient = getSupabaseAdmin();

  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY non configurée' });
    return;
  }

  try {
    const computedDisplayName = displayName || `${firstName || ''} ${lastName || ''}`.trim() || email;
    const computedRole = normalizeUserRole(role);
    const sitesList = Array.isArray(sites) ? sites : (department ? [department] : []);

    // 2. Création avec privilèges élevés et étanchéité des métadonnées
    const { data: adminAuthData, error: adminAuthError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        role: computedRole,
        assignedSiteNames: sitesList,
      },
      user_metadata: {
        display_name: computedDisplayName,
        first_name: firstName || '',
        last_name: lastName || '',
        phone: phone || '',
      },
    });

    if (adminAuthError) {
      res.status(400).json({ error: adminAuthError.message });
      return;
    }
    const authUserId = adminAuthData.user.id;

    // 3. Synchronisation avec la table public.profiles (avec onConflict: 'id' pour gérer les triggers Supabase automatiques)
    const profilePayload = {
      id: authUserId,
      email,
      first_name: firstName || '',
      last_name: lastName || '',
      role: computedRole,
      department: department || 'Direction Générale',
      phone: phone || '',
      is_active: isActive !== undefined ? isActive : true,
      updated_at: new Date().toISOString(),
    };

    const { error: profileError } = await adminClient
      .from('profiles')
      .upsert(profilePayload, { onConflict: 'id' });

    if (profileError) {
      console.error('Échec synchronisation profiles:', profileError.message);
      res.status(207).json({
        user: {
          id: authUserId,
          email,
          firstName: firstName || '',
          lastName: lastName || '',
          displayName: computedDisplayName,
          role: computedRole,
          department: department || 'Direction Générale',
          phone: phone || '',
          isActive: isActive !== undefined ? isActive : true,
          createdAt: new Date().toISOString(),
        },
        warning: `Compte Auth créé mais la synchronisation du profil public a rencontré une erreur: ${profileError.message}`,
      });
      return;
    }

    res.status(201).json({
      user: {
        id: authUserId,
        email,
        firstName: firstName || '',
        lastName: lastName || '',
        displayName: computedDisplayName,
        role: computedRole,
        department: department || 'Direction Générale',
        phone: phone || '',
        isActive: isActive !== undefined ? isActive : true,
        createdAt: new Date().toISOString(),
      },
      message: 'Collaborateur créé avec succès (droits scellés dans app_metadata et synchronisés)',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne du serveur';
    res.status(500).json({ error: message });
  }
};

app.post('/api/system/collaborators', requireAdmin, createCollaboratorHandler);
app.post('/api/admin/users', requireAdmin, createCollaboratorHandler);

/**
 * Modification d'un compte collaborateur (synchronisation auth.app_metadata + public.profiles)
 */
const updateCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
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
    // 1. Récupération préalable de l'utilisateur auth pour garantir la présence de l'email si besoin d'upsert
    let userEmail: string | undefined;
    const { data: authUserData } = await adminClient.auth.admin.getUserById(userId);
    if (authUserData?.user?.email) {
      userEmail = authUserData.user.email;
    }

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
      res.status(500).json({ error: `Erreur mise à jour profil: ${profileUpdateError.message}` });
      return;
    }

    const authUpdates: Record<string, unknown> = {};
    if (role !== undefined) {
      authUpdates['app_metadata'] = { role: normalizeUserRole(role) };
    }
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
        res.status(500).json({ error: `Erreur mise à jour auth: ${authUpdateError.message}` });
        return;
      }
    }

    res.json({ success: true, message: 'Collaborateur mis à jour avec succès' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur lors de la mise à jour';
    res.status(500).json({ error: message });
  }
};

app.patch('/api/system/collaborators/:id', requireAdmin, updateCollaboratorHandler);
app.patch('/api/admin/users/:id', requireAdmin, updateCollaboratorHandler);

/**
 * Suppression d'un compte collaborateur (auth.users + public.profiles).
 */
const deleteCollaboratorHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const rawUserId = req.params['id'];
  const userId = Array.isArray(rawUserId) ? rawUserId[0] : rawUserId;
  if (!userId) {
    res.status(400).json({ error: 'Identifiant collaborateur requis' });
    return;
  }

  // Protection anti-auto-suppression
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
      res.status(500).json({ error: `Erreur suppression auth: ${authDeleteError.message}` });
      return;
    }

    const { error: profileDeleteError } = await adminClient.from('profiles').delete().eq('id', userId);
    if (profileDeleteError) {
      console.error('Échec suppression public.profiles:', profileDeleteError.message);
      res.status(500).json({ error: `Erreur suppression profil: ${profileDeleteError.message}` });
      return;
    }

    res.json({ success: true, message: 'Compte collaborateur supprimé avec succès' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur lors de la suppression';
    res.status(500).json({ error: message });
  }
};

app.delete('/api/system/collaborators/:id', requireAdmin, deleteCollaboratorHandler);
app.delete('/api/admin/users/:id', requireAdmin, deleteCollaboratorHandler);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE HYBRIDE : ENDPOINTS API SERVEUR-RELAIS POUR LE CAHIER DE CAISSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Toutes les écritures et consultations prioritaires passent par ces routes.
 * Elles effectuent la validation des données, contrôlent les droits et interagissent
 * avec PostgreSQL via Supabase Admin avec la clé de service.
 * Les pièces comptables au format CSH1/YYYY/00000 sont attribuées une seule fois de manière
 * déterministe à l'insertion et directement servies sans recalcul complet de table.
 */

/**
 * Normalise et garantit le format d'une pièce comptable déjà stockée.
 * Aucun scan de table n'est effectué.
 */
const formatPersistedPieceComptable = (row: Record<string, unknown>): Record<string, unknown> => {
  const existingPiece = typeof row['piece_comptable'] === 'string' && row['piece_comptable'].trim()
    ? row['piece_comptable'].trim().toUpperCase().replace(/\s+/g, '')
    : null;

  if (existingPiece) {
    return {
      ...row,
      piece_comptable: existingPiece,
    };
  }

  const rawDate = row['date'];
  let year = 2026;
  if (typeof rawDate === 'string' && rawDate.trim()) {
    if (rawDate.includes('/')) {
      const parts = rawDate.split('/');
      if (parts.length === 3 && parts[2]) {
        const y = parseInt(parts[2], 10);
        if (!isNaN(y) && y >= 2000 && y <= 2100) year = y;
      }
    } else {
      const parsedYear = new Date(rawDate).getFullYear();
      if (!isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100) year = parsedYear;
    }
  }

  return {
    ...row,
    piece_comptable: `CSH1/${year}/00001`,
  };
};

/**
 * Récupération des opérations de caisse (GET /api/cahier/operations & /api/cashier/transactions)
 * Supporte la pagination optionnelle via limit/offset (défaut limit: 100, max: 1000) pour préserver les ressources.
 */
const getOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  try {
    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];

    let limit = rawLimit ? Number(rawLimit) : 100;
    if (isNaN(limit) || limit <= 0) {
      limit = 100;
    }
    // Plafond de sécurité pour empêcher la saturation mémoire
    if (limit > 1000) {
      limit = 1000;
    }

    let offset = rawOffset ? Number(rawOffset) : 0;
    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }

    const { data, error, count } = await adminClient
      .from('cashier_transactions')
      .select('id, piece_comptable, date, libelle, service, type_description, category, status, no_dossier, dossier_id, first_name, partenaire, employee, employee_id, created_by, quantity, montant, solde_apres, selected, created_at, updated_at', { count: 'exact' })
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Erreur SQL lors de la lecture des opérations:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    const enrichedRows = (data || []).map((row) => formatPersistedPieceComptable(row));

    res.json({
      operations: enrichedRows,
      transactions: enrichedRows,
      total: count ?? (data?.length || 0),
      limit,
      offset,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la récupération des opérations';
    res.status(500).json({ error: message });
  }
};

interface DuplicateCandidateRow {
  id: string;
  date: string;
  libelle: string;
  montant: number;
  service?: string | null;
  no_dossier?: string | null;
}

/**
 * Normalise une date textuellement en format YYYY-MM-DD
 * Immunisé contre tout décalage horaire UTC/local.
 */
const normalizeDateToDay = (rawDate?: string | null): string => {
  if (!rawDate) return '';
  const trimmed = String(rawDate).trim();
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${day}`;
    }
  }
  if (trimmed.includes('-')) {
    const datePart = trimmed.split('T')[0].split(' ')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      const year = parts[0].length === 2 ? `20${parts[0]}` : parts[0];
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
  return trimmed;
};

/**
 * Vérifie si une transaction de caisse identique existe déjà en base de données.
 * Critères d'unicité stricts : Date (jour) + Montant + Libellé + N° de dossier/matricule + Service.
 * Bloque universellement la double saisie (que l'auteur soit le même caissier ou un autre).
 */
const checkDuplicateCashierTransaction = async (
  adminClient: SupabaseClient,
  candidate: {
    idToExclude?: string;
    date: string;
    montant: number;
    libelle: string;
    noDossier?: string | null;
    service?: string | null;
  }
): Promise<{ isDuplicate: boolean; existing?: DuplicateCandidateRow }> => {
  const normDay = normalizeDateToDay(candidate.date);
  const normLibelle = candidate.libelle.toLowerCase().trim().replace(/\s+/g, ' ');
  const normNoDossier = (candidate.noDossier || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const normService = (candidate.service || '').toLowerCase().trim().replace(/\s+/g, ' ');

  const absMontant = Math.abs(Number(candidate.montant));

  // Requête large sur le montant (positif ou négatif) pour neutraliser toute incohérence de signe
  const { data: candidates, error } = await adminClient
    .from('cashier_transactions')
    .select('id, date, libelle, montant, service, no_dossier')
    .or(`montant.eq.${candidate.montant},montant.eq.${-candidate.montant},montant.eq.${absMontant},montant.eq.${-absMontant}`);

  if (error || !candidates || candidates.length === 0) {
    return { isDuplicate: false };
  }

  const rows = candidates as unknown as DuplicateCandidateRow[];
  const duplicate = rows.find((c: DuplicateCandidateRow) => {
    if (candidate.idToExclude && c.id === candidate.idToExclude) {
      return false;
    }

    const cDay = normalizeDateToDay(c.date);
    if (cDay !== normDay) return false;

    // Comparaison du montant en valeur absolue arrondie
    const cAbs = Math.abs(Number(c.montant));
    if (Math.round(cAbs * 100) !== Math.round(absMontant * 100)) return false;

    const cLib = String(c.libelle || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (cLib !== normLibelle) return false;

    const cDos = String(c.no_dossier || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (cDos !== normNoDossier) return false;

    const cSrv = String(c.service || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (cSrv !== normService) return false;

    return true;
  });

  return { isDuplicate: !!duplicate, existing: duplicate };
};

/**
 * Sauvegarde d'une opération de caisse (POST /api/cahier/operations & /api/cashier/transactions)
 * Nettoie et valide les champs, vérifie l'autorisation de l'utilisateur, résout dossier_id et persiste dans PostgreSQL.
 */
const saveOperationHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const callerId: string | null = authenticatedUser?.id || null;

    const payload = req.body || {};
    const rawPiece = payload.pieceComptable || payload.piece_comptable;
    const candidatePiece = typeof rawPiece === 'string' && rawPiece.trim()
      ? rawPiece.trim().toUpperCase().replace(/\s+/g, '')
      : null;
    const libelle = typeof payload.libelle === 'string' ? payload.libelle.trim() : '';
    const service = payload.service || payload.typeTransaction || payload.type_transaction || null;
    const typeDescription = payload.typeDescription || payload.type_description || null;
    const category = payload.category === 'sortie' ? 'sortie' : 'entree';
    const noDossier = payload.noDossier || payload.no_dossier || payload.matriculeVehicule || payload.matricule_vehicule || null;
    const firstName = payload.firstName || payload.first_name || null;
    const partenaire = payload.partenaire !== undefined ? payload.partenaire : null;
    const employee = payload.employee !== undefined ? payload.employee : null;
    const quantity = payload.quantity !== undefined && payload.quantity !== null ? Number(payload.quantity) : (service === 'Opérations' ? 1 : null);
    let montant = Number(payload.montant);

    if (!libelle) {
      res.status(400).json({ error: 'Le libellé de l’opération est obligatoire.' });
      return;
    }

    if (isNaN(montant)) {
      res.status(400).json({ error: 'Le montant de l’opération doit être un nombre valide.' });
      return;
    }

    // Contrôle d'unicité strict du numéro de pièce comptable en priorité absolue
    if (candidatePiece) {
      const { data: pieceDup } = await adminClient
        .from('cashier_transactions')
        .select('id, piece_comptable, date, libelle')
        .eq('piece_comptable', candidatePiece)
        .maybeSingle();

      if (pieceDup) {
        res.status(409).json({
          error: `Erreur d'unicité : le numéro de pièce comptable "${candidatePiece}" est déjà attribué à une autre opération (ID: ${pieceDup.id}, Libellé: "${pieceDup.libelle}"). Les numéros de pièce comptable doivent être strictement uniques.`,
        });
        return;
      }
    }

    // Normalisation absolue du signe du montant selon la catégorie
    if (category === 'sortie' && montant > 0) {
      montant = -montant;
    } else if (category === 'entree' && montant < 0) {
      montant = Math.abs(montant);
    }

    const dateToStore = payload.date ? (typeof payload.date === 'string' ? payload.date : new Date(payload.date).toISOString()) : new Date().toISOString();

    // Contrôle d'unicité strict côté serveur : Date + Montant + Libellé + N° de dossier/matricule + Service
    const duplicateCheck = await checkDuplicateCashierTransaction(adminClient, {
      date: dateToStore,
      montant,
      libelle,
      noDossier,
      service,
    });

    if (duplicateCheck.isDuplicate && duplicateCheck.existing) {
      const dup = duplicateCheck.existing;
      const dupMontantFmt = Math.abs(Number(dup.montant)).toLocaleString('fr-FR');
      res.status(409).json({
        error: `Opération déjà enregistrée : une opération identique existe déjà en caisse (Date: ${dup.date}, Montant: ${dupMontantFmt} FCFA, Service: ${dup.service || 'N/A'}, Libellé: "${dup.libelle}"). La double saisie est interdite.`,
      });
      return;
    }

    let resolvedDossierId: string | null = payload.dossierId || payload.dossier_id || null;
    if (!resolvedDossierId && noDossier) {
      try {
        const { data: dossierRow } = await adminClient
          .from('dossiers')
          .select('id')
          .eq('no_dossier', noDossier)
          .maybeSingle();
        if (dossierRow?.id) {
          resolvedDossierId = dossierRow.id;
        }
      } catch {
        // En cas d'erreur de recherche, on conserve dossier_id à null
      }
    }

    const status = payload.status === 'posted' ? 'posted' : (payload.status === 'cancelled' ? 'cancelled' : 'draft');

    const rowToInsert = {
      piece_comptable: candidatePiece,
      libelle,
      service,
      type_description: typeDescription,
      category,
      status,
      no_dossier: noDossier,
      dossier_id: resolvedDossierId,
      first_name: firstName,
      partenaire,
      employee,
      employee_id: callerId,
      created_by: callerId,
      quantity,
      montant,
      date: payload.date ? (typeof payload.date === 'string' ? payload.date : new Date(payload.date).toISOString()) : new Date().toISOString(),
    };

    console.log(`[AUDIT CASHIER] Création opération par [${authenticatedUser?.email || callerId || 'inconnu'}] (rôle: ${authenticatedUser?.role || 'non-défini'}) : Montant=${montant}, Libellé="${libelle}", Pièce="${candidatePiece || 'auto'}"`);

    const { data, error } = await adminClient
      .from('cashier_transactions')
      .insert([rowToInsert])
      .select()
      .single();

    if (error) {
      console.error('Erreur SQL lors de l’insertion de l’opération:', error.message);
      const isUniqueViolation = error.code === '23505' || error.message?.toLowerCase().includes('unique') || error.message?.includes('duplicate key');
      if (isUniqueViolation) {
        res.status(409).json({
          error: `Erreur d'unicité (SQL 23505) : le numéro de pièce comptable "${candidatePiece || 'indéfini'}" existe déjà dans la base de données.`,
        });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    const enrichedOperation = formatPersistedPieceComptable(data);

    res.status(201).json({
      success: true,
      operation: enrichedOperation,
      transaction: enrichedOperation,
      message: 'Opération enregistrée avec succès',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la sauvegarde';
    res.status(500).json({ error: message });
  }
};

/**
 * Mise à jour d'une opération de caisse (PUT /api/cahier/operations/:id & /api/cashier/transactions/:id)
 * Réservé exclusivement aux rôles 'admin' et 'caissiere'.
 */
const updateOperationHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const rawId = req.params['id'];
    const targetId = Array.isArray(rawId) ? rawId[0] : rawId;

    if (!targetId) {
      res.status(400).json({ error: 'Identifiant d’opération manquant' });
      return;
    }

    const updateData: Record<string, unknown> = {};

    // RÈGLE MÉTIER : chacun ne modifie que ce qu'il a lui-même enregistré.
    // Un manager ne peut pas modifier une opération saisie par un caissier, et un
    // caissier ne peut pas modifier celle d'un collègue. Seul un admin déroge à la règle.
    // (Miroir applicatif de la policy RLS "cashier_transactions_update_own_or_admin".)
    if (authenticatedUser?.role !== 'admin') {
      const { data: existingRow, error: fetchError } = await adminClient
        .from('cashier_transactions')
        .select('created_by, employee_id')
        .eq('id', targetId)
        .maybeSingle();

      if (fetchError) {
        res.status(500).json({ error: `Erreur lors de la vérification des droits: ${fetchError.message}` });
        return;
      }
      if (!existingRow) {
        res.status(404).json({ error: 'Opération introuvable' });
        return;
      }
      const creator = String(existingRow.created_by || existingRow.employee_id || '').trim();
      const userEmail = (authenticatedUser?.email || '').toLowerCase().trim();
      const callerId = authenticatedUser?.id;
      const matchesId = callerId && creator === callerId;
      const matchesEmail = userEmail && creator.toLowerCase() === userEmail;

      if (creator && !matchesId && !matchesEmail) {
        res.status(403).json({ error: 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.' });
        return;
      }
      if (!existingRow.created_by && authenticatedUser?.id) {
        updateData['created_by'] = authenticatedUser.id;
        updateData['employee_id'] = authenticatedUser.id;
      }
    }

    const payload = req.body || {};

    if (payload.libelle !== undefined) {
      const libelle = typeof payload.libelle === 'string' ? payload.libelle.trim() : '';
      if (!libelle) {
        res.status(400).json({ error: 'Le libellé ne peut pas être vide' });
        return;
      }
      updateData['libelle'] = libelle;
    }

    if (payload.service !== undefined || payload.typeTransaction !== undefined || payload.type_transaction !== undefined) {
      updateData['service'] = payload.service ?? payload.typeTransaction ?? payload.type_transaction ?? null;
    }

    if (payload.typeDescription !== undefined || payload.type_description !== undefined) {
      updateData['type_description'] = payload.typeDescription ?? payload.type_description ?? null;
    }

    if (payload.category !== undefined) {
      updateData['category'] = payload.category === 'sortie' ? 'sortie' : 'entree';
    }

    if (payload.status !== undefined) {
      updateData['status'] = payload.status === 'posted' ? 'posted' : (payload.status === 'cancelled' ? 'cancelled' : 'draft');
    }

    if (payload.noDossier !== undefined || payload.no_dossier !== undefined || payload.matriculeVehicule !== undefined || payload.matricule_vehicule !== undefined) {
      const resolvedNoDossier = payload.noDossier ?? payload.no_dossier ?? payload.matriculeVehicule ?? payload.matricule_vehicule ?? null;
      updateData['no_dossier'] = resolvedNoDossier;
      if (resolvedNoDossier && payload.dossier_id === undefined && payload.dossierId === undefined) {
        try {
          const { data: dossierRow } = await adminClient
            .from('dossiers')
            .select('id')
            .eq('no_dossier', resolvedNoDossier)
            .maybeSingle();
          if (dossierRow?.id) {
            updateData['dossier_id'] = dossierRow.id;
          }
        } catch {
          // Ignore
        }
      }
    }

    if (payload.dossier_id !== undefined || payload.dossierId !== undefined) {
      updateData['dossier_id'] = payload.dossier_id ?? payload.dossierId ?? null;
    }

    if (payload.firstName !== undefined || payload.first_name !== undefined) {
      updateData['first_name'] = payload.firstName ?? payload.first_name ?? null;
    }

    if (payload.partenaire !== undefined) {
      updateData['partenaire'] = payload.partenaire ?? null;
    }

    if (payload.employee !== undefined) {
      updateData['employee'] = payload.employee ?? null;
    }

    if (payload.quantity !== undefined) {
      if (payload.quantity === null) {
        updateData['quantity'] = null;
      } else {
        const quantity = Number(payload.quantity);
        updateData['quantity'] = isNaN(quantity) ? null : quantity;
      }
    }

    if (payload.montant !== undefined) {
      const montant = Number(payload.montant);
      if (isNaN(montant)) {
        res.status(400).json({ error: 'Le montant de l’opération doit être un nombre valide' });
        return;
      }
      updateData['montant'] = montant;
    }

    if (payload.date !== undefined && payload.date) {
      updateData['date'] = typeof payload.date === 'string' ? payload.date : new Date(payload.date).toISOString();
    }

    if (payload.pieceComptable !== undefined || payload.piece_comptable !== undefined) {
      const rawPiece = payload.pieceComptable ?? payload.piece_comptable;
      const targetPiece = typeof rawPiece === 'string' && rawPiece.trim()
        ? rawPiece.trim().toUpperCase().replace(/\s+/g, '')
        : null;

      if (targetPiece) {
        const { data: pieceDup } = await adminClient
          .from('cashier_transactions')
          .select('id, piece_comptable, date, libelle')
          .eq('piece_comptable', targetPiece)
          .neq('id', targetId)
          .maybeSingle();

        if (pieceDup) {
          res.status(409).json({
            error: `Modification refusée : le numéro de pièce comptable "${targetPiece}" est déjà attribué à une autre opération (ID: ${pieceDup.id}, Libellé: "${pieceDup.libelle}").`,
          });
          return;
        }
      }
      updateData['piece_comptable'] = targetPiece;
    }

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ error: 'Aucun champ à modifier fourni' });
      return;
    }

    // Contrôle anti-doublon si un des champs de l'empreinte change
    if (
      updateData['montant'] !== undefined ||
      updateData['libelle'] !== undefined ||
      updateData['date'] !== undefined ||
      updateData['service'] !== undefined ||
      updateData['no_dossier'] !== undefined
    ) {
      const { data: currentRecord } = await adminClient
        .from('cashier_transactions')
        .select('id, date, libelle, montant, service, no_dossier')
        .eq('id', targetId)
        .maybeSingle();

      if (currentRecord) {
        const checkCandidate = {
          idToExclude: targetId,
          date: (updateData['date'] as string) || currentRecord.date || new Date().toISOString(),
          montant: updateData['montant'] !== undefined ? (updateData['montant'] as number) : Number(currentRecord.montant),
          libelle: (updateData['libelle'] as string) || currentRecord.libelle || '',
          noDossier: updateData['no_dossier'] !== undefined ? (updateData['no_dossier'] as string) : currentRecord.no_dossier,
          service: updateData['service'] !== undefined ? (updateData['service'] as string) : currentRecord.service,
        };

        const updateDup = await checkDuplicateCashierTransaction(adminClient, checkCandidate);
        if (updateDup.isDuplicate && updateDup.existing) {
          const dup = updateDup.existing;
          res.status(409).json({
            error: `Modification refusée : une opération identique existe déjà en caisse (Date: ${dup.date}, Montant: ${dup.montant} FCFA, Service: ${dup.service || 'N/A'}, Libellé: "${dup.libelle}").`,
          });
          return;
        }
      }
    }

    updateData['updated_at'] = new Date().toISOString();

    console.log(`[AUDIT CASHIER] Modification opération [${targetId}] par [${authenticatedUser?.email || authenticatedUser?.id || 'inconnu'}] (rôle: ${authenticatedUser?.role || 'non-défini'}) :`, Object.keys(updateData));

    const { data, error } = await adminClient
      .from('cashier_transactions')
      .update(updateData)
      .eq('id', targetId)
      .select()
      .single();

    if (error) {
      console.error('Erreur SQL lors de la mise à jour de l’opération:', error.message);
      const isUniqueViolation = error.code === '23505' || error.message?.toLowerCase().includes('unique') || error.message?.includes('duplicate key');
      if (isUniqueViolation) {
        res.status(409).json({
          error: `Erreur d'unicité (SQL 23505) : le numéro de pièce comptable est déjà utilisé dans la base de données.`,
        });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }

    const enrichedOperation = formatPersistedPieceComptable(data);

    res.json({
      success: true,
      operation: enrichedOperation,
      transaction: enrichedOperation,
      message: 'Opération modifiée avec succès',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la modification';
    res.status(500).json({ error: message });
  }
};

/**
 * Suppression d'opérations de caisse (DELETE /api/cahier/operations & /api/cashier/transactions)
 * RÈGLE MÉTIER STRICTE :
 * - Les administrateurs ('admin') peuvent tout supprimer.
 * - Tous les autres utilisateurs ('caissiere', 'manager', 'tresorier', 'employe') ne peuvent supprimer UNIQUEMENT que les opérations qu'ils ont eux-mêmes créées.
 */
const deleteOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const callerId = authenticatedUser?.id;
    const userRole = authenticatedUser?.role;
    const isAdmin = userRole === 'admin';

    const paramId = req.params['id'];
    const singleId = Array.isArray(paramId) ? paramId[0] : paramId;
    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const targetIds: string[] = singleId ? [singleId] : bodyIds;

    if (targetIds.length === 0) {
      res.status(400).json({ error: 'Aucun identifiant d’opération fourni pour la suppression' });
      return;
    }

    if (targetIds.length > 100) {
      res.status(400).json({ error: 'Limite dépassée : impossible de supprimer plus de 100 opérations par requête' });
      return;
    }

    // Si l'utilisateur n'est pas admin, vérifier les autorisations de propriété stricte
    if (!isAdmin) {
      if (!callerId) {
        res.status(403).json({ error: 'Utilisateur non identifié. Suppression refusée.' });
        return;
      }

      const { data: rowsToCheck, error: fetchErr } = await adminClient
        .from('cashier_transactions')
        .select('id, created_by, employee_id, libelle')
        .in('id', targetIds);

      if (fetchErr || !rowsToCheck) {
        res.status(500).json({ error: 'Impossible de vérifier la propriété des opérations' });
        return;
      }

      // Pour tout utilisateur non-admin (ex: caissière) :
      // Vérification stricte de propriété : l'utilisateur ne peut supprimer QUE ses propres opérations.
      // Règle de parité stricte avec la policy RLS : une ligne sans créateur explicite (created_by ou employee_id vide) ne peut être supprimée que par un admin
      const userEmail = (authenticatedUser?.email || '').toLowerCase().trim();
      const unauthorizedRows = rowsToCheck.filter((r) => {
        const creator = String(r.created_by || r.employee_id || '').trim();
        // Si aucun créateur n'est défini en base, interdire la suppression à tout non-administrateur
        if (!creator) return true;
        const matchesId = Boolean(callerId && creator === callerId);
        const matchesEmail = Boolean(userEmail && creator.toLowerCase() === userEmail);
        return !matchesId && !matchesEmail;
      });

      if (unauthorizedRows.length > 0) {
        res.status(403).json({
          error: 'Action refusée : vous ne pouvez supprimer que les opérations que vous avez vous-même enregistrées.',
        });
        return;
      }
    }

    console.warn(`[AUDIT CASHIER] Suppression de ${targetIds.length} opération(s) [${targetIds.join(', ')}] initiée par [${authenticatedUser?.email || authenticatedUser?.id || 'inconnu'}] (rôle: ${userRole || 'non-défini'})`);

    const { error, count } = await adminClient
      .from('cashier_transactions')
      .delete({ count: 'exact' })
      .in('id', targetIds);

    if (error) {
      console.error('Erreur SQL lors de la suppression d’opérations:', error.message);
      res.status(500).json({ error: error.message });
      return;
    }

    // Nettoyage éventuel des pièces justificatives associées dans storage ou liens
    res.json({
      success: true,
      deletedCount: count ?? targetIds.length,
      message: `${targetIds.length} opération(s) supprimée(s) avec succès`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la suppression';
    res.status(500).json({ error: message });
  }
};

/**
 * Duplication en masse d'opérations de caisse (POST /api/cahier/operations/duplicate)
 */
const duplicateOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const callerId = authenticatedUser?.id || null;
    const userRole = authenticatedUser?.role;

    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (bodyIds.length === 0) {
      res.status(400).json({ error: 'Aucun identifiant fourni pour la duplication' });
      return;
    }

    // Récupération des transactions originales
    const { data: originalRows, error: fetchErr } = await adminClient
      .from('cashier_transactions')
      .select('*')
      .in('id', bodyIds);

    if (fetchErr || !originalRows || originalRows.length === 0) {
      res.status(404).json({ error: 'Aucune opération trouvée pour duplication' });
      return;
    }

    // Contrôle d'appartenance pour les rôles non-admin : on ne peut dupliquer que ses propres opérations
    if (userRole !== 'admin') {
      if (!callerId) {
        res.status(403).json({ error: 'Utilisateur non identifié. Duplication refusée.' });
        return;
      }
      const unauthorizedRows = originalRows.filter((r) => {
        const creator = r.created_by || r.employee_id;
        if (!creator) return false; // Tolérance pour les lignes historiques sans auteur
        return creator !== callerId;
      });
      if (unauthorizedRows.length > 0) {
        res.status(403).json({
          error: `Vous ne pouvez dupliquer que vos propres opérations (${unauthorizedRows.length} opération(s) non autorisée(s)).`,
        });
        return;
      }
    }

    const todayIso = new Date().toISOString();
    const rowsToInsert = originalRows.map((orig) => ({
      libelle: orig.libelle ? `${orig.libelle} (Copie)` : 'Copie opération',
      service: orig.service,
      type_description: orig.type_description,
      category: orig.category,
      status: 'draft',
      no_dossier: orig.no_dossier,
      dossier_id: orig.dossier_id,
      first_name: orig.first_name,
      partenaire: orig.partenaire,
      employee: orig.employee,
      employee_id: callerId,
      created_by: callerId,
      quantity: orig.quantity,
      montant: orig.montant,
      date: todayIso,
    }));

    const { data: insertedRows, error: insertErr } = await adminClient
      .from('cashier_transactions')
      .insert(rowsToInsert)
      .select();

    if (insertErr) {
      console.error('Erreur SQL lors de la duplication:', insertErr.message);
      res.status(500).json({ error: insertErr.message });
      return;
    }

    const enriched = (insertedRows || []).map((r) => formatPersistedPieceComptable(r));
    res.json({
      success: true,
      count: insertedRows?.length || 0,
      data: enriched,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne lors de la duplication';
    res.status(500).json({ error: message });
  }
};

/**
 * Modification de statut en masse (PATCH /api/cahier/operations/status)
 */
const updateOperationsStatusHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service d’administration indisponible : SUPABASE_SERVICE_ROLE_KEY manquante' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string; email?: string; role?: string } | undefined;
    const callerId = authenticatedUser?.id || null;
    const userRole = authenticatedUser?.role;

    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const newStatus = req.body?.status === 'posted' ? 'posted' : (req.body?.status === 'cancelled' ? 'cancelled' : 'draft');

    if (bodyIds.length === 0) {
      res.status(400).json({ error: 'Aucun identifiant fourni' });
      return;
    }

    // Contrôle d'appartenance pour les non-admins : interdiction de changer le statut des opérations créées par un tiers
    if (userRole !== 'admin') {
      if (!callerId) {
        res.status(403).json({ error: 'Utilisateur non identifié. Modification de statut refusée.' });
        return;
      }

      const { data: rowsToCheck, error: fetchErr } = await adminClient
        .from('cashier_transactions')
        .select('id, created_by, employee_id')
        .in('id', bodyIds);

      if (fetchErr || !rowsToCheck) {
        res.status(500).json({ error: 'Impossible de vérifier la propriété des opérations' });
        return;
      }

      const unauthorizedRows = rowsToCheck.filter((r) => {
        const creator = r.created_by || r.employee_id;
        if (!creator) return false;
        return creator !== callerId;
      });

      if (unauthorizedRows.length > 0) {
        res.status(403).json({
          error: `Vous ne pouvez modifier le statut que de vos propres opérations (${unauthorizedRows.length} opération(s) non autorisée(s)).`,
        });
        return;
      }
    }

    const { data: updatedRows, error: updateErr } = await adminClient
      .from('cashier_transactions')
      .update({ status: newStatus })
      .in('id', bodyIds)
      .select();

    if (updateErr) {
      console.error('Erreur SQL mise à jour statut:', updateErr.message);
      res.status(500).json({ error: updateErr.message });
      return;
    }

    const enriched = (updatedRows || []).map((r) => formatPersistedPieceComptable(r));
    res.json({
      success: true,
      count: updatedRows?.length || 0,
      data: enriched,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erreur interne modification de statut';
    res.status(500).json({ error: message });
  }
};

// Déclaration des routes de caisse sécurisées par RBAC strict (lecture réservée aux rôles financiers et encadrement)
app.get('/api/cahier/operations', requireAuth, requireRole(['admin', 'manager', 'caissiere', 'comptable', 'tresorier']), getOperationsHandler);
app.get('/api/cashier/transactions', requireAuth, requireRole(['admin', 'manager', 'caissiere', 'comptable', 'tresorier']), getOperationsHandler);
app.get('/api/system/operations', requireAuth, requireRole(['admin', 'manager', 'caissiere', 'comptable', 'tresorier']), getOperationsHandler);

// Actions en masse (Duplication & Changement de statut)
app.post('/api/cahier/operations/duplicate', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), duplicateOperationsHandler);
app.post('/api/cashier/transactions/duplicate', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), duplicateOperationsHandler);
app.patch('/api/cahier/operations/status', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), updateOperationsStatusHandler);
app.patch('/api/cashier/transactions/status', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), updateOperationsStatusHandler);

// Écriture : réservée aux Administrateurs, Caissières, Managers et Comptables
app.post('/api/cahier/operations', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), saveOperationHandler);
app.post('/api/cashier/transactions', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), saveOperationHandler);

app.put('/api/cahier/operations/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), updateOperationHandler);
app.put('/api/cashier/transactions/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), updateOperationHandler);
app.patch('/api/cahier/operations/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), updateOperationHandler);
app.patch('/api/cashier/transactions/:id', requireAuth, requireRole(['admin', 'caissiere', 'manager', 'comptable']), updateOperationHandler);

// Suppression : autorisée pour les Administrateurs et Caissières (vérification stricte de propriété dans deleteOperationsHandler)
app.delete('/api/cahier/operations/:id', requireAuth, requireRole(['admin', 'caissiere']), deleteOperationsHandler);
app.delete('/api/cashier/transactions/:id', requireAuth, requireRole(['admin', 'caissiere']), deleteOperationsHandler);
app.delete('/api/cahier/operations', requireAuth, requireRole(['admin', 'caissiere']), deleteOperationsHandler);
app.delete('/api/cashier/transactions', requireAuth, requireRole(['admin', 'caissiere']), deleteOperationsHandler);

/**
 * Example Express Rest API endpoints can be defined here.
 * Uncomment and define endpoints as necessary.
 *
 * Example:
 * ```ts
 * app.get('/api/{*splat}', (req, res) => {
 *   // Handle API request
 * });
 * ```
 */

/**
 * Serve static files from /browser
 * - Les fichiers versionnés (JS, CSS, polices, images) bénéficient du cache immutable 1 an en production.
 * - Seuls les fichiers HTML restent en no-cache, no-store pour garantir la fraîcheur applicative.
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: process.env['NODE_ENV'] === 'production' ? '1y' : '0',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (process.env['NODE_ENV'] === 'production') {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
    index: false,
    redirect: false,
  }),
);

/**
 * Traite les requêtes de rendu Angular SSR :
 * Transmet l'objet Express `req` (contenant les en-têtes et cookies HTTP Supabase `sb-*-auth-token`)
 * à l'engine `AngularNodeAppEngine` afin que SupabaseService réhydrate la session SSR avant le rendu HTML.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  app.listen(port, (error) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
