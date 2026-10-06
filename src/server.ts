import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import { SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { UpstashRateLimitStore } from './server/upstash-rate-limit.store';
import { getSupabaseAdmin, requireAuth, updateExistingUserProfileRole } from './server/auth';
import { getSupabaseConfigHandler } from './server/config';
import { syncUserAccessRole } from './server/access-role-sync';
import { formatPersistedPieceComptable, normalizeDateToDay, requiresCashierDraftBeforeEdit } from './server/cashier.utils';
import { getCurrentUserProfileHandler, updateCurrentUserProfileHandler } from './server/profile';
import { createCollaboratorHandler } from './server/collaborators.create';
import { getCollaboratorsHandler } from './server/collaborators.list';
import { deleteCollaboratorHandler, updateCollaboratorHandler } from './server/collaborators.manage';
import { getDossierExpenseSummaryHandler, getOperationsHandler } from './server/cashier.read';
import { createDossierHandler, listDossiersHandler } from './server/dossiers';
import { writeAuditLog } from './server/audit-log';
import {
  createProspectHandler,
  deleteProspectHandler,
  listProspectAssigneesHandler,
  listProspectsHandler,
  updateProspectHandler,
} from './server/prospects';
import {
  createJournalHandler,
  deleteJournalHandler,
  getJournalsHandler,
  updateJournalHandler,
} from './server/journals';
import {
  createJournalEntryHandler,
  deleteJournalEntryHandler,
  getJournalChartDataHandler,
  getJournalEntriesHandler,
  updateJournalEntryHandler,
} from './server/journal-entries';
import {
  assignAccessRoleHandler,
  createAccessRoleHandler,
  deleteAccessRoleHandler,
  getMyAccessPermissionsHandler,
  getRolePermissionsHandler,
  getUserAccessHandler,
  listAccessUsersHandler,
  listAccessAuditHandler,
  listAccessPermissionsHandler,
  listAccessRolesHandler,
  replaceRolePermissionsHandler,
  revokeAccessRoleHandler,
  revokeUserPermissionOverrideHandler,
  setUserPermissionOverrideHandler,
  updateAccessRoleHandler,
} from './server/access-control.handlers';
import { hasPermission, requirePermission, resolveJournalOwnerContext } from './server/access-control';

// Charger les variables d'environnement depuis le fichier `.env` (si présent)
dotenv.config();

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

const readPositiveIntegerEnv = (name: string, defaultValue: number): number => {
  const value = process.env[name];
  if (!value) return defaultValue;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} doit être un entier supérieur à zéro.`);
  }
  return parsed;
};

const createRateLimitStore = (prefix: string): UpstashRateLimitStore | undefined =>
  process.env['VERCEL'] === '1' || process.env['NODE_ENV'] === 'production'
    ? new UpstashRateLimitStore(prefix)
    : undefined;

// Configuration du reverse proxy pour Cloud Run / Nginx (gestion sécurisée de l'en-tête X-Forwarded-For)
app.set('trust proxy', 1);

// En-têtes de sécurité HTTP via Helmet durcis pour Angular SSR et compatibilité iFrame AI Studio
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'https:', 'wss:'],
        frameAncestors: ["'self'", 'https://ai.studio', 'https://*.google.com', 'https://*.run.app'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: process.env['NODE_ENV'] === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: false, // Délégué à CSP frameAncestors pour autoriser l'iFrame de prévisualisation AI Studio
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    xContentTypeOptions: true,
    xXssProtection: true,
  })
);

// Parsing JSON pour les requêtes d'API avec limite explicite de payload
app.use(express.json({ limit: '256kb' }));

/**
 * ==============================================================================
 * RATE LIMITING STRATIFIÉ (SÉCURITÉ & PROTECTION CONTRE LE BRUTE-FORCE / ABUS)
 * ==============================================================================
 */

// 1. Limiteur global sur toutes les routes de l'API /api/* (configurable par IP)
const apiGlobalLimiter = rateLimit({
  windowMs: readPositiveIntegerEnv('API_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  limit: readPositiveIntegerEnv('API_RATE_LIMIT_MAX', 200),
  store: createRateLimitStore('transmex:api:global:'),
  passOnStoreError: true,
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
  store: createRateLimitStore('transmex:api:auth:'),
  passOnStoreError: true,
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
  store: createRateLimitStore('transmex:api:mutations:'),
  passOnStoreError: true,
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
    '/api/prospects',
  ],
  (req, res, next): void => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      mutationsLimiter(req, res, next);
      return;
    }
    next();
  }
);

app.get('/api/supabase-config', getSupabaseConfigHandler);
app.get('/api/config', getSupabaseConfigHandler);

const collaboratorCollectionAliases = ['/api/system/collaborators', '/api/admin/users'];

collaboratorCollectionAliases.forEach((path) => {
  app.get(path, requireAuth, async (req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> => {
    const user = (req as unknown as Record<string, unknown>)['user'] as { id?: string } | undefined;
    if (!user?.id) {
      res.status(401).json({ error: 'Utilisateur non authentifié.' });
      return;
    }

    try {
      const canRead = (await hasPermission(user.id, 'hr.read', undefined)) || (await hasPermission(user.id, 'users.read', undefined));
      if (canRead) {
        next();
        return;
      }
      requirePermission('users.read')(req, res, next);
    } catch {
      requirePermission('users.read')(req, res, next);
    }
  }, getCollaboratorsHandler);
});

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
    const { error: profileUpdateError } = await updateExistingUserProfileRole(
      supabaseAdmin,
      user.id,
      targetRole,
      user.email
    );

    if (profileUpdateError) {
      console.error('Erreur mise à jour profile dans sync-role:', profileUpdateError.message);
      res.status(500).json({ error: 'Échec de synchronisation du profil utilisateur.' });
      return;
    }

    try {
      await syncUserAccessRole(supabaseAdmin, user.id, targetRole, user.id, 'legacy_profile');
    } catch (syncErr) {
      console.warn('Synchronisation access_user_roles dans sync-role:', syncErr);
    }

    res.json({
      success: true,
      role: targetRole,
      isAdmin: targetRole === 'admin',
      userId: user.id,
      email: user.email,
    });
  } catch (err: unknown) {
    console.error('Erreur lors de la synchronisation du rôle:', err);
    res.status(500).json({ error: 'Erreur interne lors de la synchronisation du rôle.' });
  }
});

collaboratorCollectionAliases.forEach((path) => {
  app.post(path, requireAuth, requirePermission('users.create'), createCollaboratorHandler);
});

/**
 * Modification d'un compte collaborateur (synchronisation auth.app_metadata + public.profiles)
 */
app.get('/api/profile/me', requireAuth, getCurrentUserProfileHandler);
app.patch('/api/profile/me', requireAuth, requirePermission('profile.update'), updateCurrentUserProfileHandler);

collaboratorCollectionAliases.forEach((path) => {
  app.patch(`${path}/:id`, requireAuth, requirePermission('users.update'), updateCollaboratorHandler);
});

/**
 * Suppression d'un compte collaborateur (auth.users + public.profiles).
 */
collaboratorCollectionAliases.forEach((path) => {
  app.delete(`${path}/:id`, requireAuth, requirePermission('users.delete'), deleteCollaboratorHandler);
});

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

interface DuplicateCandidateRow {
  id: string;
  date: string;
  libelle: string;
  montant: number;
  service?: string | null;
  no_dossier?: string | null;
}

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

  // Requête optimisée ciblée sur le jour et le montant pour éviter les balayages complets de table
  let candidateQuery = adminClient
    .from('cashier_transactions')
    .select('id, date, libelle, montant, service, no_dossier')
    .or(`montant.eq.${candidate.montant},montant.eq.${-candidate.montant},montant.eq.${absMontant},montant.eq.${-absMontant}`);

  if (normDay) {
    candidateQuery = candidateQuery.eq('date', normDay);
  }

  const { data: candidates, error } = await candidateQuery;

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
    if (typeof rawPiece === 'string' && rawPiece.trim()) {
      res.status(400).json({ error: 'La pièce comptable est attribuée par la base lors de la comptabilisation.' });
      return;
    }
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

    if (payload.category !== undefined && !['entree', 'sortie'].includes(payload.category)) {
      res.status(400).json({ error: 'La catégorie de l’opération est invalide.' });
      return;
    }

    if (!Number.isFinite(montant) || montant === 0) {
      res.status(400).json({ error: 'Le montant de l’opération doit être un nombre fini différent de zéro.' });
      return;
    }

    // Normalisation absolue du signe du montant selon la catégorie
    if (category === 'sortie' && montant > 0) {
      montant = -montant;
    } else if (category === 'entree' && montant < 0) {
      montant = Math.abs(montant);
    }

    const dateToStore = normalizeDateToDay(payload.date) || new Date().toISOString().slice(0, 10);

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
      piece_comptable: null,
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
      date: dateToStore,
      journal_id: payload.journal_id || payload.journalId || null,
    };

    console.log(`[AUDIT CASHIER] Création opération par [${authenticatedUser?.email || callerId || 'inconnu'}] (rôle: ${authenticatedUser?.role || 'non-défini'}) : Montant=${montant}, Libellé="${libelle}", pièce attribuée à la comptabilisation`);

    const { data, error } = await adminClient
      .from('cashier_transactions')
      .insert([rowToInsert])
      .select()
      .single();

    if (error) {
      console.error('Erreur SQL lors de l’insertion de l’opération:', error.message);
      const isUniqueViolation = error.code === '23505' || error.message?.toLowerCase().includes('unique') || error.message?.includes('duplicate key');
      if (isUniqueViolation) {
        const isPiece = error.message?.includes('piece_comptable') || error.message?.includes('piece');
        const errorMsg = isPiece
          ? `Erreur d'unicité : le numéro de pièce comptable est déjà utilisé dans la base de données.`
          : `Opération déjà enregistrée : une opération identique existe déjà en caisse (conflit de saisie simultanée). La double saisie est interdite.`;
        res.status(409).json({ error: errorMsg });
        return;
      }
      res.status(500).json({ error: 'Erreur lors de l’enregistrement de l’opération de caisse.' });
      return;
    }

    await writeAuditLog(adminClient, {
      userId: callerId,
      userEmail: authenticatedUser?.email,
      userRole: authenticatedUser?.role,
      action: 'CREATE_OPERATION',
      entityId: data.id,
      details: {
        piece_comptable: data.piece_comptable,
        status: data.status,
        source: 'cashier_api',
      },
      ipAddress: req.ip || null,
    });

    const enrichedOperation = formatPersistedPieceComptable(data);

    res.status(201).json({
      success: true,
      operation: enrichedOperation,
      transaction: enrichedOperation,
      message: 'Opération enregistrée avec succès',
    });
  } catch (err: unknown) {
    console.error('Erreur saveOperationHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la sauvegarde de l’opération.' });
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
    const { data: existingRow, error: fetchError } = await adminClient
      .from('cashier_transactions')
      .select('created_by, employee_id, category, montant, status, piece_comptable')
      .eq('id', targetId)
      .maybeSingle();

    if (fetchError) {
      console.error('Erreur vérification droits updateOperationHandler:', fetchError.message);
      res.status(500).json({ error: 'Erreur lors de la vérification des autorisations sur l’opération.' });
      return;
    }
    if (!existingRow) {
      res.status(404).json({ error: 'Opération introuvable' });
      return;
    }
    if (existingRow.status === 'cancelled') {
      res.status(409).json({ error: 'Une opération annulée est définitive et ne peut plus être modifiée.' });
      return;
    }

    // RÈGLE MÉTIER : chacun ne modifie que ce qu'il a lui-même enregistré.
    // Un manager ne peut pas modifier une opération saisie par un caissier, et un
    // caissier ne peut pas modifier celle d'un collègue. Seul un admin déroge à la règle.
    // (Miroir applicatif de la policy RLS "cashier_transactions_update_own_or_admin".)
    if (authenticatedUser?.role !== 'admin') {
      const creator = String(existingRow.created_by || existingRow.employee_id || '').trim();
      const userEmail = (authenticatedUser?.email || '').toLowerCase().trim();
      const callerId = authenticatedUser?.id;
      const matchesId = callerId && creator === callerId;
      const matchesEmail = userEmail && creator.toLowerCase() === userEmail;

      if (!creator || (!matchesId && !matchesEmail)) {
        res.status(403).json({ error: 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.' });
        return;
      }
      if (!existingRow.created_by && authenticatedUser?.id) {
        updateData['created_by'] = authenticatedUser.id;
        updateData['employee_id'] = authenticatedUser.id;
      }
    }

    if (requiresCashierDraftBeforeEdit(existingRow.status, authenticatedUser?.role)) {
      res.status(409).json({ error: 'Remettez l’opération en brouillon avant de la modifier.' });
      return;
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

    if (payload.category !== undefined && !['entree', 'sortie'].includes(payload.category)) {
      res.status(400).json({ error: 'La catégorie de l’opération est invalide.' });
      return;
    }

    const effectiveCategory = payload.category !== undefined ? payload.category : existingRow.category;
    if (payload.category !== undefined) {
      updateData['category'] = effectiveCategory;
    }

    if (payload.status !== undefined) {
      if (!['draft', 'posted', 'cancelled'].includes(payload.status)) {
        res.status(400).json({ error: 'Le statut de l’opération est invalide.' });
        return;
      }
      updateData['status'] = payload.status;
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
      if (!Number.isFinite(montant) || montant === 0) {
        res.status(400).json({ error: 'Le montant de l’opération doit être un nombre fini différent de zéro.' });
        return;
      }
      updateData['montant'] = effectiveCategory === 'sortie' ? -Math.abs(montant) : Math.abs(montant);
    } else if (payload.category !== undefined) {
      const montant = Math.abs(Number(existingRow.montant));
      if (!Number.isFinite(montant) || montant === 0) {
        res.status(400).json({ error: 'Le montant existant doit être corrigé avant de changer la catégorie.' });
        return;
      }
      updateData['montant'] = effectiveCategory === 'sortie' ? -montant : montant;
    }

    if (payload.date !== undefined && payload.date) {
      updateData['date'] = normalizeDateToDay(payload.date) || new Date().toISOString().slice(0, 10);
    }

    if (payload.pieceComptable !== undefined || payload.piece_comptable !== undefined) {
      const rawPiece = payload.pieceComptable ?? payload.piece_comptable;
      const targetPiece = typeof rawPiece === 'string' && rawPiece.trim()
        ? rawPiece.trim().toUpperCase().replace(/\s+/g, '')
        : null;
      const currentPiece = typeof existingRow.piece_comptable === 'string' && existingRow.piece_comptable.trim()
        ? existingRow.piece_comptable.trim().toUpperCase().replace(/\s+/g, '')
        : null;

      if (targetPiece !== currentPiece) {
        res.status(400).json({ error: 'Le numéro de pièce comptable est immuable et ne peut pas être fourni par le client.' });
        return;
      }
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
        const isPiece = error.message?.includes('piece_comptable') || error.message?.includes('piece');
        const errorMsg = isPiece
          ? `Erreur d'unicité : le numéro de pièce comptable est déjà utilisé dans la base de données.`
          : `Modification refusée : une opération identique existe déjà en caisse (conflit de saisie simultanée). La double saisie est interdite.`;
        res.status(409).json({ error: errorMsg });
        return;
      }
      res.status(500).json({ error: 'Erreur lors de la modification de l’opération de caisse.' });
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
    console.error('Erreur updateOperationHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la modification de l’opération.' });
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
    if (bodyIds.length > 100 || bodyIds.some((targetId: unknown) => typeof targetId !== 'string' || !targetId) || new Set(bodyIds).size !== bodyIds.length) {
      res.status(400).json({ error: 'La duplication accepte au maximum 100 identifiants distincts et valides.' });
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
    if (originalRows.length !== bodyIds.length) {
      res.status(404).json({ error: 'Une ou plusieurs opérations sont introuvables.' });
      return;
    }

    // Contrôle d'appartenance pour les rôles non-admin : on ne peut dupliquer que ses propres opérations
    if (userRole !== 'admin') {
      if (!callerId) {
        res.status(403).json({ error: 'Utilisateur non identifié. Duplication refusée.' });
        return;
      }
      const unauthorizedRows = originalRows.filter((r) => {
        const creator = String(r.created_by || r.employee_id || '').trim();
        return !creator || creator !== callerId;
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
      res.status(500).json({ error: 'Erreur lors de la duplication des opérations de caisse.' });
      return;
    }

    const enriched = (insertedRows || []).map((r) => formatPersistedPieceComptable(r));
    res.json({
      success: true,
      count: insertedRows?.length || 0,
      data: enriched,
    });
  } catch (err: unknown) {
    console.error('Erreur duplicateOperationsHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la duplication des opérations.' });
  }
};

/**
 * Calcul du solde global et des métriques de caisse côté PostgreSQL
 * Indépendant de la pagination et des tranches locales.
 */
const getCashierSummaryHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  try {
    const rawJournalId = req.query['journalId'] || req.query['journal_id'];
    const journalId = typeof rawJournalId === 'string' && rawJournalId.trim() && rawJournalId !== 'native-caisse-principal' && rawJournalId !== 'CSH1'
      ? rawJournalId.trim()
      : null;

    const { data, error } = await adminClient.rpc('get_cashier_summary', {
      p_journal_id: journalId,
    });

    if (error) {
      console.error('Erreur SQL get_cashier_summary:', error.message);
      res.status(500).json({ error: 'Erreur lors du calcul du solde de caisse.' });
      return;
    }

    res.json({
      success: true,
      summary: data,
    });
  } catch (err: unknown) {
    console.error('Erreur getCashierSummaryHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors du calcul du solde.' });
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
    const requestedStatus = req.body?.status;

    if (bodyIds.length === 0) {
      res.status(400).json({ error: 'Aucun identifiant fourni' });
      return;
    }
    if (bodyIds.length > 100 || bodyIds.some((targetId: unknown) => typeof targetId !== 'string' || !targetId) || new Set(bodyIds).size !== bodyIds.length) {
      res.status(400).json({ error: 'La modification accepte au maximum 100 identifiants distincts et valides.' });
      return;
    }
    if (!['draft', 'posted', 'cancelled'].includes(requestedStatus)) {
      res.status(400).json({ error: 'Le statut demandé est invalide.' });
      return;
    }
    const newStatus = requestedStatus;

    const { data: rowsToCheck, error: fetchErr } = await adminClient
      .from('cashier_transactions')
      .select('id, created_by, employee_id, status')
      .in('id', bodyIds);

    if (fetchErr || !rowsToCheck) {
      res.status(500).json({ error: 'Impossible de vérifier les opérations demandées.' });
      return;
    }
    if (rowsToCheck.length !== bodyIds.length) {
      res.status(404).json({ error: 'Une ou plusieurs opérations sont introuvables.' });
      return;
    }
    if (newStatus !== 'cancelled' && rowsToCheck.some((row) => row.status === 'cancelled')) {
      res.status(409).json({ error: 'Une opération annulée ne peut pas être réactivée ou modifiée.' });
      return;
    }

    // Contrôle d'appartenance pour les non-admins : interdiction de changer le statut des opérations créées par un tiers
    if (userRole !== 'admin') {
      if (!callerId) {
        res.status(403).json({ error: 'Utilisateur non identifié. Modification de statut refusée.' });
        return;
      }

      const unauthorizedRows = rowsToCheck.filter((r) => {
        const creator = String(r.created_by || r.employee_id || '').trim();
        return !creator || creator !== callerId;
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
      res.status(500).json({ error: 'Erreur lors de la mise à jour du statut des opérations.' });
      return;
    }

    if (newStatus === 'cancelled') {
      await Promise.all((updatedRows || []).map((row) => writeAuditLog(adminClient, {
        userId: callerId,
        userEmail: authenticatedUser?.email,
        userRole,
        action: 'CANCEL_OPERATION',
        entityId: row.id,
        details: { piece_comptable: row.piece_comptable, status: 'cancelled' },
        ipAddress: req.ip || null,
      })));
    }

    const enriched = (updatedRows || []).map((r) => formatPersistedPieceComptable(r));
    res.json({
      success: true,
      count: updatedRows?.length || 0,
      data: enriched,
    });
  } catch (err: unknown) {
    console.error('Erreur updateOperationsStatusHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la modification de statut des opérations.' });
  }
};

// Caisse native : chaque route exige une permission du catalogue serveur.
const cashierOperationAliases = ['/api/cahier/operations', '/api/cashier/transactions'];

cashierOperationAliases.forEach((path) => {
  app.get(path, requireAuth, requirePermission('cashier.read'), getOperationsHandler);
  app.get(`${path}/summary`, requireAuth, requirePermission('cashier.read'), getCashierSummaryHandler);
});

cashierOperationAliases.forEach((path) => {
  app.post(`${path}/duplicate`, requireAuth, requirePermission('cashier.duplicate'), duplicateOperationsHandler);
  app.patch(`${path}/status`, requireAuth, requirePermission('cashier.status_update'), updateOperationsStatusHandler);
});

cashierOperationAliases.forEach((path) => {
  app.post(path, requireAuth, requirePermission('cashier.create'), saveOperationHandler);
});

cashierOperationAliases.forEach((path) => {
  app.put(`${path}/:id`, requireAuth, requirePermission('cashier.update'), updateOperationHandler);
  app.patch(`${path}/:id`, requireAuth, requirePermission('cashier.update'), updateOperationHandler);
});

cashierOperationAliases.forEach((path) => {
  app.delete(`${path}/:id`, requireAuth, requirePermission('cashier.delete'), (_req, res) => {
    res.status(410).json({ error: 'La suppression définitive est désactivée. Annulez l’opération pour conserver sa pièce comptable.' });
  });
  app.delete(path, requireAuth, requirePermission('cashier.delete'), (_req, res) => {
    res.status(410).json({ error: 'La suppression définitive est désactivée. Annulez l’opération pour conserver sa pièce comptable.' });
  });
});

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINTS API JOURNAUX COMPTABLES
 * ─────────────────────────────────────────────────────────────────────────────
 * Consultation : admin, tresorier, manager (lecture seule pour manager)
 * Création et suppression : strictement réservées à admin et tresorier
 */
app.get('/api/journals', requireAuth, requirePermission('journals.read'), getJournalsHandler);
app.post('/api/journals', requireAuth, requirePermission('journals.create'), createJournalHandler);
app.put('/api/journals/:id', requireAuth, requirePermission('journals.update', resolveJournalOwnerContext), updateJournalHandler);
app.patch('/api/journals/:id', requireAuth, requirePermission('journals.update', resolveJournalOwnerContext), updateJournalHandler);
app.delete('/api/journals/:id', requireAuth, requirePermission('journals.delete', resolveJournalOwnerContext), deleteJournalHandler);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINTS API ÉCRITURES DE JOURNAUX (BANQUES, ETC.) — HERMÉTIQUES & DÉDIÉES
 * ─────────────────────────────────────────────────────────────────────────────
 * Isolation stricte : ne modifie ni n'impacte la table cashier_transactions.
 * Consultation : admin, tresorier, manager, comptable (manager = lecture seule)
 * Saisie et suppression : strictement réservées à admin et tresorier
 */
app.get('/api/journals/:journalId/entries', requireAuth, requirePermission('journal_entries.read'), getJournalEntriesHandler);
app.get('/api/journals/:journalId/chart-data', requireAuth, requirePermission('journal_entries.chart_read'), getJournalChartDataHandler);
app.post('/api/journals/:journalId/entries', requireAuth, requirePermission('journal_entries.create', resolveJournalOwnerContext), createJournalEntryHandler);
app.put('/api/journals/:journalId/entries/:id', requireAuth, requirePermission('journal_entries.update', resolveJournalOwnerContext), updateJournalEntryHandler);
app.patch('/api/journals/:journalId/entries/:id', requireAuth, requirePermission('journal_entries.update', resolveJournalOwnerContext), updateJournalEntryHandler);
app.delete('/api/journals/:journalId/entries/:id', requireAuth, requirePermission('journal_entries.delete', resolveJournalOwnerContext), deleteJournalEntryHandler);

// Module Prospects : contrôles serveur dédiés à chaque capacité.
app.get('/api/prospects/assignees', requireAuth, requirePermission('prospects.read'), listProspectAssigneesHandler);
app.get('/api/prospects', requireAuth, requirePermission('prospects.read'), listProspectsHandler);
app.post('/api/prospects', requireAuth, requirePermission('prospects.create'), createProspectHandler);
app.patch('/api/prospects/:id', requireAuth, requirePermission('prospects.update'), updateProspectHandler);
app.delete('/api/prospects/:id', requireAuth, requirePermission('prospects.delete'), deleteProspectHandler);

// Module Dossiers : lecture et création protégées par les permissions Caisse.
app.get('/api/dossiers', requireAuth, requirePermission('cashier.read'), listDossiersHandler);
app.get('/api/dossiers/expenses', requireAuth, requirePermission('cashier.read'), getDossierExpenseSummaryHandler);
app.post('/api/dossiers', requireAuth, (req, res, next) => {
  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string } | undefined;
  const permission = authenticatedUser?.role === 'manager' ? 'cashier.read' : 'cashier.create';
  requirePermission(permission)(req, res, next);
}, createDossierHandler);

