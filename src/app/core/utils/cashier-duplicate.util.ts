/**
 * Utilitaire pur de détection des opérations de caisse en double
 * Critères d'unicité stricts :
 * Date + Montant + Libellé + N° de dossier/matricule + Service
 */

/**
 * Convertit toute date ISO ou textuelle en format d'affichage JJ/MM/AAAA
 * en neutralisant strictement les décalages de fuseaux horaires (UTC vs local).
 */
export function formatIsoToDisplayDate(dateStr?: string | null): string {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();

  // Si déjà au format DD/MM/YYYY
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${day}/${month}/${year}`;
    }
  }

  // Format ISO ou YYYY-MM-DD : extraction textuelle directe pour immunité fuseau horaire
  if (trimmed.includes('-')) {
    const datePart = trimmed.split('T')[0].split(' ')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      const year = parts[0].length === 2 ? `20${parts[0]}` : parts[0];
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return `${day}/${month}/${year}`;
    }
  }

  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      const day = String(d.getUTCDate()).padStart(2, '0');
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const year = d.getUTCFullYear();
      return `${day}/${month}/${year}`;
    }
  } catch {
    // Ignorer
  }

  return trimmed;
}

/**
 * Convertit une date locale (JJ/MM/AAAA ou YYYY-MM-DD) en chaîne ISO standard (YYYY-MM-DDT00:00:00.000Z)
 * sans risque de décalage de jour.
 */
export function toStandardIsoDateString(dateStr?: string | null): string {
  if (!dateStr) return new Date().toISOString();
  const trimmed = dateStr.trim();

  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${day}T00:00:00.000Z`;
    }
  }

  if (trimmed.includes('-')) {
    const datePart = trimmed.split('T')[0].split(' ')[0];
    const parts = datePart.split('-');
    if (parts.length === 3) {
      const year = parts[0].length === 2 ? `20${parts[0]}` : parts[0];
      const month = parts[1].padStart(2, '0');
      const day = parts[2].padStart(2, '0');
      return `${year}-${month}-${day}T00:00:00.000Z`;
    }
  }

  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch {
    // Ignorer
  }

  return new Date().toISOString();
}

/**
 * Normalise une date pour comparaison exacte (YYYY-MM-DD)
 */
export function normalizeDateForComparison(dateStr?: string | null): string {
  if (!dateStr) return '';
  const trimmed = dateStr.trim();
  
  // Format DD/MM/YYYY
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      return `${year}-${month}-${day}`;
    }
  }

  // Format ISO ou YYYY-MM-DD (extraction textuelle stricte pour éviter tout décalage UTC)
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
}

/**
 * Normalise une chaîne textuelle (minuscules, sans espaces superflus)
 */
export function normalizeText(str?: string | null): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Normalise un montant numérique pour comparaison stricte
 */
export function normalizeMontant(val: unknown): number {
  if (typeof val === 'number') {
    return isNaN(val) ? 0 : Math.round(val * 100) / 100;
  }
  if (!val) return 0;
  const cleanStr = String(val).replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleanStr);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

export interface TransactionComparisonKey {
  date: string;
  montant: number;
  libelle: string;
  noDossier: string;
  service: string;
}

/**
 * Génère la clé d'unicité standardisée pour une opération de caisse.
 * Format : `${date}|${montant}|${libelle}|${noDossier}|${service}`
 */
export function generateTransactionFingerprint(op: {
  date?: string | null;
  montant?: number | string | null;
  category?: string | null;
  libelle?: string | null;
  noDossier?: string | null;
  matricule?: string | null;
  service?: string | null;
}): string {
  const normDate = normalizeDateForComparison(op.date);
  let rawMontant = normalizeMontant(op.montant);

  // Si la catégorie est spécifiée comme 'sortie' et que le montant est positif, normaliser en négatif
  if (op.category === 'sortie' && rawMontant > 0) {
    rawMontant = -rawMontant;
  } else if (op.category === 'entree' && rawMontant < 0) {
    rawMontant = Math.abs(rawMontant);
  }

  const normLibelle = normalizeText(op.libelle);
  const normNoDossier = normalizeText(op.noDossier || op.matricule);
  const normService = normalizeText(op.service);

  return `${normDate}|${rawMontant}|${normLibelle}|${normNoDossier}|${normService}`;
}

/**
 * Normalise un numéro de pièce comptable pour comparaison stricte (majuscules, sans espaces).
 * Exemple : ' csh1 / 2026 / 00001 ' -> 'CSH1/2026/00001'
 */
