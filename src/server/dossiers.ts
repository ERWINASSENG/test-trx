import express from 'express';
import { hasPermission } from './access-control';
import { createAppNotification } from './app-notifications';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';

const MAX_DOSSIER_NUMBER_LENGTH = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Caractères spéciaux ILIKE à supprimer (PostgREST n'accepte pas \ comme escape).
const ILIKE_UNSAFE = /[%_]/g;

interface DossierActor {
  id?: string;
  email?: string;
  role?: string;
}

const getActor = (req: express.Request): DossierActor | undefined =>
  (req as unknown as Record<string, unknown>)['user'] as DossierActor | undefined;

const canManageCrmTeam = async (actorId: string, role?: string): Promise<boolean> => {
  if (role === 'admin') return true;
  return hasPermission(actorId, 'crm.team.manage', undefined);
};

const canReadCrmTeam = async (actorId: string, role?: string): Promise<boolean> => {
  if (role === 'admin') return true;
  const [read, manage] = await Promise.all([
    hasPermission(actorId, 'crm.team.read', undefined),
    hasPermission(actorId, 'crm.team.manage', undefined),
  ]);
  return read || manage;
};

export const listDossiersHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Dossiers est indisponible.' });
    return;
  }

  const actor = getActor(req);
  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 50;
  const rawOffset = Number(req.query['offset']);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;
  const search = typeof req.query['search'] === 'string'
    ? req.query['search'].trim().slice(0, MAX_DOSSIER_NUMBER_LENGTH)
    : '';
  const rawDossierId = req.query['dossierId'];
  if (rawDossierId !== undefined
    && (typeof rawDossierId !== 'string' || !UUID_PATTERN.test(rawDossierId))) {
    res.status(400).json({ error: 'Le dossier sélectionné est invalide.' });
    return;
  }

  let query = adminClient
    .from('dossiers')
    .select('id, no_dossier, prospect_id, opportunity_id, client, statut, description, created_by, assigned_to, created_at, updated_at', { count: 'exact' })
    .order('no_dossier', { ascending: true })
    .range(offset, offset + limit - 1);

  if (actor?.id) {
    const hasGlobalTeamView = await canReadCrmTeam(actor.id, actor.role);
    if (!hasGlobalTeamView) {
      // S1: L'acteur ne voit que les dossiers assignés à lui ou créés par lui
      query = query.or(`assigned_to.eq.${actor.id},created_by.eq.${actor.id}`);
    }
  }

  if (search) query = query.ilike('no_dossier', `%${search.replace(ILIKE_UNSAFE, '')}%`);
  if (typeof rawDossierId === 'string') query = query.eq('id', rawDossierId);

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
      ...(typeof row.opportunity_id === 'string' ? { opportunityId: row.opportunity_id } : {}),
      noDossier: String(row.no_dossier),
      client: typeof row.client === 'string' ? row.client : null,
      statut: String(row.statut),
      description: typeof row.description === 'string' ? row.description : null,
      createdBy: typeof row.created_by === 'string' ? row.created_by : null,
      assignedTo: typeof row.assigned_to === 'string' ? row.assigned_to : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
    total: count ?? data?.length ?? 0,
    limit,
    offset,
  });
};

export const listDossierAssigneesHandler = async (
  _req: express.Request,
  res: express.Response
): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Dossiers est indisponible.' });
    return;
  }

  const { data, error } = await adminClient
    .from('profiles')
    .select('id, first_name, last_name, email')
    .eq('is_active', true)
    .order('last_name', { ascending: true });
  if (error) {
    console.error('[DOSSIERS] Erreur de lecture des responsables:', error.message);
    res.status(500).json({ error: 'Impossible de charger la liste des responsables.' });
    return;
  }
  res.json({ assignees: data || [] });
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
  const rawAssignee = req.body?.['assignedTo'];
  if (rawAssignee !== undefined && rawAssignee !== null && (typeof rawAssignee !== 'string' || !UUID_PATTERN.test(rawAssignee))) {
    res.status(400).json({ error: 'Le commercial sélectionné est invalide.' });
    return;
  }
  const assignedTo = typeof rawAssignee === 'string' && rawAssignee ? rawAssignee : null;
  if (assignedTo && !(await canManageCrmTeam(actor.id, actor.role))) {
    res.status(403).json({ error: 'Vous ne pouvez pas attribuer ce dossier à un commercial.' });
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
  if (assignedTo) {
    const { data: assignee, error: assigneeError } = await adminClient
      .from('profiles')
      .select('id')
      .eq('id', assignedTo)
      .eq('is_active', true)
      .maybeSingle();
    if (assigneeError) {
      console.error('[DOSSIERS] Erreur de vérification du commercial:', assigneeError.message);
      res.status(500).json({ error: 'Impossible de vérifier le commercial sélectionné.' });
      return;
    }
    if (!assignee) {
      res.status(400).json({ error: 'Le commercial sélectionné est introuvable ou inactif.' });
      return;
    }
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
    assigned_to: assignedTo,
  };
  const { data, error } = await adminClient
    .from('dossiers')
    .insert(dossierInsert)
    .select('id, no_dossier, prospect_id, client, statut, description, created_by, assigned_to, created_at, updated_at')
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

  if (assignedTo) {
    await createAppNotification(adminClient, {
      recipientId: assignedTo,
      actorId: actor.id,
      notificationType: 'assignment',
      title: 'Nouveau dossier attribué',
      message: `Le dossier ${String(data.no_dossier)} vous a été attribué.`,
      href: `/dossiers?dossierId=${data.id}`,
      sourceType: 'dossier',
      sourceId: String(data.id),
      dedupeKey: `dossier:${data.id}:assigned:${assignedTo}:${data.updated_at}`,
    });
  }

  res.status(201).json({
    dossier: {
      id: String(data.id),
      ...(typeof data.prospect_id === 'string' ? { prospectId: data.prospect_id } : {}),
      noDossier: String(data.no_dossier),
      client: typeof data.client === 'string' ? data.client : null,
      statut: String(data.statut),
      description: typeof data.description === 'string' ? data.description : null,
      createdBy: typeof data.created_by === 'string' ? data.created_by : null,
      assignedTo: typeof data.assigned_to === 'string' ? data.assigned_to : null,
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    },
  });
};

