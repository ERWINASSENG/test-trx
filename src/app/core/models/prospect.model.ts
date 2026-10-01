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

export type CreateProspectInput = Pick<
  Prospect,
  'name' | 'companyName' | 'contactName' | 'email' | 'phone' | 'source' | 'status' |
  'assignedTo' | 'estimatedValue' | 'currency' | 'nextFollowUp' | 'notes'
>;

export type UpdateProspectInput = Partial<CreateProspectInput>;
