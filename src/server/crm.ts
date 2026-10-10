import express from 'express';
import { CRM_OPPORTUNITY_STAGES, CrmOpportunityStage } from '../app/core/models/crm.model';
import { PROSPECT_STATUSES, ProspectStatus } from '../app/core/models/prospect.model';
import { hasPermission } from './access-control';
import { writeAuditLog } from './audit-log';
import { getSupabaseAdmin } from './auth';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEARCH_PATTERN = /[^a-zA-Z0-9@.+\-\s]/g;
const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'task'] as const;
const ACTIVITY_STATUSES = ['pending', 'completed', 'cancelled'] as const;

type JsonRecord = Record<string, unknown>;

interface CrmActor {
  id: string;
  email?: string;
  role?: string;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getActor = (req: express.Request): CrmActor | undefined =>
  (req as unknown as JsonRecord)['user'] as CrmActor | undefined;

const getAdminClient = (res: express.Response) => {
  const client = getSupabaseAdmin();
  if (!client) res.status(503).json({ error: 'Le service CRM Commercial est indisponible.' });
  return client;
};

const databaseFailure = (res: express.Response, error: { code?: string; message?: string }): void => {
  console.error('[CRM] Erreur base de données:', error.message || error.code || 'inconnue');
  if (error.code === '23503') {
    res.status(400).json({ error: 'Une référence sélectionnée n’existe plus.' });
    return;
  }
  if (error.code === '23505') {
    res.status(409).json({ error: 'Cette donnée existe déjà ou est déjà liée.' });
    return;
  }
  res.status(500).json({ error: 'Impossible de traiter cette demande CRM pour le moment.' });
};

const audit = async (
  req: express.Request,
  actor: CrmActor,
  action: string,
  entityType: string,
  entityId: string,
  details: JsonRecord = {}
): Promise<void> => {
  const client = getSupabaseAdmin();
  if (!client) return;
  await writeAuditLog(client, {
    userId: actor.id,
    userEmail: actor.email,
    userRole: actor.role,
    action,
    entityType,
    entityId,
    details,
    ipAddress: req.ip || null,
  });
};

const canSeeTeam = async (userId: string): Promise<boolean> =>
  await hasPermission(userId, 'crm.team.read', undefined)
  || await hasPermission(userId, 'crm.team.manage', undefined);

const canManageTeam = (userId: string): Promise<boolean> =>
  hasPermission(userId, 'crm.team.manage', undefined);

const ownsRecord = (row: JsonRecord, actor: CrmActor): boolean =>
  row['assigned_to'] === actor.id || (!row['assigned_to'] && row['created_by'] === actor.id);

const readNullableString = (
  value: unknown,
  maxLength: number,
  fieldLabel: string
): { value?: string | null; error?: string } => {
  if (value === undefined) return {};
  if (value === null) return { value: null };
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    return { error: `Le champ ${fieldLabel} est invalide ou trop long.` };
  }
  return { value: value.trim() || null };
};

const validDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value;
};

export const validateCrmClientPayload = (value: unknown): { data?: JsonRecord; error?: string } => {
  if (!isRecord(value)) return { error: 'Les informations du client sont invalides.' };
  const allowed = new Set(['companyName', 'contactName', 'contactRole', 'email', 'phone', 'country', 'sector']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: 'La demande contient un champ non autorisé.' };
  }
  const companyName = typeof value['companyName'] === 'string' ? value['companyName'].trim() : '';
  if (companyName.length < 2 || companyName.length > 200) {
    return { error: 'Le nom de la société doit comporter entre 2 et 200 caractères.' };
  }
  const data: JsonRecord = { name: companyName, company_name: companyName, status: 'new' };
  const fields: [string, string, number][] = [
    ['contactName', 'contact_name', 200],
    ['contactRole', 'contact_role', 100],
    ['phone', 'phone', 40],
    ['country', 'country', 100],
    ['sector', 'sector', 100],
  ];
  for (const [inputKey, dbKey, maxLength] of fields) {
    const parsed = readNullableString(value[inputKey], maxLength, inputKey);
    if (parsed.error) return { error: parsed.error };
    if (parsed.value !== undefined) data[dbKey] = parsed.value;
  }
  const email = readNullableString(value['email'], 320, 'email');
  if (email.error || (email.value && !EMAIL_PATTERN.test(email.value))) {
    return { error: email.error || 'Adresse e-mail invalide.' };
  }
  if (email.value !== undefined) data['email'] = email.value?.toLowerCase() ?? null;
  return { data };
};

export const validateCrmContactPayload = (value: unknown): { data?: JsonRecord; error?: string } => {
  if (!isRecord(value)) return { error: 'Les informations du contact sont invalides.' };
  const allowed = new Set(['fullName', 'jobTitle', 'email', 'phone']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: 'La demande contient un champ non autorisé.' };
  }
  const fullName = typeof value['fullName'] === 'string' ? value['fullName'].trim() : '';
  if (fullName.length < 2 || fullName.length > 200) {
    return { error: 'Le nom du contact doit comporter entre 2 et 200 caractères.' };
  }
  const data: JsonRecord = { full_name: fullName };
  for (const [inputKey, dbKey, maxLength] of [
    ['jobTitle', 'job_title', 120],
    ['phone', 'phone', 40],
    ['email', 'email', 320],
  ] as const) {
    const parsed = readNullableString(value[inputKey], maxLength, inputKey);
    if (parsed.error) return { error: parsed.error };
    if (parsed.value !== undefined) data[dbKey] = inputKey === 'email' && parsed.value
      ? parsed.value.toLowerCase()
      : parsed.value;
  }
  if (typeof data['email'] === 'string' && !EMAIL_PATTERN.test(data['email'])) {
    return { error: 'Adresse e-mail invalide.' };
  }
  return { data };
};