// Centre de gestion des accès : contrôles serveur dédiés à chaque capacité.
app.get('/api/access-control/me', requireAuth, getMyAccessPermissionsHandler);
app.get('/api/access-control/roles', requireAuth, requirePermission('access.roles.read'), listAccessRolesHandler);
app.post('/api/access-control/roles', requireAuth, requirePermission('access.roles.manage'), createAccessRoleHandler);
app.patch('/api/access-control/roles/:roleId', requireAuth, requirePermission('access.roles.manage'), updateAccessRoleHandler);
app.delete('/api/access-control/roles/:roleId', requireAuth, requirePermission('access.roles.manage'), deleteAccessRoleHandler);
app.get('/api/access-control/permissions', requireAuth, requirePermission('access.permissions.read'), listAccessPermissionsHandler);
app.get('/api/access-control/roles/:roleId/permissions', requireAuth, requirePermission('access.roles.read'), getRolePermissionsHandler);
app.put('/api/access-control/roles/:roleId/permissions', requireAuth, requirePermission('access.permissions.assign'), replaceRolePermissionsHandler);
app.get('/api/access-control/users', requireAuth, requirePermission('access.users.read'), listAccessUsersHandler);
app.get('/api/access-control/users/:userId', requireAuth, requirePermission('access.users.read'), getUserAccessHandler);
app.post('/api/access-control/users/:userId/roles', requireAuth, requirePermission('access.users.assign_roles'), assignAccessRoleHandler);
app.delete('/api/access-control/users/:userId/roles/:roleId', requireAuth, requirePermission('access.users.assign_roles'), revokeAccessRoleHandler);
app.put('/api/access-control/users/:userId/overrides', requireAuth, requirePermission('access.users.override'), setUserPermissionOverrideHandler);
app.delete('/api/access-control/users/:userId/overrides/:overrideId', requireAuth, requirePermission('access.users.override'), revokeUserPermissionOverrideHandler);
app.get('/api/access-control/audit', requireAuth, requirePermission('access.audit.read'), listAccessAuditHandler);

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
