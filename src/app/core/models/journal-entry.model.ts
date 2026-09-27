/**
 * Interface d'une écriture comptable dans un journal dédié (Banque, Ventes, etc.)
 * Isolation hermétique par rapport à la table cashier_transactions.
 */
export interface JournalEntry {
  id: string;
  journal_id: string;
  sequence_number: number;
  piece_comptable: string; // Ex: BNK1/2026/00001, SGBC/2026/00001
  date: string; // Format YYYY-MM-DD
  libelle: string;
  service?: string;
  type_description?: string;
  category: 'entree' | 'sortie';
  status: 'draft' | 'posted' | 'cancelled';
  no_dossier?: string;
  partenaire?: string;
  employee?: string;
  quantity?: number;
  montant: number; // Positif si entrée, négatif si sortie
  solde_apres?: number;
  created_by?: string;
  employee_id?: string;
  created_at: string;
  updated_at: string;
  selected?: boolean;
}

/**
 * DTO de création d'une nouvelle écriture de journal
 */
export interface CreateJournalEntryDto {
  journal_id: string;
  date?: string;
  libelle: string;
  service?: string;
  type_description?: string;
  category: 'entree' | 'sortie';
  status?: 'draft' | 'posted';
  no_dossier?: string;
  partenaire?: string;
  employee?: string;
  quantity?: number;
  montant: number;
}

/**
 * DTO de mise à jour d'une écriture de journal
 */
export interface UpdateJournalEntryDto {
  date?: string;
  libelle?: string;
  service?: string;
  type_description?: string;
  category?: 'entree' | 'sortie';
  status?: 'draft' | 'posted' | 'cancelled';
  no_dossier?: string;
  partenaire?: string;
  employee?: string;
  quantity?: number;
  montant?: number;
}

/**
 * Structure des données pour les graphiques de suivi chronologique Chart.js
 */
export interface JournalChartData {
  journal_id: string;
  current_balance: number;
  labels: string[]; // Dates formatées (ex: 27 Sept)
  balances: number[]; // Solde cumulé chronologique
  descriptions: string[]; // Libellés des opérations
}