export const validateCrmOpportunityPayload = (
  value: unknown,
  partial = false
): { data?: JsonRecord; error?: string } => {
  if (!isRecord(value)) return { error: 'Les informations de l’opportunité sont invalides.' };
  const allowed = new Set([
    'prospectId', 'title', 'stage', 'transportMode', 'direction', 'origin',
    'destination', 'goodsDescription', 'weightKg', 'volumeM3', 'incoterm',
    'estimatedValue', 'currency', 'expectedCloseDate', 'wonReason',
    'contractReference', 'notes', 'assignedTo',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: 'La demande contient un champ non autorisé.' };
  }
  const data: JsonRecord = {};
  if (Object.hasOwn(value, 'prospectId')) {
    if (typeof value['prospectId'] !== 'string' || !UUID_PATTERN.test(value['prospectId'])) {
      return { error: 'La société sélectionnée est invalide.' };
    }
    data['prospect_id'] = value['prospectId'];
  } else if (!partial) return { error: 'La société est obligatoire.' };

  if (Object.hasOwn(value, 'title')) {
    if (typeof value['title'] !== 'string' || value['title'].trim().length < 2 || value['title'].trim().length > 200) {
      return { error: 'Le titre doit comporter entre 2 et 200 caractères.' };
    }
    data['title'] = value['title'].trim();
  } else if (!partial) return { error: 'Le titre est obligatoire.' };

  if (Object.hasOwn(value, 'stage')) {
    if (typeof value['stage'] !== 'string' || !CRM_OPPORTUNITY_STAGES.includes(value['stage'] as CrmOpportunityStage)) {
      return { error: 'L’étape commerciale sélectionnée est invalide.' };
    }
    data['stage'] = value['stage'];
  }
  if (Object.hasOwn(value, 'transportMode')) {
    if (value['transportMode'] !== null && value['transportMode'] !== 'air' && value['transportMode'] !== 'sea') {
      return { error: 'Le mode de transport doit être aérien ou maritime.' };
    }
    data['transport_mode'] = value['transportMode'];
  }
  if (Object.hasOwn(value, 'direction')) {
    if (value['direction'] !== null && value['direction'] !== 'import' && value['direction'] !== 'export') {
      return { error: 'Le sens du transport doit être import ou export.' };
    }
    data['direction'] = value['direction'];
  }
  const textFields: [string, string, number][] = [
    ['origin', 'origin', 160],
    ['destination', 'destination', 160],
    ['goodsDescription', 'goods_description', 2000],
    ['incoterm', 'incoterm', 20],
    ['notes', 'notes', 10000],
    ['contractReference', 'contract_reference', 120],
  ];
  for (const [inputKey, dbKey, maxLength] of textFields) {
    const parsed = readNullableString(value[inputKey], maxLength, inputKey);
    if (parsed.error) return { error: parsed.error };
    if (parsed.value !== undefined) data[dbKey] = parsed.value;
  }
  for (const [inputKey, dbKey] of [['weightKg', 'weight_kg'], ['volumeM3', 'volume_m3'], ['estimatedValue', 'estimated_value']] as const) {
    if (!Object.hasOwn(value, inputKey)) continue;
    const amount = value[inputKey];
    if (amount === null && inputKey !== 'estimatedValue') {
      data[dbKey] = null;
      continue;
    }
    const parsed = typeof amount === 'number' ? amount : Number(amount);
    const maximum = inputKey === 'estimatedValue' ? 999999999999.99 : 99999999999.999;
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum) {
      return { error: `La valeur ${inputKey} doit être un nombre positif valide.` };
    }
    data[dbKey] = parsed;
  }
  if (Object.hasOwn(value, 'currency')) {
    if (typeof value['currency'] !== 'string' || !/^[A-Za-z]{3}$/.test(value['currency'].trim())) {
      return { error: 'La devise doit être un code ISO de trois lettres.' };
    }
    data['currency'] = value['currency'].trim().toUpperCase();
  }
  if (Object.hasOwn(value, 'expectedCloseDate')) {
    const date = value['expectedCloseDate'];
    if (date === null || date === '') data['expected_close_date'] = null;
    else if (typeof date === 'string' && validDate(date)) data['expected_close_date'] = date;
    else return { error: 'La date de clôture prévisionnelle est invalide.' };
  }
  if (Object.hasOwn(value, 'wonReason')) {
    const reason = value['wonReason'];
    if (reason !== null && reason !== 'signed_contract') {
      return { error: 'Une opportunité ne peut être gagnée que par confirmation d’un contrat signé.' };
    }
    data['won_reason'] = reason;
  }
  if (Object.hasOwn(value, 'assignedTo')) {
    if (value['assignedTo'] === null || value['assignedTo'] === '') data['assigned_to'] = null;
    else if (typeof value['assignedTo'] === 'string' && UUID_PATTERN.test(value['assignedTo'])) {
      data['assigned_to'] = value['assignedTo'];
    } else return { error: 'Le commercial sélectionné est invalide.' };
  }
  if (Object.keys(data).length === 0) return { error: 'Aucun champ valide à enregistrer.' };
  return { data };
};

export const validateCrmActivityPayload = (value: unknown): { data?: JsonRecord; error?: string } => {
  if (!isRecord(value)) return { error: 'Les informations de l’activité sont invalides.' };
  const allowed = new Set(['prospectId', 'opportunityId', 'activityType', 'title', 'dueAt', 'notes']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: 'La demande contient un champ non autorisé.' };
  }
  if (typeof value['prospectId'] !== 'string' || !UUID_PATTERN.test(value['prospectId'])) {
    return { error: 'La société associée à l’activité est invalide.' };
  }
  if (typeof value['activityType'] !== 'string' || !ACTIVITY_TYPES.includes(value['activityType'] as typeof ACTIVITY_TYPES[number])) {
    return { error: 'Le type d’activité est invalide.' };
  }
  if (typeof value['title'] !== 'string' || value['title'].trim().length < 2 || value['title'].trim().length > 200) {
    return { error: 'Le titre de l’activité doit comporter entre 2 et 200 caractères.' };
  }
  const data: JsonRecord = {
    prospect_id: value['prospectId'],
    activity_type: value['activityType'],
    title: value['title'].trim(),
  };
  if (value['opportunityId'] !== undefined && value['opportunityId'] !== null && value['opportunityId'] !== '') {
    if (typeof value['opportunityId'] !== 'string' || !UUID_PATTERN.test(value['opportunityId'])) {
      return { error: 'L’opportunité associée à l’activité est invalide.' };
    }
    data['opportunity_id'] = value['opportunityId'];
  }
  if (value['dueAt'] !== undefined && value['dueAt'] !== null && value['dueAt'] !== '') {
    if (typeof value['dueAt'] !== 'string' || !Number.isFinite(Date.parse(value['dueAt']))) {
      return { error: 'L’échéance de l’activité est invalide.' };
    }
    data['due_at'] = value['dueAt'];
  }
  const notes = readNullableString(value['notes'], 5000, 'notes');
  if (notes.error) return { error: notes.error };
  if (notes.value !== undefined) data['notes'] = notes.value;
  return { data };
};

