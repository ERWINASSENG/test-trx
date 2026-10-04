import express from 'express';
import { aggregateDossierExpenses, formatPersistedPieceComptable } from './cashier.utils';
import { getSupabaseAdmin } from './auth';

const DOSSIER_EXPENSE_PAGE_SIZE = 1000;
const MAX_DOSSIER_EXPENSE_ROWS = 100000;

export const getOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string } | undefined;
  const isComptable = authenticatedUser?.role === 'comptable';
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  try {
    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];
    // Nombre minimum de lignes par page : 80 strict (plafond de sécurité à 1000)
    let limit = rawLimit ? Number(rawLimit) : 80;
    if (isNaN(limit) || limit < 80) limit = 80;
    if (limit > 1000) limit = 1000;

    let offset = rawOffset ? Number(rawOffset) : 0;
    if (isNaN(offset) || offset < 0) offset = 0;

    const { data: nativeCashJournal } = await adminClient
      .from('journals')
      .select('id')
      .eq('sequence_prefix', 'CSH1')
      .maybeSingle();

    const { data, error, count } = await adminClient
      .from('cashier_transactions')
      .select('id, piece_comptable, date, libelle, service, type_description, category, status, no_dossier, dossier_id, first_name, partenaire, employee, employee_id, created_by, quantity, montant, solde_apres, selected, journal_id, created_at, updated_at', { count: 'exact' })
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Erreur SQL lors de la lecture des opérations:', error.message);
      res.status(500).json({ error: 'Erreur lors de la récupération des opérations de caisse.' });
      return;
    }

    const enrichedRows = (data || []).map((row) => {
      const enriched = formatPersistedPieceComptable(row);
      if (nativeCashJournal?.id && row.journal_id === nativeCashJournal.id) {
        enriched['journal_id'] = 'native-caisse-principal';
      }
      if (!isComptable) return enriched;

      const restrictedRow = { ...enriched };
      delete restrictedRow['solde_apres'];
      return restrictedRow;
    });
    res.json({
      operations: enrichedRows,
      transactions: enrichedRows,
      total: count ?? (data?.length || 0),
      limit,
      offset,
    });
  } catch (err: unknown) {
    console.error('Erreur getOperationsHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la récupération des opérations.' });
  }
};

export const getDossierExpenseSummaryHandler = async (
  _req: express.Request,
  res: express.Response
): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur.' });
    return;
  }

  try {
    const aggregates = new Map<string, { dossierId: string; expenseCount: number; totalExpenses: number }>();
    let offset = 0;
    let totalRows = 0;

    while (offset < MAX_DOSSIER_EXPENSE_ROWS) {
      const { data, error, count } = await adminClient
        .from('cashier_transactions')
        .select('dossier_id, status, category, montant', offset === 0 ? { count: 'exact' } : undefined)
        .eq('status', 'posted')
        .eq('category', 'sortie')
        .not('dossier_id', 'is', null)
        .order('id', { ascending: true })
        .range(offset, offset + DOSSIER_EXPENSE_PAGE_SIZE - 1);

      if (error) {
        console.error('[DOSSIERS] Erreur de lecture des dépenses:', error.message);
        res.status(500).json({ error: 'Impossible de calculer les dépenses par dossier.' });
        return;
      }

      const page = data || [];
      if (offset === 0) {
        totalRows = count ?? page.length;
        if (totalRows > MAX_DOSSIER_EXPENSE_ROWS) {
          res.status(413).json({ error: 'Le volume d’écritures dépasse la limite du rapport.' });
          return;
        }
      }

      for (const aggregate of aggregateDossierExpenses(page)) {
        const current = aggregates.get(aggregate.dossierId) || {
          dossierId: aggregate.dossierId,
          expenseCount: 0,
          totalExpenses: 0,
        };
        current.expenseCount += aggregate.expenseCount;
        current.totalExpenses += aggregate.totalExpenses;
        aggregates.set(aggregate.dossierId, current);
      }

      offset += page.length;
      if (page.length < DOSSIER_EXPENSE_PAGE_SIZE) break;
    }

    if (offset < totalRows) {
      res.status(413).json({ error: 'Le volume d’écritures dépasse la limite du rapport.' });
      return;
    }

    const sortedAggregates = [...aggregates.values()].sort((a, b) =>
      b.totalExpenses - a.totalExpenses || a.dossierId.localeCompare(b.dossierId)
    );
    const dossierRows = new Map<string, Record<string, unknown>>();
    const dossierIds = sortedAggregates.map((item) => item.dossierId);

    for (let index = 0; index < dossierIds.length; index += 100) {
      const { data, error } = await adminClient
        .from('dossiers')
        .select('id, no_dossier, prospect_id, client, statut, description, created_by, created_at, updated_at')
        .in('id', dossierIds.slice(index, index + 100));

      if (error) {
        console.error('[DOSSIERS] Erreur de lecture des fiches de dossier:', error.message);
        res.status(500).json({ error: 'Impossible de charger les dossiers du rapport.' });
        return;
      }
      for (const row of data || []) dossierRows.set(String(row.id), row as Record<string, unknown>);
    }

    const summaries = sortedAggregates.map((aggregate) => {
      const row = dossierRows.get(aggregate.dossierId);
      return {
        id: aggregate.dossierId,
        prospectId: typeof row?.['prospect_id'] === 'string' ? row['prospect_id'] : null,
        noDossier: typeof row?.['no_dossier'] === 'string' ? row['no_dossier'] : aggregate.dossierId,
        client: typeof row?.['client'] === 'string' ? row['client'] : null,
        statut: typeof row?.['statut'] === 'string' ? row['statut'] : 'inconnu',
        description: typeof row?.['description'] === 'string' ? row['description'] : null,
        createdBy: typeof row?.['created_by'] === 'string' ? row['created_by'] : null,
        createdAt: typeof row?.['created_at'] === 'string' ? row['created_at'] : '',
        updatedAt: typeof row?.['updated_at'] === 'string' ? row['updated_at'] : '',
        expenseCount: aggregate.expenseCount,
        totalExpenses: aggregate.totalExpenses,
      };
    });

    res.json({ summaries, total: summaries.length });
  } catch (error: unknown) {
    console.error('[DOSSIERS] Erreur inattendue lors du calcul des dépenses:', error);
    res.status(500).json({ error: 'Impossible de calculer les dépenses par dossier.' });
  }
};
