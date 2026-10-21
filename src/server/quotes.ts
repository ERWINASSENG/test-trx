import express from 'express';
import {
  QUOTE_COLUMN_TYPES,
  QUOTE_STATUSES,
  QuoteColumn,
  QuoteColumnType,
  QuoteRow,
  QuoteStatus,
  SeaFreightDetails,
} from '../app/core/models/quote.model';
import { ProspectStatus } from '../app/core/models/prospect.model';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';
import { hasPermission } from './access-control';
import { createAppNotification } from './app-notifications';
import { validateProspectPayload } from './prospects';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLUMN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COLUMNS = 24;
const MAX_ROWS = 200;

interface QuoteMutation {
  prospectId?: string;
  opportunityId?: string | null;
  contactId?: string | null;
  assignedTo?: string | null;
  title?: string;
  currency?: string;
  columns?: QuoteColumn[];
  rows?: QuoteRow[];
  totalColumnId?: string;
  status?: QuoteStatus;
  validUntil?: string | null;
  seaFreight?: SeaFreightDetails;
  sentAt?: string | null;
  respondedAt?: string | null;
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

const readOptionalText = (
  record: Record<string, unknown>,
  key: string,
  label: string,
  maxLength = 5000
): { value?: string; error?: string } => {
  const value = record[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string' || value.length > maxLength) {
    return { error: `Le champ « ${label} » est invalide.` };
  }
  return { value: value.trim() || undefined };
};

const validateOptionGroup = <T extends string>(
  value: unknown,
  label: string,
  fields: readonly T[],
  includesOther = false
): { flags?: Partial<Record<T, boolean>>; other?: string; error?: string } => {
  if (value === undefined) return {};
  if (!isRecord(value)) return { error: `Le groupe « ${label} » est invalide.` };

  const allowed = new Set<string>(includesOther ? [...fields, 'other'] : fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: `Le groupe « ${label} » contient un champ non autorisé.` };
  }

  const flags: Partial<Record<T, boolean>> = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== 'boolean') {
      return { error: `La valeur de « ${label} » est invalide.` };
    }
    flags[field] = value[field];
  }

  let other: string | undefined;
  if (includesOther && Object.hasOwn(value, 'other')) {
    const parsed = readOptionalText(value, 'other', `${label} - autre`, 1000);
    if (parsed.error) return { error: parsed.error };
    other = parsed.value;
  }
  return { flags, other };
};

