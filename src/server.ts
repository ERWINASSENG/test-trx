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
import { UserRole } from './app/core/models/auth.model';
import { getSupabaseAdmin, requireAdmin, requireAuth, requireRole } from './server/auth';
import { getSupabaseConfigHandler } from './server/config';
import { formatPersistedPieceComptable, normalizeDateToDay } from './server/cashier.utils';
import { updateCurrentUserProfileHandler } from './server/profile';
import { createCollaboratorHandler } from './server/collaborators.create';
import { getCollaboratorsHandler } from './server/collaborators.list';
import { deleteCollaboratorHandler, updateCollaboratorHandler } from './server/collaborators.manage';
import { getOperationsHandler } from './server/cashier.read';
import { auditPiecesComptablesHandler } from './server/cashier.audit';
import { writeAuditLog } from './server/audit-log';

// Charger les variables d'environnement depuis le fichier `.env` (si présent)
dotenv.config();

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const angularApp = new AngularNodeAppEngine();

// Configuration du reverse proxy pour Cloud Run / Nginx (gestion sécurisée de l'en-tête X-Forwarded-For)
app.set('trust proxy', 1);

// En-têtes de sécurité HTTP via Helmet durcis pour Angular SSR et compatibilité iFrame AI Studio
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'https:', 'wss:'],
        frameAncestors: ["'self'", 'https://ai.studio', 'https://*.google.com', 'https://*.run.app'],
        objectSrc: ["'none'"],
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

app.get('/api/supabase-config', getSupabaseConfigHandler);
app.get('/api/config', getSupabaseConfigHandler);

const collaboratorCollectionAliases = ['/api/system/collaborators', '/api/admin/users'];

collaboratorCollectionAliases.forEach((path) => {
  app.get(path, requireAdmin, getCollaboratorsHandler);
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
    console.error('Erreur lors de la synchronisation du rôle:', err);
    res.status(500).json({ error: 'Erreur interne lors de la synchronisation du rôle.' });
  }
});

collaboratorCollectionAliases.forEach((path) => {
  app.post(path, requireAdmin, createCollaboratorHandler);
});

/**
 * Modification d'un compte collaborateur (synchronisation auth.app_metadata + public.profiles)
 */
app.patch('/api/profile/me', requireAuth, updateCurrentUserProfileHandler);

collaboratorCollectionAliases.forEach((path) => {
  app.patch(`${path}/:id`, requireAdmin, updateCollaboratorHandler);
});

/**
 * Suppression d'un compte collaborateur (auth.users + public.profiles).
 */