export const validateCrmCampaignPayload = (value: unknown): { data?: JsonRecord; error?: string } => {
  if (!isRecord(value)) return { error: 'Les informations de la campagne sont invalides.' };
  const allowed = new Set(['name', 'startsAt', 'endsAt', 'notes', 'filters']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { error: 'La demande contient un champ non autorisé.' };
  }
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  if (name.length < 2 || name.length > 200) return { error: 'Le nom doit comporter entre 2 et 200 caractères.' };
  const data: JsonRecord = { name, status: 'planned' };
  for (const [inputKey, dbKey] of [['startsAt', 'starts_at'], ['endsAt', 'ends_at']] as const) {
    if (!Object.hasOwn(value, inputKey)) continue;
    const date = value[inputKey];
    if (date === null || date === '') data[dbKey] = null;
    else if (typeof date === 'string' && validDate(date)) data[dbKey] = date;
    else return { error: `La date ${inputKey} est invalide.` };
  }
  const startDate = typeof data['starts_at'] === 'string' ? data['starts_at'] : null;
  const endDate = typeof data['ends_at'] === 'string' ? data['ends_at'] : null;
  if (startDate && endDate && endDate < startDate) {
    return { error: 'La date de fin doit être égale ou postérieure à la date de début.' };
  }
  const notes = readNullableString(value['notes'], 5000, 'notes');
  if (notes.error) return { error: notes.error };
  data['notes'] = notes.value ?? null;
  const filters = value['filters'];
  if (filters !== undefined) {
    if (!isRecord(filters)
      || Object.keys(filters).some((key) => !['statuses', 'countries', 'transportModes', 'assignedTo'].includes(key))) {
      return { error: 'Les filtres de la campagne sont invalides.' };
    }
    const statuses = filters['statuses'] ?? [];
    const countries = filters['countries'] ?? [];
    const modes = filters['transportModes'] ?? [];
    if (!Array.isArray(statuses) || statuses.some((item) => typeof item !== 'string' || !PROSPECT_STATUSES.includes(item as ProspectStatus))) {
      return { error: 'Un statut de client du segment est invalide.' };
    }
    if (!Array.isArray(countries) || countries.some((item) => typeof item !== 'string' || item.trim().length > 100)) {
      return { error: 'Un pays du segment est invalide.' };
    }
    if (!Array.isArray(modes) || modes.some((item) => item !== 'air' && item !== 'sea')) {
      return { error: 'Un mode de transport du segment est invalide.' };
    }
    const assignedTo = filters['assignedTo'];
    if (assignedTo !== null && assignedTo !== undefined && assignedTo !== ''
      && (typeof assignedTo !== 'string' || !UUID_PATTERN.test(assignedTo))) {
      return { error: 'Le commercial du segment est invalide.' };
    }
    data['filters'] = {
      statuses: [...new Set(statuses)],
      countries: [...new Set(countries.map((item: string) => item.trim()).filter(Boolean))],
      transportModes: [...new Set(modes)],
      assignedTo: assignedTo || null,
    };
  }
  return { data };
};

const clientFromRow = (row: JsonRecord) => ({
  id: String(row['id']),
  name: String(row['name'] || ''),
  companyName: typeof row['company_name'] === 'string' ? row['company_name'] : null,
  contactName: typeof row['contact_name'] === 'string' ? row['contact_name'] : null,
  contactRole: typeof row['contact_role'] === 'string' ? row['contact_role'] : null,
  email: typeof row['email'] === 'string' ? row['email'] : null,
  phone: typeof row['phone'] === 'string' ? row['phone'] : null,
  country: typeof row['country'] === 'string' ? row['country'] : null,
  sector: typeof row['sector'] === 'string' ? row['sector'] : null,
  status: String(row['status'] || 'new'),
  assignedTo: typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null,
});

const contactFromRow = (row: JsonRecord) => ({
  id: String(row['id']),
  prospectId: String(row['prospect_id']),
  fullName: String(row['full_name']),
  jobTitle: typeof row['job_title'] === 'string' ? row['job_title'] : null,
  email: typeof row['email'] === 'string' ? row['email'] : null,
  phone: typeof row['phone'] === 'string' ? row['phone'] : null,
  isPrimary: row['is_primary'] === true,
});

const campaignFromRow = (row: JsonRecord, audienceCount: number) => ({
  id: String(row['id']),
  name: String(row['name']),
  status: String(row['status']),
  startsAt: typeof row['starts_at'] === 'string' ? row['starts_at'] : null,
  endsAt: typeof row['ends_at'] === 'string' ? row['ends_at'] : null,
  filters: isRecord(row['filters']) ? row['filters'] : {},
  notes: typeof row['notes'] === 'string' ? row['notes'] : null,
  audienceCount,
});

const matchesTransportMode = (filters: unknown, modes: readonly string[]): boolean => {
  if (!isRecord(filters)) return true;
  const selected = filters['transportModes'];
  return !Array.isArray(selected) || selected.length === 0
    || selected.some((mode) => modes.includes(String(mode)));
};

