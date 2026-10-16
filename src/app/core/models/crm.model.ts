import type { QuoteStatus } from './quote.model';

export const CRM_OPPORTUNITY_STAGES = [
  'new',
  'qualified',
  'quote_preparation',
  'quote_sent',
  'negotiation',
  'won',
  'lost',
] as const;

export type CrmOpportunityStage = typeof CRM_OPPORTUNITY_STAGES[number];
export type CrmTransportMode = 'air' | 'sea' | 'road';
export type CrmDirection = 'import' | 'export' | 'transit';

export const CRM_INCOTERMS = [
  'EXW',
  'FCA',
  'FAS',
  'FOB',
  'CFR',
  'CIF',
  'CPT',
  'CIP',
  'DAP',
  'DPU',
  'DDP',
] as const;

export type CrmIncoterm = typeof CRM_INCOTERMS[number];

export const CRM_COMMON_HUBS = [
  'Port de Douala (CM DLA)',
  'Port de Kribi (CM KBI)',
  'Aéroport Douala (DLA)',
  'Aéroport Yaoundé Nsimalen (NSI)',
  'N\'Djamena (Tchad)',
  'Bangui (RCA)',
  'Port d\'Anvers (BE ANR)',
  'Port du Havre (FR LEH)',
  'Port de Shanghai (CN SHA)',
  'Port de Ningbo (CN NGB)',
  'Port de Guangzhou (CN CAN)',
  'Dubai Jebel Ali (AE JEA)',
] as const;

export interface CrmClient {
  id: string;
  name: string;
  companyName: string | null;
  contactName: string | null;
  contactRole: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  sector: string | null;
  status: string;
  assignedTo: string | null;
}

export interface CrmContact {
  id: string;
  prospectId: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
}

export interface CrmOpportunity {
  id: string;
  prospectId: string;
  assignedTo: string | null;
  assignedToName: string;
  title: string;
  stage: CrmOpportunityStage;
  transportMode: CrmTransportMode | null;
  direction: CrmDirection | null;
  origin: string | null;
  destination: string | null;
  goodsDescription: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  incoterm: string | null;
  estimatedValue: number;
  currency: string;
  expectedCloseDate: string | null;
  wonReason: 'accepted_quote' | 'signed_contract' | null;
  contractReference: string | null;
  notes: string | null;
  client: CrmClient;
  contacts: CrmContact[];
  quoteId: string | null;
  quoteNumber: string | null;
  quoteStatus: QuoteStatus | null;
  dossierNumber: string | null;
  dossierId: string | null;
}

export interface CrmOpportunityInput {
  prospectId: string;
  title: string;
  transportMode: CrmTransportMode | null;
  direction: CrmDirection | null;
  origin: string | null;
  destination: string | null;
  goodsDescription: string | null;
  weightKg: number | null;
  volumeM3: number | null;
  incoterm: string | null;
  estimatedValue: number;
  currency: string;
  expectedCloseDate: string | null;
  notes: string | null;
}

export interface CrmActivityInput {
  prospectId: string;
  opportunityId?: string;
  contactId?: string;
  activityType: CrmActivityType;
  title: string;
  dueAt: string | null;
  notes: string | null;
}

export type CrmActivityType = 'call' | 'email' | 'meeting' | 'task';

export interface CrmClientInput {
  companyName: string;
  contactName: string;
  contactRole: string;
  email: string;
  phone: string;
  country: string;
  sector: string;
}

export interface CrmActivity {
  id: string;
  prospectId: string;
  opportunityId: string | null;
  contactId: string | null;
  assignedTo: string | null;
  activityType: CrmActivityType;
  title: string;
  dueAt: string | null;
  status: 'pending' | 'completed' | 'cancelled';
  notes: string | null;
  clientName: string;
  contactName: string | null;
}

export interface CrmCampaignFilters {
  statuses: string[];
  countries: string[];
  transportModes: CrmTransportMode[];
  assignedTo: string | null;
}

export interface CrmCampaign {
  id: string;
  name: string;
  status: 'planned' | 'active' | 'completed' | 'cancelled';
  startsAt: string | null;
  endsAt: string | null;
  filters: CrmCampaignFilters;
  notes: string | null;
  audienceCount: number;
}

export interface CrmOverview {
  clients: CrmClient[];
  contacts: CrmContact[];
  opportunities: CrmOpportunity[];
  activities: CrmActivity[];
  campaigns: CrmCampaign[];
  canManageTeam: boolean;
}

/**
 * Génère automatiquement un numéro de dossier normalisé Transimex
 * Format standard : TRX-DOS-AAAA-XXXX
 */
export function generateDefaultDossierNumber(year: number = new Date().getFullYear()): string {
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `TRX-DOS-${year}-${randomSuffix}`;
}

/**
 * Génère automatiquement une description contextuelle pour le dossier d'exploitation
 */
export function generateDefaultDossierDescription(opportunity: CrmOpportunity): string {
  const modeStr = opportunity.transportMode === 'sea' ? 'Maritime'
    : opportunity.transportMode === 'air' ? 'Aérien'
    : opportunity.transportMode === 'road' ? 'Routier'
    : 'Multimodal';
  const corridor = [opportunity.origin, opportunity.destination].filter(Boolean).join(' -> ');
  const cargo = opportunity.goodsDescription ? ` - ${opportunity.goodsDescription}` : '';
  const client = opportunity.client?.companyName || opportunity.client?.name || '';
  return `Transit ${modeStr}${corridor ? ` (${corridor})` : ''} pour ${client}${cargo}`.trim();
}
