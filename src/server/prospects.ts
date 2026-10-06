import express from 'express';
import { PROSPECT_STATUSES, ProspectStatus } from '../app/core/models/prospect.model';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEARCH_PATTERN = /[^a-zA-Z0-9@.+\-\s]/g;

interface ProspectMutation {
  name?: string;
  company_name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  status?: ProspectStatus;
  assigned_to?: string | null;
  estimated_value?: number | null;
  currency?: string;
  next_follow_up?: string | null;
  notes?: string;
}

export function validateProspectPayload(value: unknown, partial = false): { data?: ProspectMutation; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Le corps de la demande est invalide.' };
  const input = value as Record<string, unknown>;
  const data: ProspectMutation = {};
  const allowed = new Set([
    'name', 'companyName', 'contactName', 'contactRole', 'email', 'phone', 'source', 'status',
    'assignedTo', 'estimatedValue', 'currency', 'nextFollowUp', 'notes',
    'country', 'sector',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { error: 'La demande contient un champ non autorisé.' };

  const readString = (key: string, column: keyof ProspectMutation, maxLength: number, nullable = true): string | null | undefined => {
    if (!Object.hasOwn(input, key)) return undefined;
    const raw = input[key];
    if (raw === null && nullable) {
      data[column] = null as never;
      return undefined;
    }
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if ((!nullable && !trimmed) || trimmed.length > maxLength) return null;
    data[column] = trimmed as never;
    return trimmed;
  };

  const companyName = readString('companyName', 'company_name', 200);
  const contactName = readString('contactName', 'contact_name', 200);

  let name = readString('name', 'name', 200, true);
  if (!name && companyName) {
    name = companyName;
    data.name = companyName;
  } else if (!name && contactName) {
    name = contactName;
    data.name = contactName;
  }

  if (name === null || (!partial && name === undefined)) return { error: 'Le nom de la société est obligatoire (2 à 200 caractères).' };
  if (name && name.length < 2) return { error: 'Le nom du prospect doit contenir au moins 2 caractères.' };

  const sector = typeof input['sector'] === 'string' ? input['sector'].trim().slice(0, 100) : '';
  const country = typeof input['country'] === 'string' ? input['country'].trim().slice(0, 100) : '';
  const contactRole = typeof input['contactRole'] === 'string' ? input['contactRole'].trim().slice(0, 100) : '';

  if (sector && !input['source']) {
    data.source = sector;
  }
  if ((country || contactRole || Object.hasOwn(input, 'country') || Object.hasOwn(input, 'contactRole')) && !input['notes']) {
    data.notes = JSON.stringify({ country, contactRole });
  }

  const boundedFields: [string, keyof ProspectMutation, number][] = [
    ['phone', 'phone', 40],
    ['source', 'source', 100],
    ['notes', 'notes', 10000],
  ];
  for (const [key, column, max] of boundedFields) {
    if (column === 'notes' && data.notes) continue;
    const parsed = readString(key, column, max);
    if (parsed === null) return { error: `Le champ ${key} est invalide ou trop long.` };
  }

  const email = readString('email', 'email', 320);
  if (email === null) return { error: 'Adresse e-mail invalide.' };
  if (email && !EMAIL_PATTERN.test(email)) return { error: 'Adresse e-mail invalide.' };

  if (Object.hasOwn(input, 'status')) {
    if (typeof input['status'] !== 'string' || !PROSPECT_STATUSES.includes(input['status'] as ProspectStatus)) {
      return { error: 'Le statut du prospect est invalide.' };
    }
    data.status = input['status'] as ProspectStatus;
  }

  if (Object.hasOwn(input, 'assignedTo')) {
    const assignee = input['assignedTo'];
    if (assignee === null || assignee === '') data.assigned_to = null;
    else if (typeof assignee === 'string' && UUID_PATTERN.test(assignee)) data.assigned_to = assignee;
    else return { error: 'Le responsable sélectionné est invalide.' };
  }

  if (Object.hasOwn(input, 'estimatedValue')) {
    const amount = input['estimatedValue'];
    if (amount === null || amount === '') data.estimated_value = null;
    else if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) data.estimated_value = amount;
    else return { error: 'La valeur estimée doit être un nombre positif.' };
  }

  if (Object.hasOwn(input, 'currency')) {
    if (typeof input['currency'] !== 'string' || !/^[A-Za-z]{3}$/.test(input['currency'].trim())) {
      return { error: 'La devise doit être un code ISO de trois lettres.' };
    }
    data.currency = input['currency'].trim().toUpperCase();
  }

  if (Object.hasOwn(input, 'nextFollowUp')) {
    const followUp = input['nextFollowUp'];
    if (followUp === null || followUp === '') data.next_follow_up = null;
    else if (typeof followUp === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(followUp)
      && new Date(`${followUp}T00:00:00.000Z`).toISOString().slice(0, 10) === followUp) {
      data.next_follow_up = followUp;
    } else return { error: 'La date de relance est invalide.' };
  }

  if (Object.keys(data).length === 0) return { error: 'Aucun champ valide à enregistrer.' };
  return { data };
}

const actor = (req: express.Request): { id: string; email?: string; role?: string } | undefined =>
  (req as unknown as Record<string, unknown>)['user'] as { id: string; email?: string; role?: string } | undefined;

const sendDatabaseError = (res: express.Response, error: { code?: string; message?: string }): void => {
  if (error.code === '23503') {
    res.status(400).json({ error: 'Le responsable sélectionné n’existe pas.' });
    return;
  }
  console.error('[PROSPECTS] Erreur base de données:', error.message || error.code || 'inconnue');
  res.status(500).json({ error: 'Impossible de traiter le prospect pour le moment.' });
};

export const listProspectsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Prospects est indisponible.' });
    return;
  }

  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 25;
  const rawOffset = Number(req.query['offset']);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;
  const rawStatus = req.query['status'];
  const search = typeof req.query['search'] === 'string'
    ? req.query['search'].replace(SEARCH_PATTERN, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
    : '';

  let query = adminClient
    .from('prospects')
    .select('id, name, company_name, contact_name, email, phone, source, status, assigned_to, estimated_value, currency, next_follow_up, notes, created_by, created_at, updated_at', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (typeof rawStatus === 'string' && rawStatus) {
    if (!PROSPECT_STATUSES.includes(rawStatus as ProspectStatus)) {
      res.status(400).json({ error: 'Le filtre de statut est invalide.' });
      return;
    }
    query = query.eq('status', rawStatus);
  }
  if (search) query = query.or(`name.ilike.%${search}%,company_name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%`);

  const { data, error, count } = await query;
  if (error) {
    sendDatabaseError(res, error);
    return;
  }
  res.json({ prospects: data || [], total: count ?? data?.length ?? 0, limit, offset });
};

export const listProspectAssigneesHandler = async (_req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Prospects est indisponible.' });
    return;
  }
  const { data, error } = await adminClient
    .from('profiles')
    .select('id, first_name, last_name, email')
    .eq('is_active', true)
    .order('last_name', { ascending: true });
  if (error) {
    sendDatabaseError(res, error);
    return;
  }
  res.json({ assignees: data || [] });
};

