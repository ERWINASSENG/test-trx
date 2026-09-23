import express from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { formatPersistedPieceComptable, normalizeDateToDay } from './cashier.utils';
import { getSupabaseAdmin } from './auth';

let datesMigrationPromise: Promise<void> | null = null;

async function ensureCashierDatesMigrated(adminClient: SupabaseClient): Promise<void> {
  if (!datesMigrationPromise) {
    datesMigrationPromise = (async () => {
      try {
        const { data: slashRows, error } = await adminClient
          .from('cashier_transactions')
          .select('id, date')
          .like('date', '%/%')
          .limit(2000);

        if (error || !slashRows || slashRows.length === 0) return;

        console.log(`[MIGRATION DATES] Détection de ${slashRows.length} opération(s) au format DD/MM/YYYY. Normalisation en cours vers YYYY-MM-DD...`);
        for (const row of slashRows) {
          const normalized = normalizeDateToDay(row.date);
          if (normalized && normalized !== row.date) {
            await adminClient.from('cashier_transactions').update({ date: normalized }).eq('id', row.id);
          }
        }
        console.log(`[MIGRATION DATES] Migration terminée avec succès : ${slashRows.length} opération(s) converties en ISO YYYY-MM-DD.`);
      } catch (migrationError) {
        console.warn('[MIGRATION DATES] Erreur lors de la normalisation des dates en ISO:', migrationError);
      }
    })();
  }
  return datesMigrationPromise;
}

export const getOperationsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string } | undefined;
  const isComptable = authenticatedUser?.role === 'comptable';
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  try {
    await ensureCashierDatesMigrated(adminClient);

    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];
    // Nombre minimum de lignes par page : 80 strict (plafond de sécurité à 1000)
    let limit = rawLimit ? Number(rawLimit) : 80;
    if (isNaN(limit) || limit < 80) limit = 80;
    if (limit > 1000) limit = 1000;

    let offset = rawOffset ? Number(rawOffset) : 0;
    if (isNaN(offset) || offset < 0) offset = 0;

    const { data, error, count } = await adminClient
      .from('cashier_transactions')
      .select('id, piece_comptable, date, libelle, service, type_description, category, status, no_dossier, dossier_id, first_name, partenaire, employee, employee_id, created_by, quantity, montant, solde_apres, selected, created_at, updated_at', { count: 'exact' })
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Erreur SQL lors de la lecture des opérations:', error.message);
      res.status(500).json({ error: 'Erreur lors de la récupération des opérations de caisse.' });
      return;
    }

    const enrichedRows = (data || []).map((row: Record<string, unknown>) => {
      const enriched = formatPersistedPieceComptable(row);
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
