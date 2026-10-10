import express from 'express';
import {
  QUOTE_COLUMN_TYPES,
  QUOTE_STATUSES,
  QuoteColumn,
  QuoteColumnType,
  QuoteRow,
  QuoteStatus,
} from '../app/core/models/quote.model';
import { ProspectStatus } from '../app/core/models/prospect.model';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';
import { hasPermission } from './access-control';
import { validateProspectPayload } from './prospects';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLUMN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COLUMNS = 24;
const MAX_ROWS = 200;

interface QuoteMutation {
  prospectId?: string;
  opportunityId?: string | null;
  assignedTo?: string | null;
  title?: string;
  currency?: string;
  columns?: QuoteColumn[];
  rows?: QuoteRow[];
  totalColumnId?: string;
  status?: QuoteStatus;
  validUntil?: string | null;
}

interface QuoteActor {
  id: string;
  email?: string;
  role?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getActor = (req: express.Request): QuoteActor | undefined =>
  (req as unknown as Record<string, unknown>)['user'] as QuoteActor | undefined;

const getAdminClient = (res: express.Response) => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Le service Cotations est indisponible.' });
    return null;
  }
  return adminClient;
};

const isValidDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const validateColumns = (
  value: unknown,
  totalColumnId: unknown
): { columns?: QuoteColumn[]; totalColumnId?: string; error?: string } => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COLUMNS) {
    return { error: `La cotation doit contenir entre 1 et ${MAX_COLUMNS} colonnes.` };
  }

  const columns: QuoteColumn[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)
      || typeof item['id'] !== 'string'
      || !COLUMN_ID_PATTERN.test(item['id'])
      || typeof item['label'] !== 'string'
      || item['label'].trim().length < 1
      || item['label'].trim().length > 100
      || typeof item['type'] !== 'string'
      || !QUOTE_COLUMN_TYPES.includes(item['type'] as QuoteColumnType)) {
      return { error: 'Une colonne de la cotation est invalide.' };
    }
    if (seen.has(item['id'])) return { error: 'Les identifiants de colonnes doivent être uniques.' };
    seen.add(item['id']);
    columns.push({ id: item['id'], label: item['label'].trim(), type: item['type'] as QuoteColumnType });
  }

  const totalColumn = columns.find((column) => column.id === totalColumnId && column.type === 'amount');
  if (!totalColumn) return { error: 'Sélectionnez une colonne de type montant pour calculer le total.' };
  return { columns, totalColumnId: totalColumn.id };
};

const validateRows = (value: unknown, columns: QuoteColumn[]): { rows?: QuoteRow[]; error?: string } => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROWS) {
    return { error: `La cotation doit contenir entre 1 et ${MAX_ROWS} lignes.` };
  }

  const columnIds = new Set(columns.map((column) => column.id));
  const rows: QuoteRow[] = [];
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some((key) => !columnIds.has(key))) {
      return { error: 'Une ligne contient des valeurs pour une colonne inconnue.' };
    }
    const row: QuoteRow = {};
    for (const column of columns) {
      const raw = item[column.id];
      if (raw === undefined || raw === null || raw === '') {
        row[column.id] = null;
        continue;
      }
      if (column.type === 'text' || column.type === 'date') {
        if (typeof raw !== 'string' || raw.length > 5000
          || (column.type === 'date' && !isValidDate(raw))) {
          return { error: `La valeur de la colonne « ${column.label} » est invalide.` };
        }
        row[column.id] = raw;
      } else if (column.type === 'checkbox') {
        if (typeof raw !== 'boolean') return { error: `La valeur de la colonne « ${column.label} » est invalide.` };
        row[column.id] = raw;
      } else {
        const number = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(number) || Math.abs(number) > 999999999999.99
          || (column.type === 'amount' && number < 0)) {
          return { error: `La valeur de la colonne « ${column.label} » doit être un montant ou un nombre valide.` };
        }
        row[column.id] = number;
      }
    }
    rows.push(row);
  }
  return { rows };
};