export const assignDossierHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const actor = getActor(req);
  const rawId = req.params['id'];
  const dossierId = Array.isArray(rawId) ? rawId[0] : rawId;
  const rawAssignee = req.body?.['assignedTo'];

  if (!adminClient) {
    res.status(503).json({ error: 'Le service Dossiers est indisponible.' });
    return;
  }
  if (!actor?.id) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  if (!dossierId || !UUID_PATTERN.test(dossierId)
    || (rawAssignee !== null && rawAssignee !== '' && (typeof rawAssignee !== 'string' || !UUID_PATTERN.test(rawAssignee)))) {
    res.status(400).json({ error: 'Le dossier ou le commercial sélectionné est invalide.' });
    return;
  }
  const hasTeamManage = await canManageCrmTeam(actor.id, actor.role);
  if (!hasTeamManage) {
    res.status(403).json({ error: 'Vous ne pouvez pas attribuer les dossiers.' });
    return;
  }

  const assignedTo = typeof rawAssignee === 'string' && rawAssignee ? rawAssignee : null;
  const { data: current, error: currentError } = await adminClient
    .from('dossiers')
    .select('id, no_dossier, assigned_to')
    .eq('id', dossierId)
    .maybeSingle();
  if (currentError) {
    console.error('[DOSSIERS] Erreur de lecture avant affectation:', currentError.message);
    res.status(500).json({ error: 'Impossible de vérifier le dossier.' });
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'Dossier introuvable.' });
    return;
  }
  if (current.assigned_to === assignedTo) {
    res.json({ assignedTo });
    return;
  }
  if (assignedTo) {
    const { data: assignee, error: assigneeError } = await adminClient
      .from('profiles')
      .select('id')
      .eq('id', assignedTo)
      .eq('is_active', true)
      .maybeSingle();
    if (assigneeError || !assignee) {
      if (assigneeError) console.error('[DOSSIERS] Erreur de vérification du commercial:', assigneeError.message);
      res.status(assigneeError ? 500 : 400).json({
        error: assigneeError ? 'Impossible de vérifier le commercial sélectionné.' : 'Le commercial sélectionné est introuvable ou inactif.',
      });
      return;
    }
  }
  const { data, error } = await adminClient
    .from('dossiers')
    .update({ assigned_to: assignedTo, updated_at: new Date().toISOString() })
    .eq('id', dossierId)
    .select('id, no_dossier, assigned_to, updated_at')
    .single();
  if (error || !data) {
    console.error('[DOSSIERS] Échec de l’affectation:', error?.message || 'aucune ligne retournée');
    res.status(500).json({ error: 'Impossible d’attribuer le dossier.' });
    return;
  }

  await writeAuditLog(adminClient, {
    userId: actor.id,
    userEmail: actor.email,
    userRole: actor.role,
    action: 'ASSIGN_DOSSIER',
    entityType: 'dossier',
    entityId: dossierId,
    details: { previousAssignee: current.assigned_to, assignedTo },
    ipAddress: req.ip || null,
  });
  if (assignedTo) {
    await createAppNotification(adminClient, {
      recipientId: assignedTo,
      actorId: actor.id,
      notificationType: 'assignment',
      title: 'Dossier attribué',
      message: `Le dossier ${String(data.no_dossier)} vous a été attribué.`,
      href: `/dossiers?dossierId=${data.id}`,
      sourceType: 'dossier',
      sourceId: dossierId,
      dedupeKey: `dossier:${dossierId}:assigned:${assignedTo}:${data.updated_at}`,
    });
  }
  res.json({ assignedTo });
};
