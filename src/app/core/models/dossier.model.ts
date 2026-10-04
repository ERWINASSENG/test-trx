export interface Dossier {
  id: string;
  prospectId: string | null;
  noDossier: string;
  client: string | null;
  statut: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DossierExpenseSummary extends Dossier {
  expenseCount: number;
  totalExpenses: number;
}