export function validateQuotePayload(
  value: unknown,
  partial = false
): { data?: QuoteMutation; error?: string } {
  if (!isRecord(value)) return { error: 'Le corps de la demande est invalide.' };
  const allowed = new Set([
    'prospectId', 'opportunityId', 'assignedTo', 'title', 'currency', 'columns', 'rows',
    'totalColumnId', 'status', 'validUntil',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: 'La demande contient un champ non autorisé.' };
  }

  const data: QuoteMutation = {};
  if (Object.hasOwn(value, 'prospectId')) {
    if (typeof value['prospectId'] !== 'string' || !UUID_PATTERN.test(value['prospectId'])) {
      return { error: 'Le client sélectionné est invalide.' };
    }
    data.prospectId = value['prospectId'];
  } else if (!partial) return { error: 'Le client est obligatoire.' };

  if (Object.hasOwn(value, 'opportunityId')) {
    if (value['opportunityId'] === null || value['opportunityId'] === '') data.opportunityId = null;
    else if (typeof value['opportunityId'] === 'string' && UUID_PATTERN.test(value['opportunityId'])) {
      data.opportunityId = value['opportunityId'];
    } else return { error: 'L’opportunité sélectionnée est invalide.' };
  }

  if (Object.hasOwn(value, 'assignedTo')) {
    if (value['assignedTo'] === null || value['assignedTo'] === '') data.assignedTo = null;
    else if (typeof value['assignedTo'] === 'string' && UUID_PATTERN.test(value['assignedTo'])) {
      data.assignedTo = value['assignedTo'];
    } else return { error: 'Le commercial sélectionné est invalide.' };
  }

  if (Object.hasOwn(value, 'title')) {
    if (typeof value['title'] !== 'string' || value['title'].trim().length < 2 || value['title'].trim().length > 200) {
      return { error: 'Le titre doit comporter entre 2 et 200 caractères.' };
    }
    data.title = value['title'].trim();
  } else if (!partial) data.title = 'Cotation';

  if (Object.hasOwn(value, 'currency')) {
    if (typeof value['currency'] !== 'string' || !/^[A-Za-z]{3}$/.test(value['currency'].trim())) {
      return { error: 'La devise doit être un code ISO de trois lettres.' };
    }
    data.currency = value['currency'].trim().toUpperCase();
  } else if (!partial) data.currency = 'XAF';

  const structureProvided = Object.hasOwn(value, 'columns') || Object.hasOwn(value, 'rows') || Object.hasOwn(value, 'totalColumnId');
  if (structureProvided || !partial) {
    if (partial && (!Object.hasOwn(value, 'columns') || !Object.hasOwn(value, 'rows') || !Object.hasOwn(value, 'totalColumnId'))) {
      return { error: 'Les colonnes, les lignes et la colonne du total doivent être envoyées ensemble.' };
    }
    const validatedColumns = validateColumns(value['columns'], value['totalColumnId']);
    if (validatedColumns.error || !validatedColumns.columns || !validatedColumns.totalColumnId) {
      return { error: validatedColumns.error || 'La structure de la cotation est invalide.' };
    }
    const validatedRows = validateRows(value['rows'], validatedColumns.columns);
    if (validatedRows.error || !validatedRows.rows) {
      return { error: validatedRows.error || 'Les lignes de la cotation sont invalides.' };
    }
    const amountColumn = validatedColumns.columns.find((column) => column.id === validatedColumns.totalColumnId);
    const total = amountColumn
      ? validatedRows.rows.reduce((sum, row) => {
        const amount = row[amountColumn.id];
        return sum + (typeof amount === 'number' ? amount : 0);
      }, 0)
      : 0;
    if (!Number.isFinite(total) || total < 0 || total > 999999999999.99) {
      return { error: 'Le total de la cotation doit être compris entre 0 et 999 999 999 999,99.' };
    }
    data.columns = validatedColumns.columns;
    data.rows = validatedRows.rows;
    data.totalColumnId = validatedColumns.totalColumnId;
  }

  if (Object.hasOwn(value, 'status')) {
    if (typeof value['status'] !== 'string' || !QUOTE_STATUSES.includes(value['status'] as QuoteStatus)) {
      return { error: 'Le statut de la cotation est invalide.' };
    }
    data.status = value['status'] as QuoteStatus;
  } else if (!partial) data.status = 'draft';

  if (Object.hasOwn(value, 'validUntil')) {
    if (value['validUntil'] === null || value['validUntil'] === '') data.validUntil = null;
    else if (typeof value['validUntil'] === 'string' && isValidDate(value['validUntil'])) {
      data.validUntil = value['validUntil'];
    } else return { error: 'La date de validité est invalide.' };
  } else if (!partial) data.validUntil = null;

  if (Object.keys(data).length === 0) return { error: 'Aucun champ valide à enregistrer.' };
  return { data };
}

