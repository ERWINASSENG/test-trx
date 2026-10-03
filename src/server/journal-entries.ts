import express from 'express';
import { getSupabaseAdmin } from './auth';
import { writeAuditLog } from './audit-log';

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

  if (!adminClient) {
    res.status(503).json({
      error: 'Service de base de données temporairement indisponible. Veuillez vérifier la configuration serveur.',
    });
    return;
  }

  try {
    const rawLimit = Number(req.query['limit']);
    const rawOffset = Number(req.query['offset']);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 500 ? rawLimit : 100;
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const { data, count, error } = await adminClient
      .from('journal_entries')
      .select(
        'id, journal_id, sequence_number, piece_comptable, date, libelle, service, type_description, category, status, no_dossier, partenaire, employee, quantity, montant, solde_apres, created_by, employee_id, created_at, updated_at',
        { count: 'exact' }
      )
      .eq('journal_id', journalId)
      .order('date', { ascending: true })
      .order('sequence_number', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error(`[JOURNAL_ENTRIES] Erreur lecture des écritures du journal ${journalId}:`, error.message);
      res.status(500).json({ error: 'Erreur lors de la récupération des écritures du journal.' });
      return;
    }

    let soldeGlobal = 0;
    try {
      const { data: summary, error: sumErr } = await adminClient.rpc('get_journal_summary', { p_journal_id: journalId });
      if (!sumErr && summary && summary.solde_global !== undefined) {
        soldeGlobal = Number(summary.solde_global);
      } else {
        const { data: sumRows } = await adminClient
          .from('journal_entries')
          .select('montant')
          .eq('journal_id', journalId)
          .eq('status', 'posted');
        soldeGlobal = (sumRows || []).reduce((acc, row) => acc + (Number(row.montant) || 0), 0);
      }
    } catch {
      const { data: sumRows } = await adminClient
        .from('journal_entries')
        .select('montant')
        .eq('journal_id', journalId)
        .eq('status', 'posted');
      soldeGlobal = (sumRows || []).reduce((acc, row) => acc + (Number(row.montant) || 0), 0);
    }

    const entries = (data || []) as JournalEntryRecord[];

    res.json({
      success: true,
      journal_id: journalId,
      total_count: count ?? entries.length,
      limit,
      offset,
      count: entries.length,
      current_balance: soldeGlobal,
      entries,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[JOURNAL_ENTRIES] Exception lecture des écritures:`, message);
    res.status(500).json({ error: 'Erreur interne lors de la consultation du journal.' });
  }
};

/**
 * POST /api/journals/:journalId/entries
 * Crée une écriture dans le journal avec garantie d'unicité, persistance stricte et traçabilité d'audit.
 */
export const createJournalEntryHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId'] || req.body.journal_id);

  if (!journalId) {
    res.status(400).json({ error: 'Identifiant du journal requis' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string; email?: string } | undefined;
  const userRole = authenticatedUser?.role;
  const userId = authenticatedUser?.id;
  const userEmail = authenticatedUser?.email;

  if (!adminClient) {
    res.status(503).json({
      error: 'Persistance impossible : le service Supabase n’est pas initialisé sur le serveur.',
    });
    return;
  }

  const {
    date,
    libelle,
    service,
    type_description,
    typeDescription,
    category,
    status = 'draft',
    no_dossier,
    noDossier,
    partenaire,
    employee,
    quantity = 1,
    montant,
  } = req.body;

  if (!libelle || typeof libelle !== 'string' || !libelle.trim()) {
    res.status(400).json({ error: 'Le libellé de l’opération est obligatoire.' });
    return;
  }

  const rawMontant = Number(montant);
  if (isNaN(rawMontant) || rawMontant === 0) {
    res.status(400).json({ error: 'Le montant de l’opération doit être un nombre non nul.' });
    return;
  }

  const effectiveCategory: 'entree' | 'sortie' = category === 'entree' ? 'entree' : 'sortie';
  const signedMontant = effectiveCategory === 'sortie' ? -Math.abs(rawMontant) : Math.abs(rawMontant);
  const entryDate = date && typeof date === 'string' ? String(date).split('T')[0] : new Date().toISOString().split('T')[0];
  const resolvedTypeDesc = String(type_description ?? typeDescription ?? '').trim();
  const resolvedNoDossier = String(no_dossier ?? noDossier ?? '').trim();
  const resolvedEmployee = String(employee ?? partenaire ?? '').trim();
  const resolvedPartenaire = String(partenaire ?? employee ?? '').trim();

  try {
    // 1. Récupération du préfixe de séquence du journal
    const { data: journalRow, error: journalError } = await adminClient
      .from('journals')
      .select('id, sequence_prefix, is_active')
      .eq('id', journalId)
      .maybeSingle();

    if (journalError || !journalRow) {
      res.status(404).json({ error: 'Journal comptable introuvable.' });
      return;
    }

    if (journalRow.is_active === false) {
      res.status(400).json({ error: 'Ce journal est désactivé. Aucune saisie n’est autorisée.' });
      return;
    }

    // PostgreSQL attribue sequence_number et piece_comptable via le trigger atomique.
    const { data: inserted, error: insertError } = await adminClient
      .from('journal_entries')
      .insert({
        journal_id: journalId,
        date: entryDate,
        libelle: libelle.trim(),
        service: service ? String(service).trim() : '',
        type_description: resolvedTypeDesc,
        category: effectiveCategory,
        status: status === 'posted' ? 'posted' : 'draft',
        no_dossier: resolvedNoDossier,
        partenaire: resolvedPartenaire,
        employee: resolvedEmployee,
        quantity: Math.max(1, Number(quantity) || 1),
        montant: signedMontant,
        created_by: userId || null,
      })
      .select()
      .single();

    if (insertError || !inserted) {
      console.error('[JOURNAL_ENTRIES] Échec de persistance de l’écriture comptable:', insertError?.message);
      if (insertError?.code === '23505') {
        res.status(409).json({
          error: 'Une écriture équivalente existe déjà dans ce journal. Veuillez réessayer.',
        });
        return;
      }
      res.status(500).json({
        error: `Échec d'enregistrement de l'écriture en base : ${insertError?.message || 'Erreur inconnue'}`,
      });
      return;
    }

    // 4. Audit Log systématique
    await writeAuditLog(adminClient, {
      userId: userId || null,
      userEmail: userEmail || null,
      userRole: userRole || null,
      action: 'CREATE_JOURNAL_ENTRY',
      entityType: 'journal_entry',
      entityId: inserted.id,
      details: {
        journal_id: journalId,
        piece_comptable: inserted.piece_comptable,
        montant: inserted.montant,
        category: inserted.category,
        libelle: inserted.libelle,
      },
      ipAddress: req.ip || null,
    });

    res.status(201).json({
      success: true,
      message: 'Écriture comptable enregistrée avec succès dans le journal.',
      entry: inserted,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[JOURNAL_ENTRIES] Exception lors de la création d’une écriture:', message);
    res.status(500).json({ error: 'Erreur interne lors de la création de l’écriture comptable.' });
  }
};

/**
 * PUT/PATCH /api/journals/:journalId/entries/:id
 * Met à jour une écriture du journal via une liste blanche stricte de champs modifiables.
 */
export const updateJournalEntryHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId']);
  const entryId = extractParamString(req.params['id']);

  if (!journalId || !entryId) {
    res.status(400).json({ error: 'Identifiants du journal et de l’écriture requis.' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string; email?: string } | undefined;
  const userRole = authenticatedUser?.role;
  const userId = authenticatedUser?.id;
  const userEmail = authenticatedUser?.email;

  if (!adminClient) {
    res.status(503).json({ error: 'Base de données non accessible.' });
    return;
  }

  // 1. Liste blanche stricte des champs autorisés à la modification
  const allowedUpdates: Record<string, unknown> = {};
  const body = req.body || {};

  if (typeof body.libelle === 'string' && body.libelle.trim()) {
    allowedUpdates['libelle'] = body.libelle.trim();
  }

  if (typeof body.date === 'string' && body.date.trim()) {
    allowedUpdates['date'] = body.date.split('T')[0];
  }

  if (body.service !== undefined) {
    allowedUpdates['service'] = String(body.service || '').trim();
  }

  if (body.type_description !== undefined || body.typeDescription !== undefined) {
    allowedUpdates['type_description'] = String(body.type_description ?? body.typeDescription ?? '').trim();
  }

  if (body.no_dossier !== undefined || body.noDossier !== undefined) {
    allowedUpdates['no_dossier'] = String(body.no_dossier ?? body.noDossier ?? '').trim();
  }

  if (body.partenaire !== undefined) {
    allowedUpdates['partenaire'] = String(body.partenaire || '').trim();
  }

  if (body.employee !== undefined) {
    allowedUpdates['employee'] = String(body.employee || '').trim();
  }

  if (body.quantity !== undefined) {
    allowedUpdates['quantity'] = Math.max(1, Number(body.quantity) || 1);
  }

  if (body.status !== undefined && ['draft', 'posted', 'cancelled'].includes(body.status)) {
    allowedUpdates['status'] = body.status;
  }

  if (body.category !== undefined && ['entree', 'sortie'].includes(body.category)) {
    allowedUpdates['category'] = body.category;
  }

  if (body.montant !== undefined) {
    const raw = Math.abs(Number(body.montant) || 0);
    const cat = allowedUpdates['category'] || body.category;
    allowedUpdates['montant'] = cat === 'sortie' ? -raw : raw;
  } else if (allowedUpdates['category'] !== undefined) {
    // Si la catégorie change seule, réajuster le signe du montant existant
    const { data: existing } = await adminClient
      .from('journal_entries')
      .select('montant')
      .eq('id', entryId)
      .maybeSingle();

    if (existing) {
      const raw = Math.abs(Number(existing.montant) || 0);
      allowedUpdates['montant'] = allowedUpdates['category'] === 'sortie' ? -raw : raw;
    }
  }

  if (Object.keys(allowedUpdates).length === 0) {
    res.status(400).json({ error: 'Aucun champ valide à mettre à jour.' });
    return;
  }

  allowedUpdates['updated_at'] = new Date().toISOString();

  try {
    const query = adminClient
      .from('journal_entries')
      .update(allowedUpdates)
      .eq('id', entryId)
      .eq('journal_id', journalId);

    const { data: updated, error: updateError } = await query.select().single();

    if (updateError || !updated) {
      res.status(404).json({
        error: updateError?.message || 'Écriture introuvable ou modification non autorisée.',
      });
      return;
    }

    // Audit log
    await writeAuditLog(adminClient, {
      userId: userId || null,
      userEmail: userEmail || null,
      userRole: userRole || null,
      action: 'UPDATE_JOURNAL_ENTRY',
      entityType: 'journal_entry',
      entityId: entryId,
      details: {
        journal_id: journalId,
        updatedFields: Object.keys(allowedUpdates),
      },
      ipAddress: req.ip || null,
    });

    res.json({
      success: true,
      message: 'Écriture mise à jour avec succès.',
      entry: updated,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[JOURNAL_ENTRIES] Exception mise à jour écriture:', message);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de l’écriture comptable.' });
  }
};

/**
 * DELETE /api/journals/:journalId/entries/:id
 * Supprime une écriture du journal avec audit log
 */
export const deleteJournalEntryHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  const journalId = extractParamString(req.params['journalId']);
  const entryId = extractParamString(req.params['id']);

  if (!journalId || !entryId) {
    res.status(400).json({ error: 'Identifiants du journal et de l’écriture requis.' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string; email?: string } | undefined;
  const userRole = authenticatedUser?.role;
  const userId = authenticatedUser?.id;
  const userEmail = authenticatedUser?.email;

  if (!adminClient) {
    res.status(503).json({ error: 'Base de données non disponible.' });
    return;
  }

  try {
    const query = adminClient
      .from('journal_entries')
      .delete()
      .eq('id', entryId)
      .eq('journal_id', journalId);

    const { error } = await query;
    if (error) {
      console.error('[JOURNAL_ENTRIES] Erreur lors de la suppression d’une écriture:', error.message);
      res.status(500).json({ error: 'Erreur lors de la suppression de l’écriture comptable.' });
      return;
    }

    await writeAuditLog(adminClient, {
      userId: userId || null,
      userEmail: userEmail || null,
      userRole: userRole || null,
      action: 'DELETE_JOURNAL_ENTRY',
      entityType: 'journal_entry',
      entityId: entryId,
      details: { journal_id: journalId },
      ipAddress: req.ip || null,
    });

    res.json({ success: true, message: 'Écriture supprimée du journal avec succès.' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[JOURNAL_ENTRIES] Exception suppression écriture:', message);
    res.status(500).json({ error: 'Erreur lors de la suppression de l’écriture comptable.' });
  }
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

  if (!adminClient) {
    res.status(503).json({ error: 'Service indisponible.' });
    return;
  }

  let soldeGlobal = 0;
  try {
    const { data: summary, error: sumErr } = await adminClient.rpc('get_journal_summary', { p_journal_id: journalId });
    if (!sumErr && summary && summary.solde_global !== undefined) {
      soldeGlobal = Number(summary.solde_global);
    } else {
      const { data: sumRows } = await adminClient
        .from('journal_entries')
        .select('montant')
        .eq('journal_id', journalId)
        .eq('status', 'posted');
      soldeGlobal = (sumRows || []).reduce((acc, row) => acc + (Number(row.montant) || 0), 0);
    }
  } catch {
    const { data: sumRows } = await adminClient
      .from('journal_entries')
      .select('montant')
      .eq('journal_id', journalId)
      .eq('status', 'posted');
    soldeGlobal = (sumRows || []).reduce((acc, row) => acc + (Number(row.montant) || 0), 0);
  }

  try {

    const pageSize = 500;
    const entries: JournalEntryRecord[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await adminClient
        .from('journal_entries')
        .select('date, montant, libelle, sequence_number')
        .eq('journal_id', journalId)
        .eq('status', 'posted')
        .order('date', { ascending: true })
        .order('sequence_number', { ascending: true })
        .range(offset, offset + pageSize - 1);

      if (error) {
        console.error(`[JOURNAL_ENTRIES] Erreur lecture du graphique du journal ${journalId}:`, error.message);
        res.status(500).json({ error: 'Erreur lors de la récupération des données du graphique.' });
        return;
      }

      const page = (data || []) as JournalEntryRecord[];
      entries.push(...page);
      if (page.length < pageSize) break;
    }

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
      current_balance: soldeGlobal,
      labels,
      balances,
      descriptions,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
};
