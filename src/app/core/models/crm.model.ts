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
export type CrmTransportMode = 'air' | 'sea';
export type CrmDirection = 'import' | 'export';

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
  quoteNumber: string | null;
  dossierNumber: string | null;
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
  assignedTo: string | null;
  activityType: CrmActivityType;
  title: string;
  dueAt: string | null;
  status: 'pending' | 'completed' | 'cancelled';
  notes: string | null;
  clientName: string;
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
