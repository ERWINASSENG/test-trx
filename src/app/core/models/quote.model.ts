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

export interface SalesQuote {
  id: string;
  quoteNumber: string;
  prospectId: string;
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
  createdAt: string;
  updatedAt: string;
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
