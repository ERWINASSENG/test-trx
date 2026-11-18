import express from 'express';
import { aggregateDossierExpenses, formatPersistedPieceComptable, normalizeDateToDay } from './cashier.utils';
import { getSupabaseAdmin } from './auth';
import { writeAuditLog } from './audit-log';
import { hasPermission } from './access-control';

const DOSSIER_EXPENSE_PAGE_SIZE = 1000;
const MAX_DOSSIER_EXPENSE_ROWS = 20000;
const REPORT_BALANCE_PAGE_SIZE = 1000;
const MAX_REPORT_HISTORY_ROWS = 50000;
const DOSSIER_SUMMARY_CACHE_TTL_MS = 30_000;
const NATIVE_JOURNAL_CACHE_TTL_MS = 300_000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

let cachedNativeCashJournal: { id: string; cachedAt: number } | null = null;

let cachedExpenseSummary: {
  summaries: Record<string, unknown>[];
  total: number;
  cachedAt: number;
} | null = null;

export const clearDossierExpenseSummaryCache = (): void => {
  cachedExpenseSummary = null;
};

const isValidCalendarIsoDate = (isoDate: string): boolean => {
  if (!ISO_DATE_REGEX.test(isoDate)) return false;
  const [year, month, day] = isoDate.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
};

const formatIsoToFrDisplay = (isoDate: string): string => {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
};