collaboratorCollectionAliases.forEach((path) => {
  app.delete(`${path}/:id`, requireAdmin, deleteCollaboratorHandler);
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

    // Si aucune pièce comptable n'est fournie explicitement (saisie manuelle/import), on laisse `null` :
    // le déclencheur PostgreSQL `assign_piece_comptable` (voir supabase/migrations/202609201200_...)
    // assigne alors le numéro de façon atomique (verrouillage de ligne sur le compteur de l'année),
    // ce qu'un calcul "SELECT max()+1" en Node.js ne peut pas garantir sous concurrence.
    const finalPieceComptable = candidatePiece || null;

    const rowToInsert = {
      piece_comptable: finalPieceComptable,
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
    };

    const { data, error } = await adminClient
      .from('cashier_transactions')
      .insert([rowToInsert])
      .select()
      .single();

    if (error) {
      console.error('Erreur SQL lors de l’insertion de l’opération:', error.message, error.details, error.hint);
      const isUniqueViolation = error.code === '23505' || error.message?.toLowerCase().includes('unique') || error.message?.includes('duplicate key');
      if (isUniqueViolation) {
        const detailMsg = error.details || error.message || '';
        res.status(409).json({
          error: `Erreur d'unicité : ${detailMsg.includes('piece_comptable') ? 'le numéro de pièce comptable est déjà utilisé' : 'une valeur unique est en doublon'} dans la base de données (${detailMsg || 'conflit d’unicité SQL'}).`,
        });
        return;
      }
      res.status(500).json({ error: `Erreur lors de l’enregistrement de l’opération : ${error.message || 'erreur base de données'}` });
      return;
    }

    await writeAuditLog(adminClient, {
      userId: callerId,
      userEmail: authenticatedUser?.email,
      userRole: authenticatedUser?.role,
      action: 'CREATE_OPERATION',
      entityId: data?.id ?? null,
      details: { montant, libelle, piece_comptable: data?.piece_comptable ?? finalPieceComptable },
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
        console.error('Erreur vérification droits updateOperationHandler:', fetchError.message);
        res.status(500).json({ error: 'Erreur lors de la vérification des autorisations sur l’opération.' });
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
      updateData['date'] = normalizeDateToDay(payload.date) || new Date().toISOString().slice(0, 10);
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

    const { data, error } = await adminClient
      .from('cashier_transactions')
      .update(updateData)
      .eq('id', targetId)
      .select()
      .single();

    if (error) {
      console.error('Erreur SQL lors de la mise à jour de l’opération:', error.message, error.details, error.hint);
      const isUniqueViolation = error.code === '23505' || error.message?.toLowerCase().includes('unique') || error.message?.includes('duplicate key');
      if (isUniqueViolation) {
        const detailMsg = error.details || error.message || '';
        res.status(409).json({
          error: `Erreur d'unicité : ${detailMsg.includes('piece_comptable') ? 'le numéro de pièce comptable est déjà utilisé' : 'une valeur unique est en doublon'} dans la base de données (${detailMsg || 'conflit d’unicité SQL'}).`,
        });
        return;
      }
      res.status(500).json({ error: `Erreur lors de la modification de l’opération : ${error.message || 'erreur base de données'}` });
      return;
    }

    await writeAuditLog(adminClient, {
      userId: authenticatedUser?.id,
      userEmail: authenticatedUser?.email,
      userRole: authenticatedUser?.role,
      action: 'UPDATE_OPERATION',
      entityId: targetId,
      details: { champs_modifies: Object.keys(updateData) },
    });

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

    const { error, count } = await adminClient
      .from('cashier_transactions')
      .delete({ count: 'exact' })
      .in('id', targetIds);

    if (error) {
      console.error('Erreur SQL lors de la suppression d’opérations:', error.message);
      res.status(500).json({ error: 'Erreur lors de la suppression des opérations de caisse.' });
      return;
    }

    await writeAuditLog(adminClient, {
      userId: authenticatedUser?.id,
      userEmail: authenticatedUser?.email,
      userRole: userRole,
      action: 'DELETE_OPERATION',
      entityId: targetIds.join(','),
      details: { nombre_supprime: count ?? targetIds.length, ids: targetIds },
    });

    // Nettoyage éventuel des pièces justificatives associées dans storage ou liens
    res.json({
      success: true,
      deletedCount: count ?? targetIds.length,
      message: `${targetIds.length} opération(s) supprimée(s) avec succès`,
    });
  } catch (err: unknown) {
    console.error('Erreur deleteOperationsHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la suppression des opérations.' });
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
    const rowsToInsert = await Promise.all(
      originalRows.map(async (orig) => {
        // `piece_comptable: null` -> assigné atomiquement par le déclencheur DB pour chaque ligne.
        return {
          piece_comptable: null,
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
        };
      })
    );

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
      res.status(500).json({ error: 'Erreur lors de la mise à jour du statut des opérations.' });
      return;
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

// Déclaration des routes de caisse sécurisées par RBAC strict (lecture réservée aux rôles financiers et encadrement)
const cashierReadRoles: UserRole[] = ['admin', 'manager', 'caissiere', 'comptable', 'tresorier'];
const cashierWriteRoles: UserRole[] = ['admin', 'caissiere', 'manager', 'comptable'];
const cashierDeleteRoles: UserRole[] = ['admin', 'caissiere'];
const cashierOperationAliases = ['/api/cahier/operations', '/api/cashier/transactions'];

cashierOperationAliases.forEach((path) => {
  app.get(path, requireAuth, requireRole(cashierReadRoles), getOperationsHandler);
});

// Actions en masse (Duplication & Changement de statut)
cashierOperationAliases.forEach((path) => {
  app.post(`${path}/duplicate`, requireAuth, requireRole(cashierWriteRoles), duplicateOperationsHandler);
  app.patch(`${path}/status`, requireAuth, requireRole(cashierWriteRoles), updateOperationsStatusHandler);
});

// Écriture : réservée aux Administrateurs, Caissières, Managers et Comptables
cashierOperationAliases.forEach((path) => {
  app.post(path, requireAuth, requireRole(cashierWriteRoles), saveOperationHandler);
});

cashierOperationAliases.forEach((path) => {
  app.put(`${path}/:id`, requireAuth, requireRole(cashierWriteRoles), updateOperationHandler);
  app.patch(`${path}/:id`, requireAuth, requireRole(cashierWriteRoles), updateOperationHandler);
});

// Audit de conformité et intégrité de la séquence des pièces comptables
app.get('/api/cashier/audit-pieces', requireAuth, requireRole(cashierReadRoles), auditPiecesComptablesHandler);
app.get('/api/cahier/audit-pieces', requireAuth, requireRole(cashierReadRoles), auditPiecesComptablesHandler);

// Suppression : autorisée pour les Administrateurs et Caissières (vérification stricte de propriété dans deleteOperationsHandler)
cashierOperationAliases.forEach((path) => {
  app.delete(`${path}/:id`, requireAuth, requireRole(cashierDeleteRoles), deleteOperationsHandler);
  app.delete(path, requireAuth, requireRole(cashierDeleteRoles), deleteOperationsHandler);
});

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
