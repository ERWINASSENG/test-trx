export const PROSPECT_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;

export type ProspectStatus = typeof PROSPECT_STATUSES[number];

export interface ProspectAssignee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface Prospect {
  id: string;
  name: string;
  companyName: string | null;
  contactName: string | null;
  contactRole?: string | null;
  country?: string | null;
  sector?: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: ProspectStatus;
  assignedTo: string | null;
  estimatedValue: number | null;
  currency: string;
  nextFollowUp: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProspectInput {
  name?: string;
  companyName?: string | null;
  contactName?: string | null;
  contactRole?: string | null;
  country?: string | null;
  sector?: string | null;
  email?: string | null;
  phone?: string | null;
  source?: string | null;
  status?: ProspectStatus;
  assignedTo?: string | null;
  estimatedValue?: number | null;
  currency?: string;
  nextFollowUp?: string | null;
  notes?: string;
}

export type UpdateProspectInput = Partial<CreateProspectInput>;
