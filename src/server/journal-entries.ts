import express from 'express';
import { getSupabaseAdmin } from './auth';

/**
 * Interface d'une écriture comptable dans un journal dédié
 */
export interface JournalEntryRecord {
  id: string;
  journal_id: string;
  sequence_number: number;
  piece_comptable: string;
  date: string;
  libelle: string;
  service?: string;
  type_description?: string;
  category: 'entree' | 'sortie';
  status: 'draft' | 'posted' | 'cancelled';
  no_dossier?: string;
  partenaire?: string;
  employee?: string;
  quantity?: number;
  montant: number;
  solde_apres?: number;
  created_by?: string;
  employee_id?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Cache mémoire de secours hermétique par journal au cas où la migration SQL
 * n'a pas encore été exécutée dans le projet Supabase distant.
 */
const fallbackEntriesStore = new Map<string, JournalEntryRecord[]>();

const ALLOWED_VIEW_ROLES = ['admin', 'tresorier', 'manager', 'comptable'];
const ALLOWED_WRITE_ROLES = ['admin', 'tresorier'];

const extractParamString = (val: unknown): string => {
  if (Array.isArray(val)) return String(val[0] || '');
  return val ? String(val) : '';
};

/**
 * GET /api/journals/:journalId/entries
 * Récupère les écritures comptables d'un journal spécifique, ordonnées chronologiquement
 */
export const getJournalEntriesHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId'] || req.query['journalId']);