const mapQuoteToDatabase = (data: QuoteMutation): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  if (data.prospectId !== undefined) result['prospect_id'] = data.prospectId;
  if (data.opportunityId !== undefined) result['opportunity_id'] = data.opportunityId;
  if (data.assignedTo !== undefined) result['assigned_to'] = data.assignedTo;
  if (data.title !== undefined) result['title'] = data.title;
  if (data.currency !== undefined) result['currency'] = data.currency;
  if (data.columns !== undefined) result['columns'] = data.columns;
  if (data.rows !== undefined) result['rows'] = data.rows;
  if (data.totalColumnId !== undefined) result['total_column_id'] = data.totalColumnId;
  if (data.status !== undefined) result['status'] = data.status;
  if (data.validUntil !== undefined) result['valid_until'] = data.validUntil;
  if (data.columns && data.rows && data.totalColumnId) {
    const amountColumn = data.columns.find((column) => column.id === data.totalColumnId);
    if (amountColumn) {
      const total = data.rows.reduce((sum, row) => {
        const value = row[amountColumn.id];
        return sum + (typeof value === 'number' ? value : 0);
      }, 0);
      result['total_amount'] = Math.round((total + Number.EPSILON) * 100) / 100;
    }
  }
  return result;
};

const auditQuote = async (
  req: express.Request,
  actor: QuoteActor,
  entry: { action: string; entityId: string; details?: Record<string, unknown> }
): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) return;
  await writeAuditLog(adminClient, {
    userId: actor.id,
    userEmail: actor.email,
    userRole: actor.role,
    action: entry.action,
    entityType: 'sales_quote',
    entityId: entry.entityId,
    details: entry.details,
    ipAddress: req.ip || null,
  });
};

const actorCanManageAllQuotes = async (actorId: string): Promise<boolean> =>
  hasPermission(actorId, 'quotes.assign', undefined);

const validateAssignee = async (
  adminClient: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  assigneeId: string
): Promise<{ valid: boolean; error?: { code?: string; message?: string } }> => {
  const { data: role, error: roleError } = await adminClient.from('access_roles')
    .select('id').eq('role_key', 'commercial').eq('is_active', true).maybeSingle();
  if (roleError) return { valid: false, error: roleError };
  if (!role) return { valid: false };
  const { data, error } = await adminClient.from('access_user_roles')
    .select('user_id, expires_at')
    .eq('role_id', role.id)
    .eq('user_id', assigneeId)
    .maybeSingle();
  if (error) return { valid: false, error };
  if (!data) return { valid: false };
  return { valid: !data.expires_at || Date.parse(data.expires_at) > Date.now() };
};

const sendQuoteDatabaseError = (res: express.Response, error: { code?: string; message?: string }): void => {
  if (error.code === '23503') {
    res.status(400).json({ error: 'Le client ou le commercial sélectionné n’existe pas.' });
    return;
  }
  console.error('[QUOTES] Erreur base de données:', error.message || error.code || 'inconnue');
  res.status(500).json({ error: 'Impossible de traiter la cotation pour le moment.' });
};

const toQuoteResponse = (row: Record<string, unknown>, prospectName = 'Client supprimé'): Record<string, unknown> => ({
  id: row['id'],
  quoteNumber: row['quote_number'],
  prospectId: row['prospect_id'],
  opportunityId: row['opportunity_id'] ?? null,
  prospectName,
  assignedTo: row['assigned_to'],
  createdBy: row['created_by'],
  title: row['title'],
  currency: row['currency'],
  columns: row['columns'],
  rows: row['rows'],
  totalColumnId: row['total_column_id'],
  totalAmount: row['total_amount'],
  status: row['status'],
  validUntil: row['valid_until'],
  createdAt: row['created_at'],
  updatedAt: row['updated_at'],
});

const expireDueQuotes = async (
  adminClient: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  actorId: string,
  canManageAll: boolean
): Promise<boolean> => {
  const today = new Date().toISOString().slice(0, 10);
  let query = adminClient.from('sales_quotes')
    .update({ status: 'expired' })
    .in('status', ['draft', 'sent'])
    .lt('valid_until', today);
  if (!canManageAll) query = query.eq('assigned_to', actorId);
  const { error } = await query;
  if (error) console.error('[QUOTES] Expiration automatique impossible:', error.message);
  return !error;
};

