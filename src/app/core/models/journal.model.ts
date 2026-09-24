export type JournalType = 'cash' | 'bank' | 'sale' | 'purchase' | 'general';

export interface Journal {
  id: string;
  name: string;
  type: JournalType;
  type_label?: string;
  ledger_type?: string;
  sequence_prefix: string;
  default_account: string;
  currency: string;
  is_active: boolean;
  selected?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface CreateJournalDto {
  name: string;
  type: JournalType;
  ledger_type?: string;
  sequence_prefix: string;
  default_account: string;
  currency?: string;
  is_active?: boolean;
}