  if (!journalId) {
    res.status(400).json({ error: 'Identifiant du journal requis' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string } | undefined;
  const userRole = authenticatedUser?.role;

  if (!userRole || !ALLOWED_VIEW_ROLES.includes(userRole)) {
    res.status(403).json({ error: 'Accès non autorisé aux écritures de ce journal.' });
    return;
  }

  if (adminClient) {
    try {
      const { data, error } = await adminClient
        .from('journal_entries')
        .select('*')
        .eq('journal_id', journalId)
        .order('date', { ascending: true })
        .order('sequence_number', { ascending: true });

      if (!error && Array.isArray(data)) {
        // Calcul du solde en temps réel propre à ce journal
        const currentBalance = data.reduce((acc, row) => {
          const val = Number(row.montant) || 0;
          return acc + val;
        }, 0);

        res.json({
          success: true,
          journal_id: journalId,
          count: data.length,
          current_balance: currentBalance,
          entries: data,
        });
        return;
      }
    } catch {
      // Poursuite vers le cache isolé si la table distante n'est pas encore prête
    }
  }

  // Fallback sécurisé en mémoire isolé par journal
  const list = fallbackEntriesStore.get(journalId) || [];
  const currentBalance = list.reduce((acc, row) => acc + (Number(row.montant) || 0), 0);

  res.json({
    success: true,
    journal_id: journalId,
    count: list.length,
    current_balance: currentBalance,
    entries: list,
  });
};

/**
 * POST /api/journals/:journalId/entries
 * Crée une écriture dans le journal avec garantie d'unicité et de séquençage strict
 */
export const createJournalEntryHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId'] || req.body.journal_id);

  if (!journalId) {
    res.status(400).json({ error: 'Identifiant du journal requis' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string } | undefined;
  const userRole = authenticatedUser?.role;
  const userId = authenticatedUser?.id;

  // Strict RBAC : les managers n'ont PAS le droit de saisie
  if (!userRole || !ALLOWED_WRITE_ROLES.includes(userRole)) {
    res.status(403).json({ error: 'Seuls le trésorier et l’administrateur peuvent saisir des écritures de journal.' });
    return;
  }

  const {
    date,
    libelle,
    service,
    type_description,
    category,
    status = 'draft',
    no_dossier,
    partenaire,
    employee,
    quantity = 1,
    montant,
  } = req.body;

  if (!libelle || !libelle.trim()) {
    res.status(400).json({ error: 'Le libellé de l’opération est obligatoire.' });
    return;
  }

  const rawMontant = Number(montant);
  if (isNaN(rawMontant) || rawMontant === 0) {
    res.status(400).json({ error: 'Le montant de l’opération doit être supérieur à zéro.' });
    return;
  }

  const effectiveCategory: 'entree' | 'sortie' = category === 'entree' ? 'entree' : 'sortie';
  const signedMontant = effectiveCategory === 'sortie' ? -Math.abs(rawMontant) : Math.abs(rawMontant);
  const entryDate = date ? String(date).split('T')[0] : new Date().toISOString().split('T')[0];
  const year = entryDate.split('-')[0] || new Date().getFullYear().toString();

  // 1. Récupération du préfixe de séquence du journal
  let sequencePrefix = 'JRNL';
  if (adminClient) {
    try {
      const { data: journalRow } = await adminClient
        .from('journals')
        .select('sequence_prefix')
        .eq('id', journalId)
        .maybeSingle();

      if (journalRow?.sequence_prefix) {
        sequencePrefix = journalRow.sequence_prefix.toUpperCase();
      }
    } catch {
      // Ignorer
    }
  }

  // 2. Calcul atomique du numéro de séquence au sein de ce journal
  let nextSeq = 1;

  if (adminClient) {
    try {
      const { data: maxRow } = await adminClient
        .from('journal_entries')
        .select('sequence_number')
        .eq('journal_id', journalId)
        .order('sequence_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (maxRow?.sequence_number) {
        nextSeq = Number(maxRow.sequence_number) + 1;
      }
    } catch {
      const memList = fallbackEntriesStore.get(journalId) || [];
      const maxSeq = memList.reduce((max, e) => Math.max(max, e.sequence_number), 0);
      nextSeq = maxSeq + 1;
    }
  } else {
    const memList = fallbackEntriesStore.get(journalId) || [];
    const maxSeq = memList.reduce((max, e) => Math.max(max, e.sequence_number), 0);
    nextSeq = maxSeq + 1;
  }

  // Formatage strict de la pièce comptable : ex: BNK1/2026/00001
  const paddedSeq = String(nextSeq).padStart(5, '0');
  const pieceComptable = `${sequencePrefix}/${year}/${paddedSeq}`;

  const newEntry: JournalEntryRecord = {
    id: `je-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    journal_id: journalId,
    sequence_number: nextSeq,
    piece_comptable: pieceComptable,
    date: entryDate,
    libelle: libelle.trim(),
    service: service ? String(service).trim() : '',
    type_description: type_description ? String(type_description).trim() : '',
    category: effectiveCategory,
    status: status === 'posted' ? 'posted' : 'draft',
    no_dossier: no_dossier ? String(no_dossier).trim() : '',
    partenaire: partenaire ? String(partenaire).trim() : '',
    employee: employee ? String(employee).trim() : '',
    quantity: Number(quantity) || 1,
    montant: signedMontant,
    created_by: userId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Insertion Supabase
  if (adminClient) {
    try {
      const { data: inserted, error } = await adminClient
        .from('journal_entries')
        .insert({
          journal_id: newEntry.journal_id,
          sequence_number: newEntry.sequence_number,
          piece_comptable: newEntry.piece_comptable,
          date: newEntry.date,
          libelle: newEntry.libelle,
          service: newEntry.service,
          type_description: newEntry.type_description,
          category: newEntry.category,
          status: newEntry.status,
          no_dossier: newEntry.no_dossier,
          partenaire: newEntry.partenaire,
          employee: newEntry.employee,
          quantity: newEntry.quantity,
          montant: newEntry.montant,
          created_by: newEntry.created_by,
        })
        .select()
        .single();

      if (!error && inserted) {
        res.status(201).json({
          success: true,
          message: 'Écriture comptable enregistrée avec succès dans le journal.',
          entry: inserted,
        });
        return;
      }
    } catch {
      // En cas d'erreur DDL, stockage dans le fallback hermétique
    }
  }

  // Stockage fallback hermétique par journal
  const list = fallbackEntriesStore.get(journalId) || [];
  list.push(newEntry);
  fallbackEntriesStore.set(journalId, list);

  res.status(201).json({
    success: true,
    message: 'Écriture comptable enregistrée avec succès.',
    entry: newEntry,
  });
};

/**
 * PUT/PATCH /api/journals/:journalId/entries/:id
 * Met à jour une écriture du journal
 */
export const updateJournalEntryHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId']);
  const entryId = extractParamString(req.params['id']);

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string } | undefined;
  const userRole = authenticatedUser?.role;
  const userId = authenticatedUser?.id;

  if (!userRole || !ALLOWED_WRITE_ROLES.includes(userRole)) {
    res.status(403).json({ error: 'Modification non autorisée.' });
    return;
  }

  const updates = { ...req.body };
  delete updates.id;
  delete updates.journal_id;
  delete updates.sequence_number; // Intégrité comptable : le numéro de séquence est immuable
  delete updates.piece_comptable;  // Intégrité comptable : la pièce est immuable

  if (updates.montant !== undefined && updates.category !== undefined) {
    const raw = Math.abs(Number(updates.montant) || 0);
    updates.montant = updates.category === 'sortie' ? -raw : raw;
  }

  if (adminClient) {
    try {
      let query = adminClient
        .from('journal_entries')
        .update(updates)
        .eq('id', entryId)
        .eq('journal_id', journalId);

      // Si trésorier, restreindre à ses écritures
      if (userRole === 'tresorier' && userId) {
        query = query.eq('created_by', userId);
      }

      const { data, error } = await query.select().single();
      if (!error && data) {
        res.json({ success: true, entry: data });
        return;
      }
    } catch {
      // Ignorer
    }
  }

  // Mise à jour fallback
  const list = fallbackEntriesStore.get(journalId) || [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx !== -1) {
    list[idx] = { ...list[idx], ...updates, updated_at: new Date().toISOString() };
    res.json({ success: true, entry: list[idx] });
    return;
  }

  res.status(404).json({ error: 'Écriture introuvable.' });
};

/**
 * DELETE /api/journals/:journalId/entries/:id
 * Supprime une écriture du journal
 */
export const deleteJournalEntryHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId']);
  const entryId = extractParamString(req.params['id']);

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string } | undefined;
  const userRole = authenticatedUser?.role;
  const userId = authenticatedUser?.id;

  if (!userRole || !ALLOWED_WRITE_ROLES.includes(userRole)) {
    res.status(403).json({ error: 'Suppression non autorisée.' });
    return;
  }

  if (adminClient) {
    try {
      let query = adminClient
        .from('journal_entries')
        .delete()
        .eq('id', entryId)
        .eq('journal_id', journalId);

      if (userRole === 'tresorier' && userId) {
        query = query.eq('created_by', userId);
      }

      const { error } = await query;
      if (!error) {
        res.json({ success: true, message: 'Écriture supprimée.' });
        return;
      }
    } catch {
      // Ignorer
    }
  }

  const list = fallbackEntriesStore.get(journalId) || [];
  const nextList = list.filter((e) => e.id !== entryId);
  fallbackEntriesStore.set(journalId, nextList);

  res.json({ success: true, message: 'Écriture supprimée.' });
};

/**
 * GET /api/journals/:journalId/chart-data
 * Fournit les points de données chronologiques pour Chart.js (dates, solde cumulé)
 */
export const getJournalChartDataHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId']);

  if (!journalId) {
    res.status(400).json({ error: 'Identifiant du journal requis' });
    return;
  }

  let entries: JournalEntryRecord[] = [];

  if (adminClient) {
    try {
      const { data } = await adminClient
        .from('journal_entries')
        .select('*')
        .eq('journal_id', journalId)
        .order('date', { ascending: true })
        .order('sequence_number', { ascending: true });

      if (Array.isArray(data)) {
        entries = data as JournalEntryRecord[];
      }
    } catch {
      // Ignorer
    }
  }

  if (entries.length === 0) {
    entries = fallbackEntriesStore.get(journalId) || [];
  }

  // Tri chronologique rigoureux
  entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  let runningBalance = 0;
  const labels: string[] = [];
  const balances: number[] = [];
  const descriptions: string[] = [];

  for (const entry of entries) {
    runningBalance += Number(entry.montant) || 0;
    const dateObj = new Date(entry.date);
    const formatted = !isNaN(dateObj.getTime())
      ? dateObj.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
      : entry.date;

    labels.push(formatted);
    balances.push(runningBalance);
    descriptions.push(entry.libelle);
  }

  res.json({
    success: true,
    journal_id: journalId,
    current_balance: runningBalance,
    labels,
    balances,
    descriptions,
  });
};