export const createProspectHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const currentUser = actor(req);
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Prospects est indisponible.' });
    return;
  }
  const parsed = validateProspectPayload(req.body);
  if (!parsed.data || !currentUser) {
    res.status(parsed.data ? 401 : 400).json({ error: parsed.error || 'Utilisateur non authentifié.' });
    return;
  }
  if (parsed.data.assigned_to) {
    const { data: assignee, error: assigneeError } = await adminClient.from('profiles').select('id').eq('id', parsed.data.assigned_to).eq('is_active', true).maybeSingle();
    if (assigneeError || !assignee) {
      res.status(400).json({ error: 'Le responsable sélectionné est introuvable ou inactif.' });
      return;
    }
  }
  const { data, error } = await adminClient.from('prospects').insert({ ...parsed.data, created_by: currentUser.id }).select('*').single();
  if (error || !data) {
    sendDatabaseError(res, error || { message: 'insert returned no row' });
    return;
  }
  await writeAuditLog(adminClient, { userId: currentUser.id, userEmail: currentUser.email, userRole: currentUser.role, action: 'CREATE_PROSPECT', entityType: 'prospect', entityId: data.id, details: { status: data.status }, ipAddress: req.ip || null });
  res.status(201).json({ prospect: data });
};

export const updateProspectHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const currentUser = actor(req);
  const rawId = req.params['id'];
  const prospectId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Prospects est indisponible.' });
    return;
  }
  if (!prospectId || !UUID_PATTERN.test(prospectId)) {
    res.status(400).json({ error: 'Identifiant de prospect invalide.' });
    return;
  }
  const parsed = validateProspectPayload(req.body, true);
  if (!parsed.data || !currentUser) {
    res.status(parsed.data ? 401 : 400).json({ error: parsed.error || 'Utilisateur non authentifié.' });
    return;
  }
  if (parsed.data.assigned_to) {
    const { data: assignee, error: assigneeError } = await adminClient.from('profiles').select('id').eq('id', parsed.data.assigned_to).eq('is_active', true).maybeSingle();
    if (assigneeError || !assignee) {
      res.status(400).json({ error: 'Le responsable sélectionné est introuvable ou inactif.' });
      return;
    }
  }
  const { data, error } = await adminClient.from('prospects').update(parsed.data).eq('id', prospectId).select('*').maybeSingle();
  if (error) {
    sendDatabaseError(res, error);
    return;
  }
  if (!data) {
    res.status(404).json({ error: 'Prospect introuvable.' });
    return;
  }
  await writeAuditLog(adminClient, { userId: currentUser.id, userEmail: currentUser.email, userRole: currentUser.role, action: 'UPDATE_PROSPECT', entityType: 'prospect', entityId: prospectId, details: { fields: Object.keys(parsed.data) }, ipAddress: req.ip || null });
  res.json({ prospect: data });
};

export const deleteProspectHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const currentUser = actor(req);
  const rawId = req.params['id'];
  const prospectId = Array.isArray(rawId) ? rawId[0] : rawId;
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Prospects est indisponible.' });
    return;
  }
  if (!prospectId || !UUID_PATTERN.test(prospectId)) {
    res.status(400).json({ error: 'Identifiant de prospect invalide.' });
    return;
  }
  const { data, error } = await adminClient.from('prospects').delete().eq('id', prospectId).select('id').maybeSingle();
  if (error) {
    sendDatabaseError(res, error);
    return;
  }
  if (!data) {
    res.status(404).json({ error: 'Prospect introuvable.' });
    return;
  }
  await writeAuditLog(adminClient, { userId: currentUser?.id, userEmail: currentUser?.email, userRole: currentUser?.role, action: 'DELETE_PROSPECT', entityType: 'prospect', entityId: prospectId, ipAddress: req.ip || null });
  res.json({ deleted: true });
};