const resolveNativeCashJournalId = async (
  adminClient: NonNullable<ReturnType<typeof getSupabaseAdmin>>
): Promise<string | null> => {
  const now = Date.now();
  if (cachedNativeCashJournal && now - cachedNativeCashJournal.cachedAt < NATIVE_JOURNAL_CACHE_TTL_MS) {
    return cachedNativeCashJournal.id;
  }

  const { data: nativeCashJournal } = await adminClient
    .from('journals')
    .select('id')
    .eq('sequence_prefix', 'CSH1')
    .maybeSingle();

  if (nativeCashJournal?.id) {
    cachedNativeCashJournal = { id: nativeCashJournal.id, cachedAt: now };
    return nativeCashJournal.id;
  }
  return null;
};

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

    const nativeCashJournalId = await resolveNativeCashJournalId(adminClient);

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
      if (nativeCashJournalId && row.journal_id === nativeCashJournalId) {
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

export const getDailyCashierReportHandler = async (
  req: express.Request,
  res: express.Response
): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur.' });
    return;
  }

  try {
    const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as
      | { id?: string; email?: string; role?: string }
      | undefined;
    const callerId = authenticatedUser?.id || null;

    const rawDate = typeof req.query['date'] === 'string' ? req.query['date'].trim() : '';
    const normalizedDate = normalizeDateToDay(rawDate);
    if (!normalizedDate || !isValidCalendarIsoDate(normalizedDate)) {
      res.status(400).json({
        error: 'Date du rapport invalide. Veuillez fournir une date valide au format AAAA-MM-JJ.',
      });
      return;
    }

    const rawJournalId =
      typeof req.query['journalId'] === 'string'
        ? req.query['journalId'].trim()
        : typeof req.query['journal_id'] === 'string'
        ? req.query['journal_id'].trim()
        : '';

    const nativeCashJournalId = await resolveNativeCashJournalId(adminClient);
    const isNativeRequest =
      !rawJournalId ||
      rawJournalId === 'native-caisse-principal' ||
      rawJournalId === 'CSH1' ||
      (nativeCashJournalId !== null && rawJournalId === nativeCashJournalId);

    let targetJournalId = 'native-caisse-principal';
    let targetJournalName = 'Caisse Principale';
    let targetJournalPrefix = 'CSH1';

    if (!isNativeRequest) {
      if (!UUID_REGEX.test(rawJournalId)) {
        res.status(400).json({ error: 'Identifiant de journal invalide.' });
        return;
      }

      if (!callerId || !(await hasPermission(callerId, 'journal_entries.read', undefined))) {
        res.status(403).json({ error: 'Permission insuffisante pour consulter ce journal.' });
        return;
      }

      const { data: customJournal, error: journalErr } = await adminClient
        .from('journals')
        .select('id, name, sequence_prefix')
        .eq('id', rawJournalId)
        .maybeSingle();

      if (journalErr) {
        console.error('[DAILY_REPORT] Erreur lecture journal:', journalErr.message);
        res.status(500).json({ error: 'Impossible de vérifier le journal demandé.' });
        return;
      }
      if (!customJournal) {
        res.status(404).json({ error: 'Journal introuvable.' });
        return;
      }

      targetJournalId = String(customJournal.id);
      targetJournalName = String(customJournal.name || 'Journal');
      targetJournalPrefix = String(customJournal.sequence_prefix || 'JRNL');
    }

    // 1. Calcul exact du REPORT SOLDE sur tout l'historique comptabilisé antérieur (date < normalizedDate)
    let reportSolde = 0;

    if (isNativeRequest) {
      const buildPriorNativeQuery = () => {
        let query = adminClient
          .from('cashier_transactions')
          .select('montant', { count: 'exact' })
          .eq('status', 'posted')
          .lt('date', normalizedDate);

        if (nativeCashJournalId) {
          query = query.or(`journal_id.is.null,journal_id.eq.${nativeCashJournalId}`);
        } else {
          query = query.is('journal_id', null);
        }
        return query.order('id', { ascending: true });
      };

      const { data: firstPriorPage, error: priorErr, count: priorCount } = await buildPriorNativeQuery().range(
        0,
        REPORT_BALANCE_PAGE_SIZE - 1
      );

      if (priorErr) {
        console.error('[DAILY_REPORT] Erreur calcul report de solde caisse:', priorErr.message);
        res.status(500).json({ error: 'Impossible de calculer le report de solde.' });
        return;
      }

      const priorPages: { montant: unknown }[][] = [firstPriorPage || []];
      const totalPriorRows = Math.min(priorCount ?? (firstPriorPage?.length || 0), MAX_REPORT_HISTORY_ROWS);

      if (totalPriorRows > REPORT_BALANCE_PAGE_SIZE) {
        const pagePromises = [];
        for (let offset = REPORT_BALANCE_PAGE_SIZE; offset < totalPriorRows; offset += REPORT_BALANCE_PAGE_SIZE) {
          pagePromises.push(
            buildPriorNativeQuery().range(offset, offset + REPORT_BALANCE_PAGE_SIZE - 1)
          );
        }
        const results = await Promise.all(pagePromises);
        for (const pageResult of results) {
          if (pageResult.error) {
            console.error('[DAILY_REPORT] Erreur pagination report de solde:', pageResult.error.message);
            res.status(500).json({ error: 'Impossible de calculer le report de solde.' });
            return;
          }
          if (pageResult.data) {
            priorPages.push(pageResult.data);
          }
        }
      }

      for (const page of priorPages) {
        for (const row of page) {
          const val = Number(row.montant);
          if (Number.isFinite(val)) {
            reportSolde += val;
          }
        }
      }
    } else {
      const buildPriorCustomQuery = () =>
        adminClient
          .from('journal_entries')
          .select('montant', { count: 'exact' })
          .eq('journal_id', targetJournalId)
          .eq('status', 'posted')
          .lt('date', normalizedDate)
          .order('id', { ascending: true });

      const { data: firstPriorPage, error: priorErr, count: priorCount } = await buildPriorCustomQuery().range(
        0,
        REPORT_BALANCE_PAGE_SIZE - 1
      );

      if (priorErr) {
        console.error('[DAILY_REPORT] Erreur calcul report de solde journal:', priorErr.message);
        res.status(500).json({ error: 'Impossible de calculer le report de solde du journal.' });
        return;
      }

      const priorPages: { montant: unknown }[][] = [firstPriorPage || []];
      const totalPriorRows = Math.min(priorCount ?? (firstPriorPage?.length || 0), MAX_REPORT_HISTORY_ROWS);

      if (totalPriorRows > REPORT_BALANCE_PAGE_SIZE) {
        const pagePromises = [];
        for (let offset = REPORT_BALANCE_PAGE_SIZE; offset < totalPriorRows; offset += REPORT_BALANCE_PAGE_SIZE) {
          pagePromises.push(
            buildPriorCustomQuery().range(offset, offset + REPORT_BALANCE_PAGE_SIZE - 1)
          );
        }
        const results = await Promise.all(pagePromises);
        for (const pageResult of results) {
          if (pageResult.error) {
            console.error('[DAILY_REPORT] Erreur pagination report de solde journal:', pageResult.error.message);
            res.status(500).json({ error: 'Impossible de calculer le report de solde du journal.' });
            return;
          }
          if (pageResult.data) {
            priorPages.push(pageResult.data);
          }
        }
      }

      for (const page of priorPages) {
        for (const row of page) {
          const val = Number(row.montant);
          if (Number.isFinite(val)) {
            reportSolde += val;
          }
        }
      }
    }

    // 2. Lecture des opérations comptabilisées du jour (date = normalizedDate) avec sélection explicite de colonnes
    let dayRows: Record<string, unknown>[] = [];

    if (isNativeRequest) {
      let dayQuery = adminClient
        .from('cashier_transactions')
        .select('id, date, piece_comptable, libelle, service, type_description, category, status, no_dossier, partenaire, employee, montant, created_at')
        .eq('status', 'posted')
        .eq('date', normalizedDate);

      if (nativeCashJournalId) {
        dayQuery = dayQuery.or(`journal_id.is.null,journal_id.eq.${nativeCashJournalId}`);
      } else {
        dayQuery = dayQuery.is('journal_id', null);
      }

      const { data, error: dayErr } = await dayQuery
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(0, REPORT_BALANCE_PAGE_SIZE - 1);

      if (dayErr) {
        console.error('[DAILY_REPORT] Erreur lecture opérations du jour:', dayErr.message);
        res.status(500).json({ error: 'Impossible de charger les opérations du jour.' });
        return;
      }
      dayRows = (data || []) as Record<string, unknown>[];
    } else {
      const { data, error: dayErr } = await adminClient
        .from('journal_entries')
        .select('id, date, piece_comptable, libelle, service, type_description, category, status, no_dossier, partenaire, employee, montant, created_at')
        .eq('journal_id', targetJournalId)
        .eq('status', 'posted')
        .eq('date', normalizedDate)
        .order('sequence_number', { ascending: true })
        .order('created_at', { ascending: true })
        .range(0, REPORT_BALANCE_PAGE_SIZE - 1);

      if (dayErr) {
        console.error('[DAILY_REPORT] Erreur lecture écritures du jour:', dayErr.message);
        res.status(500).json({ error: 'Impossible de charger les écritures du jour.' });
        return;
      }
      dayRows = (data || []) as Record<string, unknown>[];
    }

    const displayDate = formatIsoToFrDisplay(normalizedDate);

    interface FormattedReportItem {
      id: string;
      date: string;
      libelle: string;
      noDossier: string | null;
      pieceComptable: string | null;
      partenaire: string | null;
      service: string | null;
      montant: number;
      category: 'entree' | 'sortie';
    }

    const recettes: FormattedReportItem[] = [];
    const depenses: FormattedReportItem[] = [];

    for (const rawRow of dayRows) {
      const formattedRow = formatPersistedPieceComptable(rawRow);
      const signedMontant = Number(formattedRow['montant']) || 0;
      if (signedMontant === 0) continue;

      const isSortie = formattedRow['category'] === 'sortie' || signedMontant < 0;
      const absMontant = Math.abs(signedMontant);
      const rawLibelle = typeof formattedRow['libelle'] === 'string' ? formattedRow['libelle'].trim() : '';
      const rawNoDossier =
        typeof formattedRow['no_dossier'] === 'string' && formattedRow['no_dossier'].trim()
          ? formattedRow['no_dossier'].trim()
          : null;
      const rawPartenaire =
        typeof formattedRow['partenaire'] === 'string' && formattedRow['partenaire'].trim()
          ? formattedRow['partenaire'].trim()
          : typeof formattedRow['employee'] === 'string' && formattedRow['employee'].trim()
          ? formattedRow['employee'].trim()
          : null;
      const rawPiece =
        typeof formattedRow['piece_comptable'] === 'string' && formattedRow['piece_comptable'].trim()
          ? formattedRow['piece_comptable'].trim()
          : null;
      const rawService =
        typeof formattedRow['service'] === 'string' && formattedRow['service'].trim()
          ? formattedRow['service'].trim()
          : null;

      const item: FormattedReportItem = {
        id: String(formattedRow['id'] || ''),
        date: displayDate,
        libelle: rawLibelle,
        noDossier: rawNoDossier,
        pieceComptable: rawPiece,
        partenaire: rawPartenaire,
        service: rawService,
        montant: absMontant,
        category: isSortie ? 'sortie' : 'entree',
      };

      if (isSortie) {
        depenses.push(item);
      } else {
        recettes.push(item);
      }
    }

    const totalRecettes = recettes.reduce((acc, item) => acc + item.montant, 0);
    const totalApresRecettes = reportSolde + totalRecettes;
    const totalDepenses = depenses.reduce((acc, item) => acc + item.montant, 0);
    const soldeFinal = totalApresRecettes - totalDepenses;

    await writeAuditLog(adminClient, {
      userId: callerId,
      userEmail: authenticatedUser?.email,
      userRole: authenticatedUser?.role,
      action: 'EXPORT_DAILY_CASHIER_REPORT',
      entityId: targetJournalId,
      details: {
        date: normalizedDate,
        journal_id: targetJournalId,
        recettes_count: recettes.length,
        depenses_count: depenses.length,
      },
      ipAddress: req.ip || null,
    });

    const headerTitle = isNativeRequest
      ? `CAISSE TRX du ${displayDate}`
      : `${targetJournalName.toUpperCase()} du ${displayDate}`;

    res.json({
      report: {
        date: normalizedDate,
        displayDate,
        title: headerTitle,
        journalId: targetJournalId,
        journalName: targetJournalName,
        journalPrefix: targetJournalPrefix,
        reportSolde,
        recettes,
        totalRecettes,
        totalApresRecettes,
        depenses,
        totalDepenses,
        soldeFinal,
      },
    });
  } catch (err: unknown) {
    console.error('[DAILY_REPORT] Erreur inattendue getDailyCashierReportHandler:', err);
    res.status(500).json({ error: 'Erreur interne lors de la génération du rapport journalier de caisse.' });
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

  const now = Date.now();
  if (cachedExpenseSummary && now - cachedExpenseSummary.cachedAt < DOSSIER_SUMMARY_CACHE_TTL_MS) {
    res.json({ summaries: cachedExpenseSummary.summaries, total: cachedExpenseSummary.total });
    return;
  }

  try {
    const aggregates = new Map<string, { dossierId: string; expenseCount: number; totalExpenses: number }>();

    // Lecture de la première page avec comptage total
    const { data: firstPage, error: firstErr, count } = await adminClient
      .from('cashier_transactions')
      .select('dossier_id, status, category, montant', { count: 'exact' })
      .eq('status', 'posted')
      .eq('category', 'sortie')
      .not('dossier_id', 'is', null)
      .order('id', { ascending: true })
      .range(0, DOSSIER_EXPENSE_PAGE_SIZE - 1);

    if (firstErr) {
      console.error('[DOSSIERS] Erreur de lecture des dépenses:', firstErr.message);
      res.status(500).json({ error: 'Impossible de calculer les dépenses par dossier.' });
      return;
    }

    const allPages: typeof firstPage[] = [firstPage || []];
    const totalRows = Math.min(count ?? (firstPage?.length || 0), MAX_DOSSIER_EXPENSE_ROWS);

    // Si des pages supplémentaires existent, les charger en parallèle (Promise.all)
    if (totalRows > DOSSIER_EXPENSE_PAGE_SIZE) {
      const pagePromises = [];
      for (let offset = DOSSIER_EXPENSE_PAGE_SIZE; offset < totalRows; offset += DOSSIER_EXPENSE_PAGE_SIZE) {
        pagePromises.push(
          adminClient
            .from('cashier_transactions')
            .select('dossier_id, status, category, montant')
            .eq('status', 'posted')
            .eq('category', 'sortie')
            .not('dossier_id', 'is', null)
            .order('id', { ascending: true })
            .range(offset, offset + DOSSIER_EXPENSE_PAGE_SIZE - 1)
        );
      }
      const results = await Promise.all(pagePromises);
      for (const res of results) {
        if (!res.error && res.data) {
          allPages.push(res.data);
        }
      }
    }

    for (const page of allPages) {
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
    }

    const sortedAggregates = [...aggregates.values()].sort((a, b) =>
      b.totalExpenses - a.totalExpenses || a.dossierId.localeCompare(b.dossierId)
    );
    const dossierRows = new Map<string, Record<string, unknown>>();
    const dossierIds = sortedAggregates.map((item) => item.dossierId);

    // Chargement parallèle des détails de dossiers par tranches de 100
    if (dossierIds.length > 0) {
      const dossierBatchPromises = [];
      for (let index = 0; index < dossierIds.length; index += 100) {
        dossierBatchPromises.push(
          adminClient
            .from('dossiers')
            .select('id, no_dossier, prospect_id, client, statut, description, created_by, created_at, updated_at')
            .in('id', dossierIds.slice(index, index + 100))
        );
      }
      const batchResults = await Promise.all(dossierBatchPromises);
      for (const batch of batchResults) {
        if (batch.error) {
          console.error('[DOSSIERS] Erreur de lecture des fiches de dossier:', batch.error.message);
          res.status(500).json({ error: 'Impossible de charger les dossiers du rapport.' });
          return;
        }
        for (const row of batch.data || []) {
          dossierRows.set(String(row.id), row as Record<string, unknown>);
        }
      }
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

    cachedExpenseSummary = {
      summaries,
      total: summaries.length,
      cachedAt: Date.now(),
    };

    res.json({ summaries, total: summaries.length });
  } catch (error: unknown) {
    console.error('[DOSSIERS] Erreur inattendue lors du calcul des dépenses:', error);
    res.status(500).json({ error: 'Impossible de calculer les dépenses par dossier.' });
  }
};

