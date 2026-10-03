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