const validateSeaFreight = (
  value: unknown
): { data?: SeaFreightDetails; error?: string } => {
  if (!isRecord(value)) return { error: 'Les détails maritimes de la cotation sont invalides.' };

  const allowed = new Set([
    'contactName', 'phone', 'email', 'address', 'goodsType', 'goodsDescription',
    'grossWeightKg', 'totalVolumeM3', 'packagesCount', 'packagingType',
    'portOfLoading', 'portOfDischarge', 'incoterm', 'estimatedDepartureDate',
    'estimatedArrivalDate', 'needInlandTransport', 'serviceTypes',
    'availableDocuments', 'additionalServices',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: 'Les détails maritimes contiennent un champ non autorisé.' };
  }

  const details: SeaFreightDetails = {};
  const textFields = [
    ['contactName', 'nom du contact'],
    ['phone', 'téléphone'],
    ['email', 'e-mail'],
    ['address', 'adresse'],
    ['goodsType', 'type de marchandise'],
    ['goodsDescription', 'description de la marchandise'],
    ['packagingType', 'type d’emballage'],
    ['portOfLoading', 'port de chargement'],
    ['portOfDischarge', 'port de déchargement'],
    ['incoterm', 'Incoterm'],
  ] as const;

  for (const [key, label] of textFields) {
    if (!Object.hasOwn(value, key)) continue;
    const parsed = readOptionalText(value, key, label);
    if (parsed.error) return { error: parsed.error };
    details[key] = parsed.value;
  }

  for (const key of ['grossWeightKg', 'totalVolumeM3', 'packagesCount'] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const number = value[key];
    if (number === null) {
      details[key] = null;
    } else if (typeof number === 'number' && Number.isFinite(number) && number >= 0
      && number <= 999999999999.99) {
      details[key] = number;
    } else {
      return { error: `La valeur de « ${key} » doit être un nombre positif valide.` };
    }
  }

  for (const key of ['estimatedDepartureDate', 'estimatedArrivalDate'] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const date = value[key];
    if (date === null || date === '') {
      details[key] = null;
    } else if (typeof date === 'string' && isValidDate(date)) {
      details[key] = date;
    } else {
      return { error: `La date « ${key} » est invalide.` };
    }
  }

  if (Object.hasOwn(value, 'needInlandTransport')) {
    if (typeof value['needInlandTransport'] !== 'boolean') {
      return { error: 'La valeur du transport intérieur est invalide.' };
    }
    details.needInlandTransport = value['needInlandTransport'];
  }

  const serviceTypes = validateOptionGroup(
    value['serviceTypes'],
    'types de service',
    ['fcl', 'lcl', 'roro', 'breakBulk'] as const,
    true
  );
  if (serviceTypes.error) return { error: serviceTypes.error };
  if (value['serviceTypes'] !== undefined) {
    const group: NonNullable<SeaFreightDetails['serviceTypes']> = {};
    for (const field of ['fcl', 'lcl', 'roro', 'breakBulk'] as const) {
      const flag = serviceTypes.flags?.[field];
      if (flag !== undefined) group[field] = flag;
    }
    if (serviceTypes.other !== undefined) group.other = serviceTypes.other;
    details.serviceTypes = group;
  }

  const availableDocuments = validateOptionGroup(
    value['availableDocuments'],
    'documents disponibles',
    ['commercialInvoice', 'packingList', 'certificateOfOrigin', 'msdsTechnicalSheet'] as const,
    true
  );
  if (availableDocuments.error) return { error: availableDocuments.error };
  if (value['availableDocuments'] !== undefined) {
    const group: NonNullable<SeaFreightDetails['availableDocuments']> = {};
    for (const field of ['commercialInvoice', 'packingList', 'certificateOfOrigin', 'msdsTechnicalSheet'] as const) {
      const flag = availableDocuments.flags?.[field];
      if (flag !== undefined) group[field] = flag;
    }
    if (availableDocuments.other !== undefined) group.other = availableDocuments.other;
    details.availableDocuments = group;
  }

  const additionalServices = validateOptionGroup(
    value['additionalServices'],
    'services additionnels',
    ['customsClearance', 'cargoInsurance', 'warehousing', 'portHandling', 'tracking'] as const
  );
  if (additionalServices.error) return { error: additionalServices.error };
  if (value['additionalServices'] !== undefined) {
    const group: NonNullable<SeaFreightDetails['additionalServices']> = {};
    for (const field of ['customsClearance', 'cargoInsurance', 'warehousing', 'portHandling', 'tracking'] as const) {
      const flag = additionalServices.flags?.[field];
      if (flag !== undefined) group[field] = flag;
    }
    details.additionalServices = group;
  }

  return { data: details };
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
    'prospectId', 'opportunityId', 'contactId', 'assignedTo', 'title', 'currency', 'columns', 'rows',
    'totalColumnId', 'status', 'validUntil', 'seaFreight',
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

  if (Object.hasOwn(value, 'contactId')) {
    if (value['contactId'] === null || value['contactId'] === '') data.contactId = null;
    else if (typeof value['contactId'] === 'string' && UUID_PATTERN.test(value['contactId'])) {
      data.contactId = value['contactId'];
    } else return { error: 'Le contact sélectionné est invalide.' };
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

  if (Object.hasOwn(value, 'seaFreight')) {
    const seaFreight = validateSeaFreight(value['seaFreight']);
    if (seaFreight.error || !seaFreight.data) {
      return { error: seaFreight.error || 'Les détails maritimes de la cotation sont invalides.' };
    }
    data.seaFreight = seaFreight.data;
  } else if (!partial) {
    return { error: 'Les détails maritimes de la cotation sont obligatoires.' };
  }

  if (Object.keys(data).length === 0) return { error: 'Aucun champ valide à enregistrer.' };
  return { data };
}

export const isQuoteStatusTransitionAllowed = (current: QuoteStatus, next: QuoteStatus | undefined): boolean =>
  current !== 'accepted' || next === undefined || next === 'accepted';

const mapQuoteToDatabase = (data: QuoteMutation): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  if (data.prospectId !== undefined) result['prospect_id'] = data.prospectId;
  if (data.opportunityId !== undefined) result['opportunity_id'] = data.opportunityId;
  if (data.contactId !== undefined) result['contact_id'] = data.contactId;
  if (data.assignedTo !== undefined) result['assigned_to'] = data.assignedTo;
  if (data.title !== undefined) result['title'] = data.title;
  if (data.currency !== undefined) result['currency'] = data.currency;
  if (data.columns !== undefined) result['columns'] = data.columns;
  if (data.rows !== undefined) result['rows'] = data.rows;
  if (data.totalColumnId !== undefined) result['total_column_id'] = data.totalColumnId;
  if (data.status !== undefined) result['status'] = data.status;
  if (data.validUntil !== undefined) result['valid_until'] = data.validUntil;
  if (data.seaFreight !== undefined) result['sea_freight'] = data.seaFreight;
  if (data.sentAt !== undefined) result['sent_at'] = data.sentAt;
  if (data.respondedAt !== undefined) result['responded_at'] = data.respondedAt;
  if (data.status === 'sent' && result['sent_at'] === undefined) {
    result['sent_at'] = new Date().toISOString();
  }
  if ((data.status === 'accepted' || data.status === 'rejected') && result['responded_at'] === undefined) {
    result['responded_at'] = new Date().toISOString();
  }
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
  if (error.code === '23514') {
    res.status(409).json({ error: 'Cette modification contredit une règle métier de la cotation.' });
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
  contactId: row['contact_id'] ?? null,
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
  seaFreight: row['sea_freight'] ?? {},
  sentAt: row['sent_at'] ?? null,
  respondedAt: row['responded_at'] ?? null,
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

export const listQuoteContactsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  const prospectId = req.query['prospectId'];
  if (!adminClient || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  if (typeof prospectId !== 'string' || !UUID_PATTERN.test(prospectId)) {
    res.status(400).json({ error: 'La société sélectionnée est invalide.' });
    return;
  }
  let prospectQuery = adminClient.from('prospects').select('id, assigned_to').eq('id', prospectId);
  if (!await actorCanManageAllQuotes(actor.id)) {
    prospectQuery = prospectQuery.or(`assigned_to.eq.${actor.id},assigned_to.is.null`);
  }
  const { data: prospect, error: prospectError } = await prospectQuery.maybeSingle();
  if (prospectError) {
    sendQuoteDatabaseError(res, prospectError);
    return;
  }
  if (!prospect) {
    res.status(404).json({ error: 'Société introuvable ou non accessible.' });
    return;
  }
  const { data, error } = await adminClient.from('prospect_contacts')
    .select('id, prospect_id, full_name, job_title, email, phone')
    .eq('prospect_id', prospectId)
    .order('is_primary', { ascending: false })
    .order('full_name');
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  res.json({ contacts: data || [] });
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
  // L'expiration automatique est gérée en arrière-plan (pg_cron ou tâche planifiée).
  // Ne plus bloquer le GET sur une UPDATE — on lance en fire-and-forget non bloquant.
  void expireDueQuotes(adminClient, actor.id, canManageAll);

  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  const rawOffset = Number(req.query['offset']);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;

  const status = req.query['status'];
  let query = adminClient.from('sales_quotes')
    .select('*', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (!canManageAll) query = query.eq('assigned_to', actor.id);
  if (typeof status === 'string' && status) {
    if (!QUOTE_STATUSES.includes(status as QuoteStatus)) {
      res.status(400).json({ error: 'Le filtre de statut est invalide.' });
      return;
    }
    query = query.eq('status', status);
  }
  const { data, error, count } = await query;
  if (error) {
    sendQuoteDatabaseError(res, error);
    return;
  }
  const rows = data || [];
  const prospectIds = [...new Set(rows.map((row) => String(row.prospect_id)))];
  const assigneeIds = [...new Set(rows
    .map((row) => row.assigned_to)
    .filter((id): id is string => typeof id === 'string'))];
  const contactIds = [...new Set(rows
    .map((row) => row.contact_id)
    .filter((id): id is string => typeof id === 'string'))];
  const opportunityIds = [...new Set(rows
    .map((row) => row.opportunity_id)
    .filter((id): id is string => typeof id === 'string'))];
  const [prospectsResult, assigneesResult, contactsResult, opportunitiesResult] = await Promise.all([
    prospectIds.length
      ? adminClient.from('prospects').select('id, name, company_name').in('id', prospectIds)
      : Promise.resolve({ data: [], error: null }),
    assigneeIds.length
      ? adminClient.from('profiles').select('id, first_name, last_name').in('id', assigneeIds)
      : Promise.resolve({ data: [], error: null }),
    contactIds.length
      ? adminClient.from('prospect_contacts').select('id, full_name').in('id', contactIds)
      : Promise.resolve({ data: [], error: null }),
    opportunityIds.length
      ? adminClient.from('sales_opportunities').select('id, title').in('id', opportunityIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const { data: prospects, error: prospectsError } = prospectsResult;
  if (prospectsError) {
    sendQuoteDatabaseError(res, prospectsError);
    return;
  }
  const prospectNames = new Map((prospects || []).map((prospect) => [
    String(prospect.id),
    String(prospect.company_name || prospect.name),
  ]));
  const { data: assignees, error: assigneesError } = assigneesResult;
  if (assigneesError) {
    sendQuoteDatabaseError(res, assigneesError);
    return;
  }
  const assigneeNames = new Map((assignees || []).map((assignee) => [
    String(assignee.id),
    `${assignee.first_name} ${assignee.last_name}`.trim(),
  ]));
  const { data: contacts, error: contactsError } = contactsResult;
  if (contactsError) {
    sendQuoteDatabaseError(res, contactsError);
    return;
  }
  const contactNames = new Map((contacts || []).map((contact) => [String(contact.id), String(contact.full_name)]));
  const { data: opportunities, error: opportunitiesError } = opportunitiesResult;
  if (opportunitiesError) {
    sendQuoteDatabaseError(res, opportunitiesError);
    return;
  }
  const opportunityTitles = new Map((opportunities || []).map((opportunity) => [
    String(opportunity.id),
    String(opportunity.title),
  ]));
  const { data: dossiers, error: dossiersError } = opportunityIds.length
    ? await adminClient.from('dossiers').select('id, opportunity_id, no_dossier').in('opportunity_id', opportunityIds)
    : { data: [], error: null };
  if (dossiersError) {
    sendQuoteDatabaseError(res, dossiersError);
    return;
  }
  const dossierByOpportunity = new Map((dossiers || []).map((dossier) => [
    String(dossier.opportunity_id),
    { id: String(dossier.id), number: String(dossier.no_dossier) },
  ]));
  res.json({
    quotes: rows.map((row) => ({
      ...toQuoteResponse(row, prospectNames.get(String(row.prospect_id))),
      assignedToName: typeof row.assigned_to === 'string' ? assigneeNames.get(row.assigned_to) || null : null,
      contactName: typeof row.contact_id === 'string' ? contactNames.get(row.contact_id) || null : null,
      opportunityTitle: typeof row.opportunity_id === 'string' ? opportunityTitles.get(row.opportunity_id) || null : null,
      dossierId: typeof row.opportunity_id === 'string' ? dossierByOpportunity.get(row.opportunity_id)?.id || null : null,
      dossierNumber: typeof row.opportunity_id === 'string' ? dossierByOpportunity.get(row.opportunity_id)?.number || null : null,
    })),
    total: count ?? rows.length,
    limit,
    offset,
  });
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
    const { data: existingQuote, error: existingQuoteError } = await adminClient.from('sales_quotes')
      .select('id').eq('opportunity_id', validated.data.opportunityId).limit(1).maybeSingle();
    if (existingQuoteError) {
      sendQuoteDatabaseError(res, existingQuoteError);
      return;
    }
    if (existingQuote) {
      res.status(409).json({ error: 'Cette opportunité possède déjà une cotation. Ouvrez-la depuis le CRM pour la modifier.' });
      return;
    }
  }
  if (validated.data.contactId) {
    const { data: contact, error: contactError } = await adminClient.from('prospect_contacts')
      .select('id, prospect_id').eq('id', validated.data.contactId).maybeSingle();
    if (contactError) {
      sendQuoteDatabaseError(res, contactError);
      return;
    }
    if (!contact || contact.prospect_id !== validated.data.prospectId) {
      res.status(400).json({ error: 'Le contact ne correspond pas au client sélectionné.' });
      return;
    }
  }
  const { data, error } = await adminClient.from('sales_quotes').insert({
    ...mapQuoteToDatabase(validated.data),
    assigned_to: assignedTo,
    created_by: actor.id,
  }).select('*').single();
  if (error || !data) {
    if (error?.code === '23505') {
      res.status(409).json({ error: 'Cette opportunité possède déjà une cotation.' });
      return;
    }
    sendQuoteDatabaseError(res, error || { message: 'quote insert returned no row' });
    return;
  }
  await auditQuote(req, actor, { action: 'CREATE_QUOTE', entityId: String(data.id), details: { quote_number: data.quote_number } });
  if (typeof data.assigned_to === 'string') {
    await createAppNotification(adminClient, {
      recipientId: data.assigned_to,
      actorId: actor.id,
      notificationType: 'assignment',
      title: 'Nouvelle cotation attribuée',
      message: `La cotation ${String(data.quote_number)} vous a été attribuée.`,
      href: `/quotes?quoteId=${data.id}`,
      sourceType: 'quote',
      sourceId: String(data.id),
      dedupeKey: `quote:${data.id}:assigned:${data.assigned_to}:${data.updated_at}`,
    });
  }
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
  if (!isQuoteStatusTransitionAllowed(current.status as QuoteStatus, nextData.status)) {
    res.status(409).json({ error: 'Une cotation acceptée ne peut pas revenir à un autre statut.' });
    return;
  }
  if (nextData.prospectId && nextData.prospectId !== current.prospect_id
    && nextData.opportunityId === undefined) {
    nextData.opportunityId = null;
  }
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
  if (nextData.prospectId && nextData.prospectId !== current.prospect_id
    && nextData.contactId === undefined) {
    nextData.contactId = null;
  }
  if (nextData.contactId) {
    const { data: contact, error: contactError } = await adminClient.from('prospect_contacts')
      .select('id, prospect_id').eq('id', nextData.contactId).maybeSingle();
    if (contactError) {
      sendQuoteDatabaseError(res, contactError);
      return;
    }
    if (!contact || contact.prospect_id !== (nextData.prospectId || current.prospect_id)) {
      res.status(400).json({ error: 'Le contact ne correspond pas au client sélectionné.' });
      return;
    }
  }
  if (nextData.opportunityId !== undefined) {
    const canManageCrmTeam = await hasPermission(actor.id, 'crm.team.manage', undefined);
    if (nextData.opportunityId === null) {
      if (current.opportunity_id && nextData.prospectId === current.prospect_id) {
        res.status(409).json({ error: 'Une cotation doit rester liée à son opportunité CRM.' });
        return;
      }
      if (current.opportunity_id && !canManageCrmTeam) {
        res.status(403).json({ error: 'Vous ne pouvez changer le client lié à cette opportunité.' });
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
      const { data: existingQuote, error: existingQuoteError } = await adminClient.from('sales_quotes')
        .select('id').eq('opportunity_id', nextData.opportunityId).neq('id', id).limit(1).maybeSingle();
      if (existingQuoteError) {
        sendQuoteDatabaseError(res, existingQuoteError);
        return;
      }
      if (existingQuote) {
        res.status(409).json({ error: 'Cette opportunité possède déjà une autre cotation.' });
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
    if (error?.code === '23505') {
      res.status(409).json({ error: 'Cette opportunité possède déjà une autre cotation.' });
      return;
    }
    sendQuoteDatabaseError(res, error || { message: 'quote update returned no row' });
    return;
  }
  await auditQuote(req, actor, { action: 'UPDATE_QUOTE', entityId: id, details: { status: data.status } });
  if (typeof data.assigned_to === 'string' && data.assigned_to !== current.assigned_to) {
    await createAppNotification(adminClient, {
      recipientId: data.assigned_to,
      actorId: actor.id,
      notificationType: 'assignment',
      title: 'Cotation attribuée',
      message: `La cotation ${String(data.quote_number)} vous a été attribuée.`,
      href: `/quotes?quoteId=${data.id}`,
      sourceType: 'quote',
      sourceId: id,
      dedupeKey: `quote:${id}:assigned:${data.assigned_to}:${data.updated_at}`,
    });
  }
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

export const listQuoteTemplatesHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  if (!adminClient) return;
  if (!actor?.id) {
    res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
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

export const getQuoteTimingAnalyticsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getAdminClient(res);
  const actor = getActor(req);
  if (!adminClient || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }

  // Contrôle de sécurité RBAC : permission obligatoire quotes.timing.read
  const hasTimingPermission = await hasPermission(actor.id, 'quotes.timing.read', undefined);
  if (!hasTimingPermission) {
    res.status(403).json({ error: 'Permission quotes.timing.read requise pour consulter les délais des cotations.' });
    return;
  }

  const period = typeof req.query['period'] === 'string' ? req.query['period'] : 'month';
  const specificDate = typeof req.query['date'] === 'string' ? req.query['date'] : null;
  const repFilter = typeof req.query['repId'] === 'string' && req.query['repId'] !== 'all' ? req.query['repId'] : null;

  // Calcul des bornes temporelles
  const now = new Date();
  let startDate: Date;
  let endDate: Date = now;

  if (specificDate && /^\d{4}-\d{2}-\d{2}$/.test(specificDate)) {
    startDate = new Date(`${specificDate}T00:00:00.000Z`);
    endDate = new Date(`${specificDate}T23:59:59.999Z`);
  } else if (period === '7d') {
    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (period === 'quarter') {
    const currentQuarter = Math.floor(now.getMonth() / 3);
    startDate = new Date(now.getFullYear(), currentQuarter * 3, 1);
  } else if (period === 'year') {
    startDate = new Date(now.getFullYear(), 0, 1);
  } else {
    // Par défaut : mois courant
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  let query = adminClient
    .from('sales_quotes')
    .select('*')
    .gte('created_at', startDate.toISOString())
    .lte('created_at', endDate.toISOString())
    .order('created_at', { ascending: false });

  if (repFilter) {
    query = query.eq('assigned_to', repFilter);
  }

  const { data: quoteRows, error: quotesError } = await query;
  if (quotesError) {
    sendQuoteDatabaseError(res, quotesError);
    return;
  }

  const prospectIds = [...new Set((quoteRows || []).map((q) => String(q.prospect_id)).filter(Boolean))];
  const repIds = [...new Set((quoteRows || []).map((q) => String(q.assigned_to)).filter(Boolean))];

  const [prospectsRes, repsRes] = await Promise.all([
    prospectIds.length
      ? adminClient.from('prospects').select('id, name, company_name').in('id', prospectIds)
      : { data: [], error: null },
    repIds.length
      ? adminClient.from('profiles').select('id, first_name, last_name, email').in('id', repIds)
      : { data: [], error: null },
  ]);

  const prospectMap = new Map((prospectsRes.data || []).map((p) => [String(p.id), String(p.company_name || p.name)]));
  const repMap = new Map((repsRes.data || []).map((r) => [String(r.id), `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email || 'Commercial']));

  const formatMinutes = (totalMin: number): string => {
    if (totalMin < 0 || !Number.isFinite(totalMin)) return '0m';
    const hours = Math.floor(totalMin / 60);
    const mins = Math.floor(totalMin % 60);
    if (hours === 0) return `${mins}m`;
    return `${hours}h ${mins.toString().padStart(2, '0')}m`;
  };

  let totalCommercialDelayMin = 0;
  let delayCount = 0;
  let slaCompliantCount = 0;
  let inProgressCount = 0;
  let overdueCount = 0;
  let totalAmount = 0;
  let acceptedCount = 0;

  const repStats = new Map<string, {
    repId: string;
    repName: string;
    totalQuotes: number;
    totalDelayMin: number;
    slaOkCount: number;
    acceptedCount: number;
    totalAmount: number;
  }>();

  const formattedQuotes = (quoteRows || []).map((row) => {
    const createdAt = new Date(row.created_at).getTime();
    const sentAt = row.sent_at ? new Date(row.sent_at).getTime() : null;
    const updatedAt = new Date(row.updated_at).getTime();
    const respondedAt = row.responded_at ? new Date(row.responded_at).getTime() : null;
    const status = String(row.status || 'draft');
    const amount = Number(row.total_amount || 0);
    const repId = row.assigned_to ? String(row.assigned_to) : 'unassigned';
    const repName = repMap.get(repId) || 'Non assigné';
    const clientName = prospectMap.get(String(row.prospect_id)) || 'Client';

    let commercialMinutes: number;
    if (sentAt) {
      commercialMinutes = Math.max(0, Math.round((sentAt - createdAt) / 60000));
    } else if (status === 'sent' || status === 'accepted' || status === 'rejected') {
      commercialMinutes = Math.max(0, Math.round((updatedAt - createdAt) / 60000));
    } else {
      commercialMinutes = Math.max(0, Math.round((Date.now() - createdAt) / 60000));
    }

    let clientMinutes: number | null = null;
    if (respondedAt && sentAt) {
      clientMinutes = Math.max(0, Math.round((respondedAt - sentAt) / 60000));
    } else if (status === 'accepted' || status === 'rejected') {
      const baseSent = sentAt || createdAt;
      clientMinutes = Math.max(0, Math.round((updatedAt - baseSent) / 60000));
    }

    const isSlaBreach = commercialMinutes > 1440; // > 24h
    const isOverdue = (status === 'draft' && commercialMinutes > 2880) || (status === 'draft' && isSlaBreach);

    totalCommercialDelayMin += commercialMinutes;
    delayCount++;
    totalAmount += amount;

    if (!isSlaBreach) slaCompliantCount++;
    if (status === 'draft') inProgressCount++;
    if (isOverdue) overdueCount++;
    if (status === 'accepted') acceptedCount++;

    if (repId !== 'unassigned') {
      const existing = repStats.get(repId) || {
        repId,
        repName,
        totalQuotes: 0,
        totalDelayMin: 0,
        slaOkCount: 0,
        acceptedCount: 0,
        totalAmount: 0,
      };
      existing.totalQuotes++;
      existing.totalDelayMin += commercialMinutes;
      if (!isSlaBreach) existing.slaOkCount++;
      if (status === 'accepted') existing.acceptedCount++;
      existing.totalAmount += amount;
      repStats.set(repId, existing);
    }

    return {
      id: String(row.id),
      quoteNumber: String(row.quote_number),
      clientName,
      details: row.title || 'Cotation Fret Maritime',
      repId,
      repName,
      amount,
      amountFormatted: new Intl.NumberFormat('fr-FR').format(amount) + ' XAF',
      status,
      commercialMinutes,
      commercialDelayFormatted: formatMinutes(commercialMinutes),
      clientMinutes,
      clientDelayFormatted: clientMinutes !== null ? formatMinutes(clientMinutes) : (status === 'sent' ? 'En attente' : '—'),
      isSlaBreach,
      isOverdue,
      date: new Date(row.created_at).toISOString().slice(0, 10),
      createdAtFormatted: new Date(row.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
      sentAtFormatted: sentAt ? new Date(sentAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : (status === 'sent' ? 'Envoyé' : 'En cours'),
      respondedAtFormatted: respondedAt ? new Date(respondedAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—',
    };
  });

  const totalQuotes = delayCount;
  const avgCommercialDelayMinutes = totalQuotes > 0 ? Math.round(totalCommercialDelayMin / totalQuotes) : 0;
  const slaComplianceRate = totalQuotes > 0 ? Math.round((slaCompliantCount / totalQuotes) * 1000) / 10 : 100;
  const conversionRate = totalQuotes > 0 ? Math.round((acceptedCount / totalQuotes) * 1000) / 10 : 0;

  const repsArray = Array.from(repStats.values()).map((r) => ({
    repId: r.repId,
    repName: r.repName,
    quotesCount: r.totalQuotes,
    avgDelayFormatted: formatMinutes(r.totalQuotes > 0 ? Math.round(r.totalDelayMin / r.totalQuotes) : 0),
    slaRateFormatted: `${r.totalQuotes > 0 ? Math.round((r.slaOkCount / r.totalQuotes) * 100) : 100}% (${r.slaOkCount}/${r.totalQuotes})`,
    conversionRateFormatted: `${r.totalQuotes > 0 ? Math.round((r.acceptedCount / r.totalQuotes) * 1000) / 10 : 0}%`,
    totalAmount: r.totalAmount,
    totalAmountFormatted: new Intl.NumberFormat('fr-FR').format(r.totalAmount) + ' XAF',
  }));

  res.json({
    kpis: {
      avgDelayFormatted: totalQuotes > 0 ? formatMinutes(avgCommercialDelayMinutes) : '—',
      avgDelayMinutes: avgCommercialDelayMinutes,
      slaComplianceRateFormatted: `${slaComplianceRate}%`,
      slaCompliancePercent: slaComplianceRate,
      inProgressCount,
      overdueCount,
      totalAmount,
      totalAmountFormatted: new Intl.NumberFormat('fr-FR').format(totalAmount) + ' XAF',
      conversionRateFormatted: `${conversionRate}%`,
      conversionPercent: conversionRate,
    },
    quotes: formattedQuotes,
    reps: repsArray,
    totalCount: totalQuotes,
  });
};
