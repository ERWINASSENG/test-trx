import express from 'express';
import { getSupabaseAdmin } from './auth';

/**
 * Rôles autorisés pour la consultation des journaux :
 * - admin : accès complet
 * - tresorier : accès complet
 * - manager : consultation en lecture seule
 */
const ALLOWED_VIEW_ROLES = ['admin', 'tresorier', 'manager'];

/**
 * Rôles autorisés pour la création et suppression de journaux :
 * - admin
 * - tresorier
 */
const ALLOWED_MANAGE_ROLES = ['admin', 'tresorier'];

/**
 * GET /api/journals
 * Récupère la liste de tous les journaux comptables enregistrés
 */
export const getJournalsHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string } | undefined;
  const userRole = authenticatedUser?.role;

  if (!userRole || !ALLOWED_VIEW_ROLES.includes(userRole)) {
    res.status(403).json({
      error: 'Accès interdit : seuls les administrateurs, trésoriers et managers peuvent consulter les journaux.',
    });
    return;
  }

  try {
    const { data, error } = await adminClient
      .from('journals')
      .select('id, name, type, ledger_type, sequence_prefix, default_account, currency, is_active, created_at, updated_at')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[API JOURNAUX] Erreur lecture Supabase:', error);
      res.status(500).json({ error: 'Erreur lors de la récupération des journaux.' });
      return;
    }

    res.status(200).json({
      journals: data || [],
      count: data ? data.length : 0,
      userRole,
      canManage: ALLOWED_MANAGE_ROLES.includes(userRole),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erreur interne';
    console.error('[API JOURNAUX] Exception interne:', err);
    res.status(500).json({ error: msg });
  }
};

/**
 * POST /api/journals
 * Crée un nouveau journal comptable (strictement réservé à admin et tresorier)
 */
export const createJournalHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string } | undefined;
  const userRole = authenticatedUser?.role;

  if (!userRole || !ALLOWED_MANAGE_ROLES.includes(userRole)) {
    res.status(403).json({
      error: 'Accès interdit : seuls les administrateurs et les trésoriers ont le droit de créer des journaux.',
    });
    return;
  }

  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const type = typeof body.type === 'string' ? body.type.trim() : 'bank';
  const ledger_type = typeof body.ledger_type === 'string' ? body.ledger_type.trim() : '';
  const sequence_prefix = typeof body.sequence_prefix === 'string' ? body.sequence_prefix.trim().toUpperCase() : '';
  const default_account = typeof body.default_account === 'string' ? body.default_account.trim() : '';
  const currency = typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim().toUpperCase() : 'XAF';
  const is_active = typeof body.is_active === 'boolean' ? body.is_active : true;

  if (!name || name.length < 2) {
    res.status(400).json({ error: 'Le nom du journal doit contenir au moins 2 caractères.' });
    return;
  }

  if (!sequence_prefix || sequence_prefix.length < 2 || sequence_prefix.length > 6) {
    res.status(400).json({ error: 'Le préfixe de séquence doit contenir entre 2 et 6 lettres majuscules.' });
    return;
  }

  if (!default_account) {
    res.status(400).json({ error: 'Le compte comptable par défaut est obligatoire.' });
    return;
  }

  try {
    // Vérifier l'unicité du préfixe
    const { data: existingPrefix } = await adminClient
      .from('journals')
      .select('id')
      .eq('sequence_prefix', sequence_prefix)
      .maybeSingle();

    if (existingPrefix) {
      res.status(409).json({ error: `Le préfixe de séquence « ${sequence_prefix} » est déjà utilisé par un autre journal.` });
      return;
    }

    const newId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `jnl-${Date.now()}`;

    const { data: inserted, error: insertError } = await adminClient
      .from('journals')
      .insert([
        {
          id: newId,
          name,
          type,
          ledger_type,
          sequence_prefix,
          default_account,
          currency,
          is_active,
        },
      ])
      .select()
      .single();

    if (insertError) {
      console.error('[API JOURNAUX] Erreur insertion Supabase:', insertError);
      res.status(500).json({ error: insertError.message || 'Impossible de créer le journal.' });
      return;
    }

    res.status(201).json({
      message: `Journal « ${name} » créé avec succès.`,
      journal: inserted,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erreur interne';
    console.error('[API JOURNAUX] Exception création:', err);
    res.status(500).json({ error: msg });
  }
};

/**
 * DELETE /api/journals/:id
 * Supprime un journal comptable (strictement réservé à admin et tresorier)
 */
export const deleteJournalHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { role?: string; id?: string } | undefined;
  const userRole = authenticatedUser?.role;

  if (!userRole || !ALLOWED_MANAGE_ROLES.includes(userRole)) {
    res.status(403).json({
      error: 'Accès interdit : seuls les administrateurs et les trésoriers ont le droit de supprimer des journaux.',
    });
    return;
  }

  const journalId = req.params['id'];
  if (!journalId) {
    res.status(400).json({ error: 'Identifiant du journal manquant.' });
    return;
  }

  try {
    // Vérifier si le journal n'est pas le journal de caisse principal obligatoire
    const { data: existing } = await adminClient
      .from('journals')
      .select('id, name, sequence_prefix')
      .eq('id', journalId)
      .maybeSingle();

    if (!existing) {
      res.status(404).json({ error: 'Journal introuvable.' });
      return;
    }

    if (existing.sequence_prefix === 'CSH1' || existing.name.toLowerCase().includes('caisse principale')) {
      res.status(400).json({ error: 'Le journal de Caisse Principale est un journal système et ne peut pas être supprimé.' });
      return;
    }

    // Vérifier si des transactions y sont associées
    const { count: txCount } = await adminClient
      .from('cashier_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('journal_id', journalId);

    if (txCount && txCount > 0) {
      res.status(400).json({
        error: `Impossible de supprimer ce journal : ${txCount} transaction(s) comptable(s) y sont rattachée(s).`,
      });
      return;
    }

    const { error: deleteError } = await adminClient
      .from('journals')
      .delete()
      .eq('id', journalId);

    if (deleteError) {
      console.error('[API JOURNAUX] Erreur suppression:', deleteError);
      res.status(500).json({ error: deleteError.message || 'Impossible de supprimer le journal.' });
      return;
    }

    res.status(200).json({
      message: `Le journal « ${existing.name} » a été supprimé avec succès.`,
      id: journalId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erreur interne';
    console.error('[API JOURNAUX] Exception suppression:', err);
    res.status(500).json({ error: msg });
  }
};