export const resolveQuoteCollectionContext = async (req: express.Request) => {
  const actor = getActor(req);
  return actor?.id ? { ownerUserId: actor.id } : undefined;
};

export const resolveQuoteOwnerContext = async (req: express.Request) => {
  const quoteId = req.params['id'];
  const adminClient = getSupabaseAdmin();
  if (typeof quoteId !== 'string' || !adminClient) return undefined;
  const { data } = await adminClient.from('sales_quotes').select('assigned_to').eq('id', quoteId).maybeSingle();
  return data?.assigned_to ? { ownerUserId: String(data.assigned_to) } : undefined;
};

export const resolveQuoteTemplateOwnerContext = async (req: express.Request) => {
  const templateId = req.params['id'];
  const adminClient = getSupabaseAdmin();
  if (typeof templateId !== 'string' || !adminClient) return undefined;
  const { data } = await adminClient.from('sales_quote_templates').select('created_by').eq('id', templateId).maybeSingle();
  return data?.created_by ? { ownerUserId: String(data.created_by) } : undefined;
};

export const listQuoteProspectsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  if (!adminClient || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  let query = adminClient.from('prospects')
    .select('id, name, company_name, contact_name, email, phone, status, assigned_to')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (!await actorCanManageAllQuotes(actor.id)) {
    query = query.or(`assigned_to.eq.${actor.id},assigned_to.is.null`);
  }
  const { data, error } = await query;
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  res.json({ prospects: data || [] });
};

export const createQuoteProspectHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  if (!adminClient || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const validated = validateProspectPayload(req.body);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'Les informations du prospect sont invalides.' });
    return;
  }
  const canManageAll = await actorCanManageAllQuotes(actor.id);
  const rawAssignedTo = isRecord(req.body) && typeof req.body['assignedTo'] === 'string'
    ? req.body['assignedTo'] : actor.id;
  const assignedTo = canManageAll ? rawAssignedTo : actor.id;
  if (!UUID_PATTERN.test(assignedTo)) {
    res.status(400).json({ error: 'Choisissez un commercial actif pour ce nouveau client.' });
    return;
  }
  const assigneeCheck = await validateAssignee(adminClient, assignedTo);
  if (assigneeCheck.error) {
    sendQuoteDatabaseError(res, assigneeCheck.error);
    return;
  }
  if (!assigneeCheck.valid) {
    res.status(400).json({ error: 'Choisissez un commercial actif pour ce nouveau client.' });
    return;
  }
  const { data, error } = await adminClient.from('prospects').insert({
    ...validated.data,
    status: (validated.data.status || 'new') as ProspectStatus,
    assigned_to: assignedTo,
    created_by: actor.id,
  }).select('id, name, company_name, contact_name, email, phone, status, assigned_to').single();
  if (error || !data) {
    sendQuoteDatabaseError(res, error || { message: 'prospect insert returned no row' });
    return;
  }
  res.status(201).json({ prospect: data });
};

export const listQuoteAssigneesHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  if (!adminClient) return;
  const { data: role, error: roleError } = await adminClient.from('access_roles')
    .select('id').eq('role_key', 'commercial').eq('is_active', true).maybeSingle();
  if (roleError) {
    sendQuoteDatabaseError(res, roleError);
    return;
  }
  if (!role) {
    res.json({ assignees: [] });
    return;
  }
  const { data: assignments, error: assignmentsError } = await adminClient.from('access_user_roles')
    .select('user_id, expires_at').eq('role_id', role.id);
  if (assignmentsError) {
    sendQuoteDatabaseError(res, assignmentsError);
    return;
  }
  const ids = (assignments || [])
    .filter((assignment) => !assignment.expires_at || Date.parse(assignment.expires_at) > Date.now())
    .map((assignment) => String(assignment.user_id));
  if (ids.length === 0) {
    res.json({ assignees: [] });
    return;
  }
  const { data, error } = await adminClient.from('profiles')
    .select('id, first_name, last_name, email').in('id', ids).eq('is_active', true).order('last_name');
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  res.json({ assignees: data || [] });
};

