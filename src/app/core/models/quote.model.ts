export const QUOTE_COLUMN_TYPES = ['text', 'number', 'amount', 'date', 'checkbox'] as const;
export type QuoteColumnType = typeof QUOTE_COLUMN_TYPES[number];

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const;
export type QuoteStatus = typeof QUOTE_STATUSES[number];

export interface QuoteColumn {
  id: string;
  label: string;
  type: QuoteColumnType;
}

export type QuoteCellValue = string | number | boolean | null;
export type QuoteRow = Record<string, QuoteCellValue>;

export interface SeaFreightDetails {
  // Informations client complémentaires
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;

  // Détails expédition
  goodsType?: string;
  goodsDescription?: string;
  grossWeightKg?: number | null;
  totalVolumeM3?: number | null;
  packagesCount?: number | null;
  packagingType?: string;

  // Itinéraire souhaité
  portOfLoading?: string;
  portOfDischarge?: string;
  incoterm?: string;
  estimatedDepartureDate?: string | null;
  estimatedArrivalDate?: string | null;
  needInlandTransport?: boolean;

  // Type de service souhaité
  serviceTypes?: {
    fcl?: boolean;
    lcl?: boolean;
    roro?: boolean;
    breakBulk?: boolean;
    other?: string;
  };

  // Documents disponibles
  availableDocuments?: {
    commercialInvoice?: boolean;
    packingList?: boolean;
    certificateOfOrigin?: boolean;
    msdsTechnicalSheet?: boolean;
    other?: string;
  };

  // Services additionnels requis
  additionalServices?: {
    customsClearance?: boolean;
    cargoInsurance?: boolean;
    warehousing?: boolean;
    portHandling?: boolean;
    tracking?: boolean;
  };
}

export interface SalesQuote {
  id: string;
  quoteNumber: string;
  prospectId: string;
  opportunityId?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  opportunityTitle?: string | null;
  dossierId?: string | null;
  dossierNumber?: string | null;
  prospectName: string;
  assignedTo: string | null;
  assignedToName: string | null;
  createdBy: string | null;
  title: string;
  currency: string;
  columns: QuoteColumn[];
  rows: QuoteRow[];
  totalColumnId: string;
  totalAmount: number;
  status: QuoteStatus;
  validUntil: string | null;
  seaFreight?: SeaFreightDetails;
  sentAt?: string | null;
  respondedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteContact {
  id: string;
  prospectId: string;
  fullName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
}

export interface QuoteTemplate {
  id: string;
  name: string;
  columns: QuoteColumn[];
  totalColumnId: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteAssignee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface QuoteTimingItem {
  id: string;
  quoteNumber: string;
  clientName: string;
  details: string;
  repId: string;
  repName: string;
  amount: number;
  amountFormatted: string;
  status: string;
  commercialMinutes: number;
  commercialDelayFormatted: string;
  clientMinutes: number | null;
  clientDelayFormatted: string;
  isSlaBreach: boolean;
  isOverdue: boolean;
  date: string;
  createdAtFormatted: string;
  sentAtFormatted: string;
  respondedAtFormatted: string;
}

export interface SalesRepPerformance {
  repId: string;
  repName: string;
  quotesCount: number;
  avgDelayFormatted: string;
  slaRateFormatted: string;
  conversionRateFormatted: string;
  totalAmount: number;
  totalAmountFormatted: string;
}

export interface QuoteTimingKpis {
  avgDelayFormatted: string;
  avgDelayMinutes: number;
  slaComplianceRateFormatted: string;
  slaCompliancePercent: number;
  inProgressCount: number;
  overdueCount: number;
  totalAmount: number;
  totalAmountFormatted: string;
  conversionRateFormatted: string;
  conversionPercent: number;
}

export interface QuoteTimingAnalyticsResponse {
  kpis: QuoteTimingKpis;
  quotes: QuoteTimingItem[];
  reps: SalesRepPerformance[];
  totalCount: number;
}

export type QuoteTimingPeriod = '7d' | 'month' | 'quarter' | 'year' | 'day';

export interface QuoteTimingFilter {
  period: QuoteTimingPeriod;
  date?: string | null;
  repId?: string;
  search?: string;
  status?: string;
}
