/**
 * Normalise la valeur d'une pièce comptable déjà persistée en base.
 * Si la pièce comptable est présente, elle est nettoyée et normalisée en majuscules.
 * Si elle est absente ou NULL en base, elle reste strictement `null` pour refléter
 * l'état réel de la base de données et ne jamais forger un faux numéro '00001' en mémoire.
 */
export const formatPersistedPieceComptable = (row: Record<string, unknown>): Record<string, unknown> => {
  const existingPiece = typeof row['piece_comptable'] === 'string' && row['piece_comptable'].trim()
    ? row['piece_comptable'].trim().toUpperCase().replace(/\s+/g, '')
    : null;

  return {
    ...row,
    piece_comptable: existingPiece,
  };
};

export const normalizeDateToDay = (rawDate?: string | null): string => {
  if (!rawDate) return '';
  const trimmed = String(rawDate).trim();
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${day}`;
    }
  }
  if (trimmed.includes('-')) {
    const datePart = trimmed.split('T')[0].split(' ')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      const year = parts[0].length === 2 ? `20${parts[0]}` : parts[0];
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }
  return trimmed;
};

export const requiresCashierDraftBeforeEdit = (
  status: string | null | undefined,
  role: string | null | undefined
): boolean => role === 'caissiere' && status === 'posted';

export interface CashierCandidateRow {
  id?: string;
  date: string;
  montant: number;
  libelle: string;
  status?: string | null;
  service?: string | null;
  no_dossier?: string | null;
}

/**
 * Vérifie si une transaction candidate correspond à une transaction existante selon les critères d'unicité.
 * Règle métier stricte : les opérations annulées ('cancelled') sont explicitement ignorées.
 */
export const isDuplicateCashierCandidate = (
  candidate: {
    idToExclude?: string;
    date: string;
    montant: number;
    libelle: string;
    noDossier?: string | null;
    service?: string | null;
  },
  existing: CashierCandidateRow
): boolean => {
  if (candidate.idToExclude && existing.id && candidate.idToExclude === existing.id) {
    return false;
  }
  // Les opérations annulées ne bloquent plus la détection de doublons
  if (existing.status === 'cancelled') {
    return false;
  }

  const normCandidateDay = normalizeDateToDay(candidate.date);
  const normExistingDay = normalizeDateToDay(existing.date);
  if (normExistingDay !== normCandidateDay) return false;

  const candidateAbs = Math.abs(Number(candidate.montant));
  const existingAbs = Math.abs(Number(existing.montant));
  if (Math.round(existingAbs * 100) !== Math.round(candidateAbs * 100)) return false;

  const normCandidateLib = candidate.libelle.toLowerCase().trim().replace(/\s+/g, ' ');
  const normExistingLib = String(existing.libelle || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (normExistingLib !== normCandidateLib) return false;

  const normCandidateDos = (candidate.noDossier || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const normExistingDos = String(existing.no_dossier || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (normExistingDos !== normCandidateDos) return false;

  const normCandidateSrv = (candidate.service || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const normExistingSrv = String(existing.service || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (normExistingSrv !== normCandidateSrv) return false;

  return true;
};

export interface DossierExpenseTransaction {
  dossier_id?: unknown;
  status?: unknown;
  category?: unknown;
  montant?: unknown;
}

export interface DossierExpenseAggregate {
  dossierId: string;
  expenseCount: number;
  totalExpenses: number;
}

export const aggregateDossierExpenses = (
  transactions: readonly DossierExpenseTransaction[]
): DossierExpenseAggregate[] => {
  const aggregates = new Map<string, DossierExpenseAggregate>();

  for (const transaction of transactions) {
    if (transaction.status !== 'posted' || transaction.category !== 'sortie') continue;
    if (typeof transaction.dossier_id !== 'string' || !transaction.dossier_id) continue;

    const amount = Math.abs(Number(transaction.montant));
    if (!Number.isFinite(amount) || amount === 0) continue;

    const aggregate = aggregates.get(transaction.dossier_id) ?? {
      dossierId: transaction.dossier_id,
      expenseCount: 0,
      totalExpenses: 0,
    };
    aggregate.expenseCount += 1;
    aggregate.totalExpenses += amount;
    aggregates.set(transaction.dossier_id, aggregate);
  }

  return [...aggregates.values()].sort((a, b) =>
    b.totalExpenses - a.totalExpenses || a.dossierId.localeCompare(b.dossierId)
  );
};
