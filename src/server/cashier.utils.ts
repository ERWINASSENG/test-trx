export const formatPersistedPieceComptable = (row: Record<string, unknown>): Record<string, unknown> => {
  const existingPiece = typeof row['piece_comptable'] === 'string' && row['piece_comptable'].trim()
    ? row['piece_comptable'].trim().toUpperCase().replace(/\s+/g, '')
    : null;

  if (existingPiece) {
    return {
      ...row,
      piece_comptable: existingPiece,
    };
  }

  const rawDate = row['date'];
  let year = 2026;
  if (typeof rawDate === 'string' && rawDate.trim()) {
    if (rawDate.includes('/')) {
      const parts = rawDate.split('/');
      if (parts.length === 3 && parts[2]) {
        const parsedYear = parseInt(parts[2], 10);
        if (!isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100) year = parsedYear;
      }
    } else {
      const parsedYear = new Date(rawDate).getFullYear();
      if (!isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100) year = parsedYear;
    }
  }

  return {
    ...row,
    piece_comptable: `CSH1/${year}/00001`,
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