export const listQuotesHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  if (!adminClient || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const canManageAll = await actorCanManageAllQuotes(actor.id);
  if (!await expireDueQuotes(adminClient, actor.id, canManageAll)) {
    res.status(500).json({ error: 'Impossible de mettre à jour les cotations expirées.' });
    return;
  }
  const status = req.query['status'];
  let query = adminClient.from('sales_quotes').select('*').order('updated_at', { ascending: false }).limit(200);
  if (!canManageAll) query = query.eq('assigned_to', actor.id);
  if (typeof status === 'string' && status) {
    if (!QUOTE_STATUSES.includes(status as QuoteStatus)) {
      res.status(400).json({ error: 'Le filtre de statut est invalide.' });
      return;
    }
    query = query.eq('status', status);
  }
  const { data, error } = await query;
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  const rows = data || [];
  const prospectIds = [...new Set(rows.map((row) => String(row.prospect_id)))];
  const { data: prospects, error: prospectsError } = prospectIds.length
    ? await adminClient.from('prospects').select('id, name, company_name').in('id', prospectIds)
    : { data: [], error: null };
  if (prospectsError) {
    sendQuoteDatabaseError(res, prospectsError);
    return;
  }
  const prospectNames = new Map((prospects || []).map((prospect) => [
    String(prospect.id),
    String(prospect.company_name || prospect.name),
  ]));
  const assigneeIds = [...new Set(rows
    .map((row) => row.assigned_to)
    .filter((id): id is string => typeof id === 'string'))];
  const { data: assignees, error: assigneesError } = assigneeIds.length
    ? await adminClient.from('profiles').select('id, first_name, last_name').in('id', assigneeIds)
    : { data: [], error: null };
  if (assigneesError) {
    sendQuoteDatabaseError(res, assigneesError);
    return;
  }
  const assigneeNames = new Map((assignees || []).map((assignee) => [
    String(assignee.id),
    `${assignee.first_name} ${assignee.last_name}`.trim(),
  ]));
  res.json({ quotes: rows.map((row) => ({
    ...toQuoteResponse(row, prospectNames.get(String(row.prospect_id))),
    assignedToName: typeof row.assigned_to === 'string' ? assigneeNames.get(row.assigned_to) || null : null,
  })) });
};

export const createQuoteHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  if (!adminClient || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const validated = validateQuotePayload(req.body);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'La cotation est invalide.' });
    return;
  }
  const canManageAll = await actorCanManageAllQuotes(actor.id);
  const requestedAssignee = validated.data.assignedTo;
  const assignedTo = canManageAll ? requestedAssignee : actor.id;
  if (!assignedTo) {
    res.status(400).json({ error: 'Attribuez la cotation à un commercial actif.' });
    return;
  }
  const assigneeCheck = await validateAssignee(adminClient, assignedTo);
  if (assigneeCheck.error) {
    sendQuoteDatabaseError(res, assigneeCheck.error);
    return;
  }
  if (!assigneeCheck.valid) {
    res.status(400).json({ error: 'Attribuez la cotation à un commercial actif.' });
    return;
  }
  const { data: prospect, error: prospectError } = await adminClient.from('prospects')
    .select('id, assigned_to').eq('id', validated.data.prospectId).maybeSingle();
  if (prospectError) {
    sendQuoteDatabaseError(res, prospectError);
    return;
  }
  if (!prospect) {
    res.status(400).json({ error: 'Le client sélectionné est introuvable.' });
    return;
  }
  if (!canManageAll && prospect.assigned_to && prospect.assigned_to !== actor.id) {
    res.status(403).json({ error: 'Vous ne pouvez créer une cotation que pour un client qui vous est attribué.' });
    return;
  }
  if (validated.data.opportunityId) {
    const { data: opportunity, error: opportunityError } = await adminClient.from('sales_opportunities')
      .select('id, prospect_id, assigned_to').eq('id', validated.data.opportunityId).maybeSingle();
    if (opportunityError) {
      sendQuoteDatabaseError(res, opportunityError);
      return;
    }
    if (!opportunity || opportunity.prospect_id !== validated.data.prospectId) {
      res.status(400).json({ error: 'L’opportunité ne correspond pas au client sélectionné.' });
      return;
    }
    if (opportunity.assigned_to !== actor.id && !await hasPermission(actor.id, 'crm.team.manage', undefined)) {
      res.status(403).json({ error: 'Vous ne pouvez créer une cotation que pour une opportunité qui vous est attribuée.' });
      return;
    }
  }
  const { data, error } = await adminClient.from('sales_quotes').insert({
    ...mapQuoteToDatabase(validated.data),
    assigned_to: assignedTo,
    created_by: actor.id,
  }).select('*').single();
  if (error || !data) {
    sendQuoteDatabaseError(res, error || { message: 'quote insert returned no row' });
    return;
  }
  await auditQuote(req, actor, { action: 'CREATE_QUOTE', entityId: String(data.id), details: { quote_number: data.quote_number } });
  res.status(201).json({ quote: toQuoteResponse(data) });
};