export const getCrmOverviewHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  if (!admin || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const teamRead = await canSeeTeam(actor.id);
  let opportunitiesQuery = admin.from('sales_opportunities').select('*').order('updated_at', { ascending: false }).limit(500);
  let clientsQuery = admin.from('prospects')
    .select('id, name, company_name, contact_name, contact_role, email, phone, country, sector, status, assigned_to')
    .order('company_name').limit(500);
  let activitiesQuery = admin.from('sales_activities').select('*').order('due_at', { ascending: true }).limit(500);
  let campaignsQuery = admin.from('sales_campaigns').select('*').order('starts_at', { ascending: false }).limit(200);
  if (!teamRead) {
    opportunitiesQuery = opportunitiesQuery.or(`assigned_to.eq.${actor.id},created_by.eq.${actor.id}`);
    clientsQuery = clientsQuery.or(`assigned_to.eq.${actor.id},created_by.eq.${actor.id}`);
    activitiesQuery = activitiesQuery.or(`assigned_to.eq.${actor.id},created_by.eq.${actor.id}`);
    campaignsQuery = campaignsQuery.eq('created_by', actor.id);
  }
  const [opportunitiesResult, clientsResult, activitiesResult, campaignsResult] = await Promise.all([
    opportunitiesQuery,
    clientsQuery,
    activitiesQuery,
    campaignsQuery,
  ]);
  const failed = [
    opportunitiesResult.error,
    clientsResult.error,
    activitiesResult.error,
    campaignsResult.error,
  ].find((error) => error);
  if (failed) {
    databaseFailure(res, failed);
    return;
  }

  const rawSearch = typeof req.query['search'] === 'string'
    ? req.query['search'].replace(SEARCH_PATTERN, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
    : '';
  const filterStage = req.query['stage'];
  const stageSet = new Set(CRM_OPPORTUNITY_STAGES);
  if (typeof filterStage === 'string' && filterStage && !stageSet.has(filterStage as CrmOpportunityStage)) {
    res.status(400).json({ error: 'Le filtre de l’étape commerciale est invalide.' });
    return;
  }
  const filteredOpportunityRows = (opportunitiesResult.data || []).filter((row) => {
    if (typeof filterStage === 'string' && filterStage && row.stage !== filterStage) return false;
    if (!rawSearch) return true;
    return [row.title, row.origin, row.destination, row.goods_description, row.incoterm]
      .some((value) => typeof value === 'string' && value.toLocaleLowerCase('fr').includes(rawSearch.toLocaleLowerCase('fr')));
  });
  const clientIds = [...new Set([
    ...(clientsResult.data || []).map((row) => String(row.id)),
    ...filteredOpportunityRows.map((row) => String(row.prospect_id)),
    ...(activitiesResult.data || []).map((row) => String(row.prospect_id)),
  ])];
  const clientRowsResult = clientIds.length
    ? await admin.from('prospects')
      .select('id, name, company_name, contact_name, contact_role, email, phone, country, sector, status, assigned_to')
      .in('id', clientIds).order('company_name')
    : { data: [], error: null };
  if (clientRowsResult.error) {
    databaseFailure(res, clientRowsResult.error);
    return;
  }
  const visibleOpportunityRows = filteredOpportunityRows.filter((row) =>
    (clientRowsResult.data || []).some((client) => String(client.id) === String(row.prospect_id))
  );
  const visibleActivityRows = (activitiesResult.data || []).filter((row) =>
    (clientRowsResult.data || []).some((client) => String(client.id) === String(row.prospect_id))
  );
  const clients = (clientRowsResult.data || []).map((row) => clientFromRow(row));
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const [contactsResult, dossierResult, quoteResult, profilesResult] = await Promise.all([
    clientIds.length
      ? admin.from('prospect_contacts').select('*').in('prospect_id', clientIds).order('is_primary', { ascending: false }).order('full_name')
      : Promise.resolve({ data: [], error: null }),
    visibleOpportunityRows.length
      ? admin.from('dossiers').select('opportunity_id, no_dossier').in('opportunity_id', visibleOpportunityRows.map((row) => String(row.id)))
      : Promise.resolve({ data: [], error: null }),
    visibleOpportunityRows.length
      ? admin.from('sales_quotes').select('opportunity_id, quote_number, status, created_at')
        .in('opportunity_id', visibleOpportunityRows.map((row) => String(row.id)))
        .order('created_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    visibleOpportunityRows.length
      ? admin.from('profiles').select('id, first_name, last_name')
        .in('id', [...new Set(visibleOpportunityRows.map((row) => row.assigned_to).filter((id): id is string => typeof id === 'string'))])
      : Promise.resolve({ data: [], error: null }),
  ]);
  const relatedFailure = [contactsResult.error, dossierResult.error, quoteResult.error, profilesResult.error].find((error) => error);
  if (relatedFailure) {
    databaseFailure(res, relatedFailure);
    return;
  }
  const contacts = (contactsResult.data || []).map((row) => contactFromRow(row));
  const contactsByClient = new Map<string, typeof contacts>();
  for (const contact of contacts) {
    const list = contactsByClient.get(contact.prospectId) || [];
    list.push(contact);
    contactsByClient.set(contact.prospectId, list);
  }
  const dossierByOpportunity = new Map((dossierResult.data || []).map((row) => [
    String(row.opportunity_id),
    String(row.no_dossier),
  ]));
  const quoteByOpportunity = new Map<string, string>();
  for (const quote of quoteResult.data || []) {
    if (!quoteByOpportunity.has(String(quote.opportunity_id))) {
      quoteByOpportunity.set(String(quote.opportunity_id), String(quote.quote_number));
    }
  }
  const profileNames = new Map((profilesResult.data || []).map((profile) => [
    String(profile.id),
    `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
  ]));
  const opportunities = visibleOpportunityRows.flatMap((row) => {
    const prospectId = String(row.prospect_id);
    const client = clientById.get(prospectId);
    if (!client) return [];
    return [{
      id: String(row.id),
      prospectId,
      assignedTo: typeof row.assigned_to === 'string' ? row.assigned_to : null,
      assignedToName: typeof row.assigned_to === 'string' ? profileNames.get(row.assigned_to) || '' : '',
      title: String(row.title),
      stage: String(row.stage),
      transportMode: typeof row.transport_mode === 'string' ? row.transport_mode : null,
      direction: typeof row.direction === 'string' ? row.direction : null,
      origin: typeof row.origin === 'string' ? row.origin : null,
      destination: typeof row.destination === 'string' ? row.destination : null,
      goodsDescription: typeof row.goods_description === 'string' ? row.goods_description : null,
      weightKg: row.weight_kg === null ? null : Number(row.weight_kg),
      volumeM3: row.volume_m3 === null ? null : Number(row.volume_m3),
      incoterm: typeof row.incoterm === 'string' ? row.incoterm : null,
      estimatedValue: Number(row.estimated_value || 0),
      currency: String(row.currency || 'XAF'),
      expectedCloseDate: typeof row.expected_close_date === 'string' ? row.expected_close_date : null,
      wonReason: typeof row.won_reason === 'string' ? row.won_reason : null,
      contractReference: typeof row.contract_reference === 'string' ? row.contract_reference : null,
      notes: typeof row.notes === 'string' ? row.notes : null,
      client,
      contacts: contactsByClient.get(prospectId) || [],
      quoteNumber: quoteByOpportunity.get(String(row.id)) || null,
      dossierNumber: dossierByOpportunity.get(String(row.id)) || null,
    }];
  });
  const activities = visibleActivityRows.map((row) => ({
    id: String(row.id),
    prospectId: String(row.prospect_id),
    opportunityId: typeof row.opportunity_id === 'string' ? row.opportunity_id : null,
    assignedTo: typeof row.assigned_to === 'string' ? row.assigned_to : null,
    activityType: String(row.activity_type),
    title: String(row.title),
    dueAt: typeof row.due_at === 'string' ? row.due_at : null,
    status: String(row.status),
    notes: typeof row.notes === 'string' ? row.notes : null,
    clientName: clientById.get(String(row.prospect_id))?.companyName
      || clientById.get(String(row.prospect_id))?.name
      || 'Client',
  }));
  const campaignIds = (campaignsResult.data || []).map((row) => String(row.id));
  const recipientResult = campaignIds.length
    ? await admin.from('sales_campaign_prospects').select('campaign_id, prospect_id').in('campaign_id', campaignIds)
    : { data: [], error: null };
  if (recipientResult.error) {
    databaseFailure(res, recipientResult.error);
    return;
  }
  const campaignFilters = (campaignsResult.data || [])
    .map((row) => row.filters)
    .flatMap((filters) => isRecord(filters) && Array.isArray(filters['transportModes'])
      ? filters['transportModes'].filter((mode): mode is string => mode === 'air' || mode === 'sea')
      : []);
  const usedModes = [...new Set(campaignFilters)];
  const campaignModeProspects = new Map<string, Set<string>>();
  if (usedModes.length && clientIds.length) {
    const { data: modeRows, error: modeError } = await admin.from('sales_opportunities')
      .select('prospect_id, transport_mode').in('prospect_id', clientIds).in('transport_mode', usedModes);
    if (modeError) {
      databaseFailure(res, modeError);
      return;
    }
    for (const row of modeRows || []) {
      const modes = campaignModeProspects.get(String(row.prospect_id)) || new Set<string>();
      modes.add(String(row.transport_mode));
      campaignModeProspects.set(String(row.prospect_id), modes);
    }
  }
  const preparedProspectIds = [...new Set(
    (recipientResult.data || [])
      .map((recipient) => (recipient as JsonRecord)['prospect_id'])
      .filter((id): id is string => typeof id === 'string')
  )];
  const visiblePreparedProspectIds = preparedProspectIds.filter((id) => clientById.has(id));
  const preparedClients = visiblePreparedProspectIds.length
    ? await admin.from('prospects').select('id, assigned_to').in('id', visiblePreparedProspectIds)
    : { data: [], error: null };
  if (preparedClients.error) {
    databaseFailure(res, preparedClients.error);
    return;
  }
  const preparedClientById = new Map((preparedClients.data || []).map((client) => [
    String(client.id),
    client.assigned_to as string | null,
  ]));
  const campaigns = (campaignsResult.data || []).map((row) => {
    const filters = isRecord(row.filters) ? row.filters : {};
    const preparedRecipients = (recipientResult.data || []).filter((recipient) =>
      String(recipient.campaign_id) === String(row.id)
    );
    const audienceCount = preparedRecipients.filter((recipient) => {
      const clientId = String((recipient as JsonRecord)['prospect_id']);
      if (!preparedClientById.has(clientId)) return false;
      if (filters['assignedTo'] && preparedClientById.get(clientId) !== filters['assignedTo']) return false;
      if (Array.isArray(filters['statuses']) && filters['statuses'].length) {
        const client = clients.find((item) => item.id === clientId);
        if (!client || !filters['statuses'].includes(client.status)) return false;
      }
      if (Array.isArray(filters['countries']) && filters['countries'].length) {
        const client = clients.find((item) => item.id === clientId);
        if (!client || !filters['countries'].includes(client.country)) return false;
      }
      return matchesTransportMode(filters, [...(campaignModeProspects.get(clientId) || [])]);
    }).length;
    return campaignFromRow(row, audienceCount);
  });
  res.json({
    clients,
    contacts,
    opportunities,
    activities,
    campaigns,
    canManageTeam: teamRead,
  });
};

export const listCrmClientsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  if (!admin || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
  const rawOffset = Number(req.query['offset']);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 100000) : 0;
  const search = typeof req.query['search'] === 'string'
    ? req.query['search'].replace(SEARCH_PATTERN, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
    : '';
  const status = req.query['status'];
  if (typeof status === 'string' && status && !PROSPECT_STATUSES.includes(status as ProspectStatus)) {
    res.status(400).json({ error: 'Le statut de société est invalide.' });
    return;
  }
  let query = admin.from('prospects')
    .select('id, name, company_name, contact_name, contact_role, email, phone, country, sector, status, assigned_to', { count: 'exact' })
    .order('updated_at', { ascending: false }).range(offset, offset + limit - 1);
  const teamRead = await canSeeTeam(actor.id);
  if (status) query = query.eq('status', status);
  if (search) {
    const searchableColumns = ['name', 'company_name', 'contact_name', 'email', 'country'];
    const searchTerm = `%${search}%`;
    const searchFilter = teamRead
      ? searchableColumns.map((column) => `${column}.ilike.${searchTerm}`).join(',')
      : searchableColumns.flatMap((column) => [
        `and(assigned_to.eq.${actor.id},${column}.ilike.${searchTerm})`,
        `and(created_by.eq.${actor.id},${column}.ilike.${searchTerm})`,
      ]).join(',');
    query = query.or(searchFilter);
  } else if (!teamRead) {
    query = query.or(`assigned_to.eq.${actor.id},created_by.eq.${actor.id}`);
  }
  const { data, error, count } = await query;
  if (error) {
    databaseFailure(res, error);
    return;
  }
  const prospectIds = (data || []).map((row) => String(row.id));
  const contactsResult = prospectIds.length
    ? await admin.from('prospect_contacts').select('*').in('prospect_id', prospectIds)
      .order('is_primary', { ascending: false }).order('full_name')
    : { data: [], error: null };
  if (contactsResult.error) {
    databaseFailure(res, contactsResult.error);
    return;
  }
  res.json({
    clients: (data || []).map((row) => ({
      ...clientFromRow(row),
      contacts: (contactsResult.data || []).filter((contact) => String(contact.prospect_id) === String(row.id))
        .map((contact) => contactFromRow(contact)),
    })),
    total: count ?? data?.length ?? 0,
    limit,
    offset,
  });
};

export const createCrmClientHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  if (!admin || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const validated = validateCrmClientPayload(req.body);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'Le client est invalide.' });
    return;
  }
  const companyPattern = String(validated.data['company_name']).replace(/[\\%_]/g, '\\$&');
  const { data: duplicate, error: duplicateError } = await admin.from('prospects')
    .select('id').ilike('company_name', companyPattern).limit(1).maybeSingle();
  if (duplicateError) {
    databaseFailure(res, duplicateError);
    return;
  }
  if (duplicate) {
    res.status(409).json({ error: 'Cette société existe déjà dans les prospects ou clients. Ouvrez sa fiche pour éviter un doublon.' });
    return;
  }
  const { data, error } = await admin.from('prospects')
    .insert({ ...validated.data, assigned_to: actor.id, created_by: actor.id })
    .select('id, name, company_name, contact_name, contact_role, email, phone, country, sector, status, assigned_to')
    .single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'client insert returned no row' });
    return;
  }
  await audit(req, actor, 'CREATE_CRM_CLIENT', 'prospect', String(data.id), { company_name: data.company_name });
  res.status(201).json({ client: clientFromRow(data) });
};

export const createCrmContactHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  const prospectId = req.params['prospectId'];
  if (!admin || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  if (typeof prospectId !== 'string' || !UUID_PATTERN.test(prospectId)) {
    res.status(400).json({ error: 'La société sélectionnée est invalide.' });
    return;
  }
  const validated = validateCrmContactPayload(req.body);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'Le contact est invalide.' });
    return;
  }
  const teamManage = await canManageTeam(actor.id);
  const { data: client, error: clientError } = await admin.from('prospects')
    .select('id, assigned_to, created_by').eq('id', prospectId).maybeSingle();
  if (clientError) {
    databaseFailure(res, clientError);
    return;
  }
  if (!client) {
    res.status(404).json({ error: 'Client introuvable.' });
    return;
  }
  if (!ownsRecord(client, actor) && !teamManage) {
    res.status(403).json({ error: 'Vous ne pouvez pas modifier une société attribuée à un autre commercial.' });
    return;
  }
  const { data, error } = await admin.from('prospect_contacts')
    .insert({ ...validated.data, prospect_id: prospectId, created_by: actor.id })
    .select('*').single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'contact insert returned no row' });
    return;
  }
  await audit(req, actor, 'CREATE_CRM_CONTACT', 'prospect_contact', String(data.id), { prospect_id: prospectId });
  res.status(201).json({ contact: contactFromRow(data) });
};

export const createCrmOpportunityHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  if (!admin || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const validated = validateCrmOpportunityPayload(req.body);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'L’opportunité est invalide.' });
    return;
  }
  if (validated.data['stage'] === 'won' || validated.data['won_reason']) {
    res.status(400).json({ error: 'Enregistrez une cotation acceptée ou un contrat signé pour gagner une opportunité.' });
    return;
  }
  const prospectId = String(validated.data['prospect_id']);
  const teamManage = await canManageTeam(actor.id);
  const { data: client, error: clientError } = await admin.from('prospects')
    .select('id, assigned_to, created_by').eq('id', prospectId).maybeSingle();
  if (clientError) {
    databaseFailure(res, clientError);
    return;
  }
  if (!client) {
    res.status(404).json({ error: 'La société sélectionnée est introuvable.' });
    return;
  }
  if (!ownsRecord(client, actor) && !teamManage) {
    res.status(403).json({ error: 'Vous ne pouvez créer une opportunité que pour une société qui vous est attribuée.' });
    return;
  }
  if (validated.data['assigned_to'] && validated.data['assigned_to'] !== actor.id && !teamManage) {
    res.status(403).json({ error: 'Vous ne pouvez pas attribuer cette opportunité à un autre commercial.' });
    return;
  }
  validated.data['assigned_to'] ||= actor.id;
  const { data, error } = await admin.from('sales_opportunities')
    .insert({ ...validated.data, created_by: actor.id })
    .select('*').single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'opportunity insert returned no row' });
    return;
  }
  await audit(req, actor, 'CREATE_CRM_OPPORTUNITY', 'sales_opportunity', String(data.id), { prospect_id: prospectId });
  res.status(201).json({ opportunity: data });
};

export const updateCrmOpportunityHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  const id = req.params['id'];
  if (!admin || !actor?.id || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    else res.status(400).json({ error: 'L’opportunité sélectionnée est invalide.' });
    return;
  }
  const validated = validateCrmOpportunityPayload(req.body, true);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'Les modifications sont invalides.' });
    return;
  }
  const { data: current, error: currentError } = await admin.from('sales_opportunities')
    .select('*').eq('id', id).maybeSingle();
  if (currentError) {
    databaseFailure(res, currentError);
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'Opportunité introuvable.' });
    return;
  }
  const teamManage = await canManageTeam(actor.id);
  if (!ownsRecord(current, actor) && !teamManage) {
    res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres opportunités.' });
    return;
  }
  if (current.stage === 'won' && validated.data['stage'] && validated.data['stage'] !== 'won') {
    res.status(409).json({ error: 'Une opportunité gagnée ne peut pas être déplacée vers une autre étape.' });
    return;
  }
  if (validated.data['assigned_to'] !== undefined && validated.data['assigned_to'] !== actor.id && !teamManage) {
    res.status(403).json({ error: 'Vous ne pouvez pas réattribuer cette opportunité.' });
    return;
  }
  const nextStage = validated.data['stage'] || current.stage;
  if (nextStage === 'won') {
    const reason = validated.data['won_reason'] || current.won_reason;
    const reference = validated.data['contract_reference'] || current.contract_reference;
    if (reason !== 'signed_contract' || !reference) {
      res.status(400).json({ error: 'Renseignez la référence du contrat signé pour gagner cette opportunité.' });
      return;
    }
  } else if (Object.hasOwn(validated.data, 'stage')) {
    validated.data['won_reason'] = null;
    validated.data['contract_reference'] = null;
  }
  const { data, error } = await admin.from('sales_opportunities')
    .update(validated.data).eq('id', id).select('*').single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'opportunity update returned no row' });
    return;
  }
  if (data.stage === 'won' && current.stage !== 'won') {
    const { error: prospectUpdateError } = await admin.from('prospects')
      .update({ status: 'converted' }).eq('id', data.prospect_id);
    if (prospectUpdateError) {
      databaseFailure(res, prospectUpdateError);
      return;
    }
  } else if (data.stage === 'qualified' && current.stage !== 'qualified') {
    const { error: prospectUpdateError } = await admin.from('prospects')
      .update({ status: 'qualified' }).eq('id', data.prospect_id).neq('status', 'converted');
    if (prospectUpdateError) {
      databaseFailure(res, prospectUpdateError);
      return;
    }
  }
  await audit(req, actor, 'UPDATE_CRM_OPPORTUNITY', 'sales_opportunity', id, { stage: data.stage });
  res.json({ opportunity: data });
};

export const createCrmActivityHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  if (!admin || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const validated = validateCrmActivityPayload(req.body);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'L’activité est invalide.' });
    return;
  }
  const teamManage = await canManageTeam(actor.id);
  const prospectId = String(validated.data['prospect_id']);
  const { data: client, error: clientError } = await admin.from('prospects')
    .select('id, assigned_to, created_by').eq('id', prospectId).maybeSingle();
  if (clientError) {
    databaseFailure(res, clientError);
    return;
  }
  if (!client || (!ownsRecord(client, actor) && !teamManage)) {
    res.status(client ? 403 : 404).json({ error: client ? 'Vous ne pouvez créer une activité pour ce client.' : 'Client introuvable.' });
    return;
  }
  if (validated.data['opportunity_id']) {
    const { data: opportunity, error } = await admin.from('sales_opportunities')
      .select('id, prospect_id, assigned_to').eq('id', String(validated.data['opportunity_id'])).maybeSingle();
    if (error) {
      databaseFailure(res, error);
      return;
    }
    if (!opportunity || opportunity.prospect_id !== prospectId
      || (opportunity.assigned_to !== actor.id && !teamManage)) {
      res.status(400).json({ error: 'L’opportunité ne correspond pas au client sélectionné ou n’est pas accessible.' });
      return;
    }
  }
  const { data, error } = await admin.from('sales_activities')
    .insert({ ...validated.data, assigned_to: actor.id, created_by: actor.id })
    .select('*').single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'activity insert returned no row' });
    return;
  }
  await audit(req, actor, 'CREATE_CRM_ACTIVITY', 'sales_activity', String(data.id), { prospect_id: prospectId });
  res.status(201).json({ activity: data });
};

export const updateCrmActivityHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  const id = req.params['id'];
  if (!admin || !actor?.id || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    else res.status(400).json({ error: 'L’activité sélectionnée est invalide.' });
    return;
  }
  if (!isRecord(req.body) || Object.keys(req.body).some((key) => key !== 'status')
    || typeof req.body['status'] !== 'string'
    || !ACTIVITY_STATUSES.includes(req.body['status'] as typeof ACTIVITY_STATUSES[number])) {
    res.status(400).json({ error: 'Le nouveau statut de l’activité est invalide.' });
    return;
  }
  const { data: current, error: currentError } = await admin.from('sales_activities')
    .select('id, assigned_to, created_by').eq('id', id).maybeSingle();
  if (currentError) {
    databaseFailure(res, currentError);
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'Activité introuvable.' });
    return;
  }
  if (!ownsRecord(current, actor) && !await canManageTeam(actor.id)) {
    res.status(403).json({ error: 'Vous ne pouvez modifier que vos propres activités.' });
    return;
  }
  const status = req.body['status'];
  const { data, error } = await admin.from('sales_activities')
    .update({ status, completed_at: status === 'completed' ? new Date().toISOString() : null })
    .eq('id', id).select('*').single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'activity update returned no row' });
    return;
  }
  await audit(req, actor, 'UPDATE_CRM_ACTIVITY', 'sales_activity', id, { status });
  res.json({ activity: data });
};

export const createCrmCampaignHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  if (!admin || !actor?.id) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    return;
  }
  const validated = validateCrmCampaignPayload(req.body);
  if (validated.error || !validated.data) {
    res.status(400).json({ error: validated.error || 'La campagne est invalide.' });
    return;
  }
  const { data, error } = await admin.from('sales_campaigns')
    .insert({ ...validated.data, created_by: actor.id })
    .select('*').single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'campaign insert returned no row' });
    return;
  }
  await audit(req, actor, 'CREATE_CRM_CAMPAIGN', 'sales_campaign', String(data.id));
  res.status(201).json({ campaign: campaignFromRow(data, 0) });
};

export const prepareCrmCampaignHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  const id = req.params['id'];
  if (!admin || !actor?.id || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    else res.status(400).json({ error: 'La campagne sélectionnée est invalide.' });
    return;
  }
  const { data: campaign, error: campaignError } = await admin.from('sales_campaigns')
    .select('id, created_by, filters').eq('id', id).maybeSingle();
  if (campaignError) {
    databaseFailure(res, campaignError);
    return;
  }
  if (!campaign) {
    res.status(404).json({ error: 'Campagne introuvable.' });
    return;
  }
  if (campaign.created_by !== actor.id && !await canManageTeam(actor.id)) {
    res.status(403).json({ error: 'Vous ne pouvez préparer que les campagnes que vous avez créées.' });
    return;
  }
  const filters = isRecord(campaign.filters) ? campaign.filters : {};
  let query = admin.from('prospects').select('id, status, country, assigned_to').limit(1000);
  if (!await canSeeTeam(actor.id)) query = query.or(`assigned_to.eq.${actor.id},created_by.eq.${actor.id}`);
  if (Array.isArray(filters['statuses']) && filters['statuses'].length) {
    query = query.in('status', filters['statuses'] as string[]);
  }
  if (Array.isArray(filters['countries']) && filters['countries'].length) {
    query = query.in('country', filters['countries'] as string[]);
  }
  if (typeof filters['assignedTo'] === 'string') {
    if (filters['assignedTo'] !== actor.id && !await canSeeTeam(actor.id)) {
      res.status(403).json({ error: 'Vous ne pouvez cibler que les clients qui vous sont attribués.' });
      return;
    }
    query = query.eq('assigned_to', filters['assignedTo']);
  }
  const { data: prospects, error: prospectsError } = await query;
  if (prospectsError) {
    databaseFailure(res, prospectsError);
    return;
  }
  let prospectIds = (prospects || []).map((row) => String(row.id));
  const modes = Array.isArray(filters['transportModes']) ? filters['transportModes'] as string[] : [];
  if (modes.length && prospectIds.length) {
    const { data: opportunities, error } = await admin.from('sales_opportunities')
      .select('prospect_id').in('prospect_id', prospectIds).in('transport_mode', modes);
    if (error) {
      databaseFailure(res, error);
      return;
    }
    const matched = new Set((opportunities || []).map((row) => String(row.prospect_id)));
    prospectIds = prospectIds.filter((prospectId) => matched.has(prospectId));
  }
  const { data: preparedCount, error: prepareError } = await admin.rpc('prepare_sales_campaign_audience', {
    p_campaign_id: id,
    p_prospect_ids: prospectIds,
  });
  if (prepareError) {
    databaseFailure(res, prepareError);
    return;
  }
  await audit(req, actor, 'PREPARE_CRM_CAMPAIGN', 'sales_campaign', id, { audience_count: Number(preparedCount) || 0 });
  res.json({ audienceCount: Number(preparedCount) || 0, sent: false });
};

export const createCrmDossierHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const admin = getAdminClient(res);
  const actor = getActor(req);
  const opportunityId = req.params['id'];
  if (!admin || !actor?.id || typeof opportunityId !== 'string' || !UUID_PATTERN.test(opportunityId)) {
    if (!actor?.id) res.status(401).json({ error: 'Utilisateur non authentifié.' });
    else res.status(400).json({ error: 'L’opportunité sélectionnée est invalide.' });
    return;
  }
  if (!isRecord(req.body) || Object.keys(req.body).some((key) => !['noDossier', 'description'].includes(key))) {
    res.status(400).json({ error: 'Les informations du dossier sont invalides.' });
    return;
  }
  const noDossier = typeof req.body['noDossier'] === 'string' ? req.body['noDossier'].trim() : '';
  const description = typeof req.body['description'] === 'string' ? req.body['description'].trim() : '';
  if (!noDossier || noDossier.length > 100 || description.length > 1000) {
    res.status(400).json({ error: 'Le numéro du dossier est obligatoire et ne doit pas dépasser 100 caractères.' });
    return;
  }
  const { data: opportunity, error: opportunityError } = await admin.from('sales_opportunities')
    .select('id, prospect_id, assigned_to, created_by, stage').eq('id', opportunityId).maybeSingle();
  if (opportunityError) {
    databaseFailure(res, opportunityError);
    return;
  }
  if (!opportunity) {
    res.status(404).json({ error: 'Opportunité introuvable.' });
    return;
  }
  if (opportunity.stage !== 'won') {
    res.status(409).json({ error: 'Vérifiez que l’opportunité est gagnée avant de créer un dossier.' });
    return;
  }
  if (!ownsRecord(opportunity, actor) && !await canManageTeam(actor.id)) {
    res.status(403).json({ error: 'Vous ne pouvez créer un dossier que pour une opportunité qui vous est attribuée.' });
    return;
  }
  const { data: existing, error: existingError } = await admin.from('dossiers')
    .select('id').eq('opportunity_id', opportunityId).maybeSingle();
  if (existingError) {
    databaseFailure(res, existingError);
    return;
  }
  if (existing) {
    res.status(409).json({ error: 'Un dossier est déjà lié à cette opportunité.' });
    return;
  }
  const { data: client, error: clientError } = await admin.from('prospects')
    .select('id, name, company_name').eq('id', opportunity.prospect_id).maybeSingle();
  if (clientError) {
    databaseFailure(res, clientError);
    return;
  }
  if (!client) {
    res.status(409).json({ error: 'La société liée à cette opportunité n’existe plus.' });
    return;
  }
  const { data, error } = await admin.from('dossiers').insert({
    no_dossier: noDossier,
    prospect_id: opportunity.prospect_id,
    opportunity_id: opportunityId,
    client: client.company_name || client.name,
    description: description || null,
    created_by: actor.id,
  }).select('id, no_dossier, client, opportunity_id').single();
  if (error || !data) {
    databaseFailure(res, error || { message: 'dossier insert returned no row' });
    return;
  }
  await audit(req, actor, 'CREATE_CRM_DOSSIER', 'dossier', String(data.id), {
    opportunity_id: opportunityId,
    no_dossier: noDossier,
  });
  res.status(201).json({ dossier: data });
};
