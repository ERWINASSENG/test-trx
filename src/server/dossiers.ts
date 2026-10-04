import express from 'express';
import { hasPermission } from './access-control';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';

const MAX_DOSSIER_NUMBER_LENGTH = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DossierActor = {
  id?: string;
  email?: string;
  role?: string;
};

const getActor = (req: express.Request): DossierActor | undefined =>
  (req as unknown as Record<string, unknown>)['user'] as DossierActor | undefined;

export const listDossiersHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Dossiers est indisponible.' });
    return;
  }

  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
  const rawOffset = Number(req.query['offset']);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;
  const search = typeof req.query['search'] === 'string'
    ? req.query['search'].trim().slice(0, MAX_DOSSIER_NUMBER_LENGTH)
    : '';

  let query = adminClient
    .from('dossiers')
    .select('id, no_dossier, prospect_id, client, statut, description, created_by, created_at, updated_at', { count: 'exact' })
    .order('no_dossier', { ascending: true })
    .range(offset, offset + limit - 1);

  if (search) query = query.ilike('no_dossier', `%${search.replace(/[%_,]/g, '')}%`);

  const { data, error, count } = await query;
  if (error) {
    console.error('[DOSSIERS] Erreur de lecture:', error.message);
    res.status(500).json({ error: 'Impossible de charger les dossiers pour le moment.' });
    return;
  }

  res.json({
    dossiers: (data || []).map((row) => ({
      id: String(row.id),
      ...(typeof row.prospect_id === 'string' ? { prospectId: row.prospect_id } : {}),
      noDossier: String(row.no_dossier),
      client: typeof row.client === 'string' ? row.client : null,
      statut: String(row.statut),
      description: typeof row.description === 'string' ? row.description : null,
      createdBy: typeof row.created_by === 'string' ? row.created_by : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
    total: count ?? data?.length ?? 0,
    limit,
    offset,
  });
};

export const createDossierHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const actor = getActor(req);
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Dossiers est indisponible.' });
    return;
  }
  if (!actor?.id) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  const rawNumber = req.body?.['noDossier'] ?? req.body?.['no_dossier'];
  if (typeof rawNumber !== 'string') {
    res.status(400).json({ error: 'Le numéro de dossier est obligatoire.' });
    return;
  }

  const noDossier = rawNumber.trim();
  if (!noDossier || noDossier.length > MAX_DOSSIER_NUMBER_LENGTH) {
    res.status(400).json({ error: 'Le numéro de dossier doit contenir entre 1 et 100 caractères.' });
    return;
  }
  const rawDescription = req.body?.['description'];
  if (rawDescription !== undefined && rawDescription !== null && typeof rawDescription !== 'string') {
    res.status(400).json({ error: 'Les informations du dossier sont invalides.' });
    return;
  }
  const description = typeof rawDescription === 'string' ? rawDescription.trim() || null : null;
  const prospectId = req.body?.['prospectId'] ?? req.body?.['prospect_id'];
  if (typeof prospectId !== 'string' || !UUID_PATTERN.test(prospectId)) {
    res.status(400).json({ error: 'La sélection d’un prospect valide est obligatoire.' });
    return;
  }

  if (!await hasPermission(actor.id, 'prospects.read', undefined)) {
    res.status(403).json({ error: 'Vous ne pouvez pas associer ce dossier à un prospect.' });
    return;
  }

  const { data: prospect, error: prospectError } = await adminClient
    .from('prospects')
    .select('id, name, company_name')
    .eq('id', prospectId)
    .maybeSingle();
  if (prospectError) {
    console.error('[DOSSIERS] Erreur de vérification du prospect:', prospectError.message);
    res.status(500).json({ error: 'Impossible de vérifier le prospect sélectionné.' });
    return;
  }
  if (!prospect) {
    res.status(400).json({ error: 'Le prospect sélectionné est introuvable.' });
    return;
  }
  const companyName = typeof prospect.company_name === 'string' ? prospect.company_name.trim() : '';
  const prospectName = typeof prospect.name === 'string' ? prospect.name.trim() : '';
  const client = companyName || prospectName;
  if (!client) {
    res.status(400).json({ error: 'Le prospect sélectionné ne possède pas de nom de client valide.' });
    return;
  }

  const { data: existingDossier, error: lookupError } = await adminClient
    .from('dossiers')
    .select('id')
    .eq('no_dossier', noDossier)
    .maybeSingle();
  if (lookupError) {
    console.error('[DOSSIERS] Erreur de vérification du numéro:', lookupError.message);
    res.status(500).json({ error: 'Impossible de vérifier le numéro de dossier pour le moment.' });
    return;
  }
  if (existingDossier) {
    res.status(409).json({ error: 'Ce numéro de dossier existe déjà.' });
    return;
  }

  const dossierInsert = {
    no_dossier: noDossier,
    client,
    description,
    created_by: actor.id,
    prospect_id: prospectId,
  };
  const { data, error } = await adminClient
    .from('dossiers')
    .insert(dossierInsert)
    .select('id, no_dossier, prospect_id, client, statut, description, created_by, created_at, updated_at')
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
      res.status(409).json({ error: 'Ce numéro de dossier existe déjà.' });
      return;
    }
    console.error('[DOSSIERS] Erreur de création:', error?.message || 'aucune ligne retournée');
    res.status(500).json({ error: 'Impossible de créer le dossier pour le moment.' });
    return;
  }

  await writeAuditLog(adminClient, {
    userId: actor.id,
    userEmail: actor.email,
    userRole: actor.role,
    action: 'CREATE_DOSSIER',
    entityType: 'dossier',
    entityId: String(data.id),
    details: {
      no_dossier: String(data.no_dossier),
      client: data.client,
      prospect_id: data.prospect_id || null,
    },
    ipAddress: req.ip || null,
  });

  res.status(201).json({
    dossier: {
      id: String(data.id),
      ...(typeof data.prospect_id === 'string' ? { prospectId: data.prospect_id } : {}),
      noDossier: String(data.no_dossier),
      client: typeof data.client === 'string' ? data.client : null,
      statut: String(data.statut),
      description: typeof data.description === 'string' ? data.description : null,
      createdBy: typeof data.created_by === 'string' ? data.created_by : null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  });
};