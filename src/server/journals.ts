import express from 'express';
import { getSupabaseAdmin } from './auth';
import { requestHasPermission } from './access-control';

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

  try {
    const { data, error } = await adminClient
      .from('journals')
      .select('id, name, type, ledger_type, sequence_prefix, default_account, currency, is_active, created_by, created_at, updated_at')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[API JOURNAUX] Erreur lecture Supabase:', error);
      res.status(500).json({ error: 'Erreur lors de la récupération des journaux.' });
      return;
    }

    res.status(200).json({
      journals: data || [],
      count: data ? data.length : 0,
      canManage: requestHasPermission(req, 'journals.create'),
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

  const authenticatedUser = (req as unknown as Record<string, unknown>)['user'] as { id?: string } | undefined;
  const userId = authenticatedUser?.id;
  if (!userId) {
    res.status(401).json({ error: 'Utilisateur non identifié. Création du journal refusée.' });
    return;
  }

  if (!userId) {
    res.status(401).json({ error: 'Utilisateur non identifié. Création du journal refusée.' });
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
          created_by: userId,
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
 * PATCH / PUT /api/journals/:id
 * Modifie les attributs d'un journal existant (nom, type, sigle/préfixe, compte par défaut, statut actif)
 * Strictement réservé à admin et tresorier
 */
export const updateJournalHandler = async (req: express.Request, res: express.Response): Promise<void> => {
  const adminClient = getSupabaseAdmin();
  if (!adminClient) {
    res.status(503).json({ error: 'Service Supabase non configuré sur le serveur' });
    return;
  }

  const journalId = req.params['id'];
  if (!journalId) {
    res.status(400).json({ error: 'Identifiant du journal manquant.' });
    return;
  }

  const body = req.body || {};
  const updateData: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length < 2) {
      res.status(400).json({ error: 'Le nom du journal doit contenir au moins 2 caractères.' });
      return;
    }
    updateData['name'] = name;
  }

  if (body.type !== undefined) {
    const type = typeof body.type === 'string' ? body.type.trim() : 'bank';
    updateData['type'] = type;
  }

  if (body.ledger_type !== undefined) {
    updateData['ledger_type'] = typeof body.ledger_type === 'string' ? body.ledger_type.trim() : '';
  }

  if (body.sequence_prefix !== undefined) {
    const sequence_prefix = typeof body.sequence_prefix === 'string' ? body.sequence_prefix.trim().toUpperCase() : '';
    if (!sequence_prefix || sequence_prefix.length < 2 || sequence_prefix.length > 6) {
      res.status(400).json({ error: 'Le préfixe de séquence doit contenir entre 2 et 6 lettres majuscules.' });
      return;
    }

    // Vérifier si le journal ciblé est la caisse principale système (protection du préfixe CSH1)
    const { data: existingTarget } = await adminClient
      .from('journals')
      .select('sequence_prefix')
      .eq('id', journalId)
      .maybeSingle();

    if (existingTarget?.sequence_prefix === 'CSH1' && sequence_prefix !== 'CSH1') {
      res.status(400).json({ error: 'Le préfixe CSH1 de la Caisse Principale ne peut pas être modifié.' });
      return;
    }

    // Vérifier l'unicité du préfixe parmi les autres journaux
    const { data: existingPrefix } = await adminClient
      .from('journals')
      .select('id')
      .eq('sequence_prefix', sequence_prefix)
      .neq('id', journalId)
      .maybeSingle();

    if (existingPrefix) {
      res.status(409).json({ error: `Le préfixe de séquence « ${sequence_prefix} » est déjà utilisé par un autre journal.` });
      return;
    }

    updateData['sequence_prefix'] = sequence_prefix;
  }

  if (body.default_account !== undefined) {
    const default_account = typeof body.default_account === 'string' ? body.default_account.trim() : '';
    if (!default_account) {
      res.status(400).json({ error: 'Le compte comptable par défaut est obligatoire.' });
      return;
    }
    updateData['default_account'] = default_account;
  }

  if (body.currency !== undefined) {
    updateData['currency'] = typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim().toUpperCase() : 'XAF';
  }

  if (body.is_active !== undefined) {
    updateData['is_active'] = typeof body.is_active === 'boolean' ? body.is_active : true;
  }

  if (Object.keys(updateData).length === 0) {
    res.status(400).json({ error: 'Aucun champ valide à mettre à jour.' });
    return;
  }

  updateData['updated_at'] = new Date().toISOString();

  try {
    const { data: updated, error: updateError } = await adminClient
      .from('journals')
      .update(updateData)
      .eq('id', journalId)
      .select()
      .maybeSingle();

    if (updateError) {
      console.error('[API JOURNAUX] Erreur mise à jour Supabase:', updateError);
      res.status(500).json({ error: updateError.message || 'Impossible de mettre à jour le journal.' });
      return;
    }

    if (!updated) {
      res.status(404).json({ error: 'Journal introuvable pour la mise à jour.' });
      return;
    }

    res.status(200).json({
      message: `Journal « ${updated.name} » mis à jour avec succès.`,
      journal: updated,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erreur interne';
    console.error('[API JOURNAUX] Exception mise à jour:', err);
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