export const updateQuoteHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  const id = req.params['id'];
  if (!adminClient || !actor?.id || typeof id !== 'string') {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const { data: current, error: currentError } = await adminClient.from('sales_quotes').select('*').eq('id', id).maybeSingle();
  if (currentError) {
    sendQuoteDatabaseError(res, currentError);
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'Cotation introuvable.' });
    return;
  }
  const canManageAll = await actorCanManageAllQuotes(actor.id);
  if (!canManageAll && current.assigned_to !== actor.id) {
    res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres cotations.' });
    return;
  }
  const validated = validateQuotePayload(req.body, true);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'Les modifications sont invalides.' });
    return;
  }
  const nextData = { ...validated.data };
  if (nextData.status === 'expired') {
    const validUntil = nextData.validUntil ?? current.valid_until;
    if (typeof validUntil !== 'string' || validUntil >= new Date().toISOString().slice(0, 10)) {
      res.status(400).json({ error: 'Une cotation ne peut être marquée expirée qu’après sa date de validité.' });
      return;
    }
  }
  if (canManageAll
    && nextData.prospectId !== undefined
    && nextData.prospectId !== current.prospect_id) {
    const { data: prospect, error: prospectError } = await adminClient.from('prospects')
      .select('id').eq('id', nextData.prospectId).maybeSingle();
    if (prospectError) {
      sendQuoteDatabaseError(res, prospectError);
      return;
    }
    if (!prospect) {
      res.status(400).json({ error: 'Le client sélectionné est introuvable.' });
      return;
    }
  } else if (!canManageAll) {
    delete nextData.prospectId;
  }
  if (nextData.opportunityId !== undefined) {
    const canManageCrmTeam = await hasPermission(actor.id, 'crm.team.manage', undefined);
    if (nextData.opportunityId === null) {
      if (current.opportunity_id && !canManageCrmTeam) {
        res.status(403).json({ error: 'Vous ne pouvez pas retirer le lien CRM de cette cotation.' });
        return;
      }
    } else {
      const { data: opportunity, error: opportunityError } = await adminClient.from('sales_opportunities')
        .select('id, prospect_id, assigned_to').eq('id', nextData.opportunityId).maybeSingle();
      if (opportunityError) {
        sendQuoteDatabaseError(res, opportunityError);
        return;
      }
      if (!opportunity || opportunity.prospect_id !== (nextData.prospectId || current.prospect_id)) {
        res.status(400).json({ error: 'L’opportunité ne correspond pas au client sélectionné.' });
        return;
      }
      if (opportunity.assigned_to !== actor.id && !canManageCrmTeam) {
        res.status(403).json({ error: 'Vous ne pouvez lier que vos propres opportunités à cette cotation.' });
        return;
      }
    }
  }
  if (canManageAll && nextData.assignedTo !== undefined && nextData.assignedTo !== current.assigned_to) {
    if (!nextData.assignedTo) {
      res.status(400).json({ error: 'Attribuez la cotation à un commercial actif.' });
      return;
    }
    const assigneeCheck = await validateAssignee(adminClient, nextData.assignedTo);
    if (assigneeCheck.error) {
      sendQuoteDatabaseError(res, assigneeCheck.error);
      return;
    }
    if (!assigneeCheck.valid) {
      res.status(400).json({ error: 'Attribuez la cotation à un commercial actif.' });
      return;
    }
  } else {
    delete nextData.assignedTo;
  }
  const { data, error } = await adminClient.from('sales_quotes').update(mapQuoteToDatabase(nextData))
    .eq('id', id).select('*').single();
  if (error || !data) {
    sendQuoteDatabaseError(res, error || { message: 'quote update returned no row' });
    return;
  }
  await auditQuote(req, actor, { action: 'UPDATE_QUOTE', entityId: id, details: { status: data.status } });
  res.json({ quote: toQuoteResponse(data) });
};

