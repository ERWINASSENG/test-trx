import type { SupabaseClient } from '@supabase/supabase-js';

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

/**
 * Calcule de manière déterministe le prochain numéro de pièce comptable séquentiel Odoo (ex: CSH1/2026/00042)
 * pour une année donnée en interrogeant la table `cashier_transactions`.
 *
 * Algorithme :
 * 1. Détermine l'année à partir de la date d'opération fournie (ou année courante).
 * 2. Cherche les pièces comptables existantes de l'année (préfixe `CSH1/{year}/`).
 * 3. Extrait le numéro séquentiel maximal (`maxSeq`).
 * 4. Retourne `CSH1/{year}/{maxSeq + 1 + offset}` avec padding sur 5 chiffres.
 */
export const computeNextPieceComptable = async (
  client: SupabaseClient,
  dateStr?: string | null,
  offset = 0
): Promise<string> => {
  let year = new Date().getFullYear();
  if (typeof dateStr === 'string' && dateStr.trim()) {
    const trimmed = dateStr.trim();
    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      if (parts.length === 3 && parts[2]) {
        const parsedYear = parseInt(parts[2], 10);
        if (!isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100) year = parsedYear;
      }
    } else {
      const parsedYear = new Date(trimmed).getFullYear();
      if (!isNaN(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100) year = parsedYear;
    }
  }

  const prefix = `CSH1/${year}/`;

  const { data, error } = await client
    .from('cashier_transactions')
    .select('piece_comptable')
    .ilike('piece_comptable', `${prefix}%`);

  let maxSeq = 0;

  if (!error && Array.isArray(data)) {
    for (const row of data) {
      const piece = typeof row['piece_comptable'] === 'string'
        ? row['piece_comptable'].trim().toUpperCase().replace(/\s+/g, '')
        : '';
      if (piece.startsWith(prefix)) {
        const seqStr = piece.substring(prefix.length);
        const seqNum = parseInt(seqStr, 10);
        if (!isNaN(seqNum) && seqNum > maxSeq) {
          maxSeq = seqNum;
        }
      }
    }
  }

  const nextSeq = maxSeq + 1 + offset;
  return `${prefix}${String(nextSeq).padStart(5, '0')}`;
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
