-- =============================================================================
-- Migration : 20261002000000_p0_critical_concurrency_and_realtime_fixes.sql
-- Description : Résolution des vulnérabilités critiques P0/P1
--  1. Unicité stricte par empreinte métier sur cashier_transactions (anti-doublon concurrence)
--  2. Activation de la publication Realtime pour cashier_transactions, journal_entries, prospects
--  3. Fonction RPC atomique pour l'affectation et la synchronisation des rôles (idempotent, multi-rôles)
--  4. Policies RLS de sécurité sur cashier_piece_counters et journal_piece_counters
--  5. Fonction RPC pour le calcul du solde exact global indépendant de la pagination
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';

-- -----------------------------------------------------------------------------
-- 1. Nettoyage préventif des doublons stricts existants avant création de l'index
-- -----------------------------------------------------------------------------
DELETE FROM public.cashier_transactions a
USING public.cashier_transactions b
WHERE a.id > b.id
  AND a.date = b.date
  AND abs(a.montant) = abs(b.montant)
  AND lower(btrim(a.libelle)) = lower(btrim(b.libelle))
  AND lower(btrim(COALESCE(a.no_dossier, ''))) = lower(btrim(COALESCE(b.no_dossier, '')))
  AND lower(btrim(COALESCE(a.service, ''))) = lower(btrim(COALESCE(b.service, '')));

-- Index d'unicité strict sur l'empreinte métier (Date, Montant Absolu, Libellé, Dossier, Service)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashier_transactions_business_fingerprint
ON public.cashier_transactions (
  date,
  (abs(montant)),
  (lower(btrim(libelle))),
  (lower(btrim(COALESCE(no_dossier, '')))),
  (lower(btrim(COALESCE(service, ''))))
);

-- -----------------------------------------------------------------------------
-- 2. Activation de la publication Realtime pour la caisse, les journaux et les prospects
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.cashier_transactions;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.journal_entries;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.prospects;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Sécurisation RLS pour les compteurs de pièces comptables
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'journal_piece_counters' AND policyname = 'journal_piece_counters_service_role_all'
  ) THEN
    CREATE POLICY journal_piece_counters_service_role_all
    ON public.journal_piece_counters FOR ALL TO service_role
    USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'cashier_piece_counters' AND policyname = 'cashier_piece_counters_service_role_all'
  ) THEN
    CREATE POLICY cashier_piece_counters_service_role_all
    ON public.cashier_piece_counters FOR ALL TO service_role
    USING (true) WITH CHECK (true);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Procédure atomique pour l'affectation et synchronisation des rôles
-- Évite l'état orphelin (pas de DELETE ALL) et préserve l'idempotence multi-rôles
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_user_primary_role(
  p_user_id uuid,
  p_role_key text,
  p_assigned_by uuid DEFAULT NULL,
  p_assignment_source text DEFAULT 'admin'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_id uuid;
BEGIN
  -- Vérification de l'existence du rôle cible
  SELECT id INTO v_role_id
  FROM public.access_roles
  WHERE role_key = p_role_key AND is_active = true
  LIMIT 1;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Le rôle d’accès « % » est introuvable ou inactif.', p_role_key;
  END IF;

  -- 1. Upsert atomique et idempotent dans access_user_roles (ne détruit pas les autres rôles)
  INSERT INTO public.access_user_roles (
    user_id,
    role_id,
    assigned_by,
    assignment_source,
    expires_at
  )
  VALUES (
    p_user_id,
    v_role_id,
    p_assigned_by,
    p_assignment_source,
    NULL
  )
  ON CONFLICT (user_id, role_id) DO UPDATE
  SET assignment_source = EXCLUDED.assignment_source,
      assigned_by = COALESCE(EXCLUDED.assigned_by, public.access_user_roles.assigned_by),
      expires_at = NULL;

  -- 2. Synchronisation du champ de rétro-compatibilité profiles.role dans la même transaction
  UPDATE public.profiles
  SET role = p_role_key::public.user_role_enum,
      updated_at = now()
  WHERE id = p_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_user_primary_role(uuid, text, uuid, text) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Fonction de calcul du solde exact et des métriques de caisse côté PostgreSQL
-- Garantit un solde exact peu importe la pagination et les filtres locaux
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cashier_summary(p_journal_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_entrees numeric := 0;
  v_total_sorties numeric := 0;
  v_solde_global numeric := 0;
  v_total_count bigint := 0;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN category = 'entree' THEN montant ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN category = 'sortie' THEN abs(montant) ELSE 0 END), 0),
    COALESCE(SUM(montant), 0),
    COUNT(*)
  INTO
    v_total_entrees,
    v_total_sorties,
    v_solde_global,
    v_total_count
  FROM public.cashier_transactions
  WHERE (p_journal_id IS NULL)
     OR (journal_id = p_journal_id);

  RETURN jsonb_build_object(
    'total_entrees', v_total_entrees,
    'total_sorties', v_total_sorties,
    'solde_global', v_solde_global,
    'total_count', v_total_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_cashier_summary(uuid) TO service_role;

COMMIT;