export const deleteQuoteHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  const id = req.params['id'];
  if (!adminClient || !actor?.id || typeof id !== 'string') {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const { data: current, error: currentError } = await adminClient.from('sales_quotes')
    .select('id, assigned_to, quote_number').eq('id', id).maybeSingle();
  if (currentError) {
    sendQuoteDatabaseError(res, currentError);
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'Cotation introuvable.' });
    return;
  }
  const canManageAll = await actorCanManageAllQuotes(actor.id);
  if (!canManageAll && current.assigned_to !== actor.id) {
    res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres cotations.' });
    return;
  }
  const { error } = await adminClient.from('sales_quotes').delete().eq('id', id);
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  await auditQuote(req, actor, { action: 'DELETE_QUOTE', entityId: id, details: { quote_number: current.quote_number } });
  res.json({ deleted: true });
};

export const listQuoteTemplatesHandler = async (_req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  if (!adminClient) return;
  const { data, error } = await adminClient.from('sales_quote_templates').select('*').order('name').limit(200);
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  res.json({ templates: data || [] });
};

export const createQuoteTemplateHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  if (!adminClient || !actor?.id || !isRecord(req.body)) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    else res.status(400).json({ error: 'Le corps de la demande est invalide.' });
    return;
  }
  const { name, columns, totalColumnId } = req.body;
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
    res.status(400).json({ error: 'Le nom du modèle doit comporter entre 2 et 120 caractères.' });
    return;
  }
  const validated = validateColumns(columns, totalColumnId);
  if (validated.error || !validated.columns || !validated.totalColumnId) {
    res.status(400).json({ error: validated.error || 'La structure du modèle est invalide.' });
    return;
  }
  const { data, error } = await adminClient.from('sales_quote_templates').insert({
    name: name.trim(),
    columns: validated.columns,
    total_column_id: validated.totalColumnId,
    created_by: actor.id,
  }).select('*').single();
  if (error || !data) {
    sendQuoteDatabaseError(res, error || { message: 'template insert returned no row' });
    return;
  }
  res.status(201).json({ template: data });
};

export const updateQuoteTemplateHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  const id = req.params['id'];
  if (!adminClient || !actor?.id || typeof id !== 'string' || !isRecord(req.body)) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    else res.status(400).json({ error: 'La demande de modification est invalide.' });
    return;
  }
  const { data: current, error: currentError } = await adminClient.from('sales_quote_templates')
    .select('created_by').eq('id', id).maybeSingle();
  if (currentError) {
    sendQuoteDatabaseError(res, currentError);
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'Modèle introuvable.' });
    return;
  }
  const canManageAll = await actorCanManageAllQuotes(actor.id);
  if (!canManageAll && current.created_by !== actor.id) {
    res.status(403).json({ error: 'Vous ne pouvez modifier que les modèles que vous avez créés.' });
    return;
  }
  const { name, columns, totalColumnId } = req.body;
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
    res.status(400).json({ error: 'Le nom du modèle doit comporter entre 2 et 120 caractères.' });
    return;
  }
  const validated = validateColumns(columns, totalColumnId);
  if (validated.error || !validated.columns || !validated.totalColumnId) {
    res.status(400).json({ error: validated.error || 'La structure du modèle est invalide.' });
    return;
  }
  const { data, error } = await adminClient.from('sales_quote_templates').update({
    name: name.trim(),
    columns: validated.columns,
    total_column_id: validated.totalColumnId,
  }).eq('id', id).select('*').single();
  if (error || !data) {
    sendQuoteDatabaseError(res, error || { message: 'template update returned no row' });
    return;
  }
  res.json({ template: data });
};

export const deleteQuoteTemplateHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  const id = req.params['id'];
  if (!adminClient || !actor?.id || typeof id !== 'string') {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const { data: current, error: currentError } = await adminClient.from('sales_quote_templates')
    .select('created_by').eq('id', id).maybeSingle();
  if (currentError) {
    sendQuoteDatabaseError(res, currentError);
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'Modèle introuvable.' });
    return;
  }
  const canManageAll = await actorCanManageAllQuotes(actor.id);
  if (!canManageAll && current.created_by !== actor.id) {
    res.status(403).json({ error: 'Vous ne pouvez supprimer que les modèles que vous avez créés.' });
    return;
  }
  const { error } = await adminClient.from('sales_quote_templates').delete().eq('id', id);
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  res.json({ deleted: true });
};