export function normalizePieceComptable(piece?: string | null): string {
  if (!piece) return '';
  return piece
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Recherche si un numéro de pièce comptable est déjà utilisé dans une liste d'opérations existantes.
 * Ignore la ligne si candidate.id === item.id (cas d'une mise à jour de la même opération).
 */
export function findDuplicatePieceComptable<T extends {
  id?: string;
  pieceComptable?: string | null;
  piece_comptable?: string | null;
}>(
  candidate: {
    id?: string;
    pieceComptable?: string | null;
    piece_comptable?: string | null;
  },
  existingList: T[]
): T | undefined {
  const targetPiece = normalizePieceComptable(candidate.pieceComptable ?? candidate.piece_comptable);
  if (!targetPiece) {
    return undefined;
  }

  return existingList.find((item) => {
    if (candidate.id && item.id && candidate.id === item.id) {
      return false;
    }
    const itemPiece = normalizePieceComptable(item.pieceComptable ?? item.piece_comptable);
    return itemPiece === targetPiece;
  });
}

/**
 * Recherche si une opération donnée est un doublon d'une liste d'opérations existantes :
 * 1. En priorité absolue : unicité stricte du numéro de pièce comptable si renseigné.
 * 2. En second lieu : empreinte métier (Date + Montant + Libellé + N° de dossier/matricule + Service).
 * Retourne la transaction existante correspondante si trouvée, sinon undefined.
 */
export function findDuplicateTransaction<T extends {
  id?: string;
  date?: string | null;
  montant?: number | string | null;
  category?: string | null;
  libelle?: string | null;
  noDossier?: string | null;
  service?: string | null;
  pieceComptable?: string | null;
  piece_comptable?: string | null;
}>(
  candidate: {
    id?: string;
    date?: string | null;
    montant?: number | string | null;
    category?: string | null;
    libelle?: string | null;
    noDossier?: string | null;
    service?: string | null;
    pieceComptable?: string | null;
    piece_comptable?: string | null;
  },
  existingList: T[]
): T | undefined {
  // 1. Vérification stricte par numéro de pièce comptable
  const pieceDuplicate = findDuplicatePieceComptable(candidate, existingList);
  if (pieceDuplicate) {
    return pieceDuplicate;
  }

  // 2. Vérification par empreinte métier
  const candidateFingerprint = generateTransactionFingerprint(candidate);
  if (!candidateFingerprint || candidateFingerprint === '||||') {
    return undefined;
  }

  return existingList.find((item) => {
    // Si on modifie une ligne existante, on ignore sa propre comparaison par ID
    if (candidate.id && item.id && candidate.id === item.id) {
      return false;
    }
    return generateTransactionFingerprint(item) === candidateFingerprint;
  });
}

/**
 * Partitionne une liste de transactions en deux ensembles :
 * - `unique` : la première occurrence canonique de chaque transaction.
 * - `duplicates` : toutes les répliques en doublon (par ID, par pièce comptable ou par empreinte métier).
 *
 * Cette fonction garantit l'élimination absolue des doublons pour l'UI et prépare la liste des IDs à supprimer.
 */
export function deduplicateTransactionList<T extends {
  id?: string;
  date?: string | null;
  montant?: number | string | null;
  category?: string | null;
  libelle?: string | null;
  noDossier?: string | null;
  service?: string | null;
  pieceComptable?: string | null;
  piece_comptable?: string | null;
}>(list: T[]): { unique: T[]; duplicates: T[] } {
  const unique: T[] = [];
  const duplicates: T[] = [];

  const seenIds = new Set<string>();
  const seenPieces = new Set<string>();
  const seenFingerprints = new Set<string>();

  for (const item of list) {
    let isDup = false;

    // 1. Détection de doublon par ID
    if (item.id) {
      if (seenIds.has(item.id)) {
        isDup = true;
      }
    }

    // 2. Détection de doublon par numéro de pièce comptable
    if (!isDup) {
      const piece = normalizePieceComptable(item.pieceComptable ?? item.piece_comptable);
      if (piece) {
        if (seenPieces.has(piece)) {
          isDup = true;
        }
      }
    }

    // 3. Détection de doublon par empreinte métier
    if (!isDup) {
      const fingerprint = generateTransactionFingerprint(item);
      if (fingerprint && fingerprint !== '||||') {
        if (seenFingerprints.has(fingerprint)) {
          isDup = true;
        }
      }
    }

    if (isDup) {
      duplicates.push(item);
    } else {
      if (item.id) seenIds.add(item.id);
      const piece = normalizePieceComptable(item.pieceComptable ?? item.piece_comptable);
      if (piece) seenPieces.add(piece);
      const fingerprint = generateTransactionFingerprint(item);
      if (fingerprint && fingerprint !== '||||') seenFingerprints.add(fingerprint);

      unique.push(item);
    }
  }

  return { unique, duplicates };
}

/**
 * Extrait uniquement la liste des IDs des doublons dans une liste donnée (à supprimer en base).
 */
export function extractDuplicateIds<T extends {
  id?: string;
  date?: string | null;
  montant?: number | string | null;
  category?: string | null;
  libelle?: string | null;
  noDossier?: string | null;
  service?: string | null;
  pieceComptable?: string | null;
  piece_comptable?: string | null;
}>(list: T[]): string[] {
  const { duplicates } = deduplicateTransactionList(list);
  return duplicates
    .map((d) => d.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

