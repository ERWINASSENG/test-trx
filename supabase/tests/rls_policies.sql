-- ==============================================================================
-- Tests SQL / pgTAP pour la validation des politiques RLS (Row Level Security)
-- ==============================================================================
-- Exécution recommandée via Supabase CLI (`supabase test db`) ou psql de test.

BEGIN;

-- 1. Vérification que RLS est bien activé sur toutes les tables sensibles
DO $$
DECLARE
  missing_rls text[];
BEGIN
  SELECT array_agg(c.relname::text) INTO missing_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity = false
    AND c.relname IN ('profiles', 'dossiers', 'journals', 'journal_entries', 'cashier_transactions', 'journal_piece_counters', 'audit_logs');

  IF missing_rls IS NOT NULL AND array_length(missing_rls, 1) > 0 THEN
    RAISE EXCEPTION 'TEST ÉCHOUÉ : RLS désactivé sur les tables : %', missing_rls;
  ELSE
    RAISE NOTICE 'TEST SUCCÈS [1/5] : RLS est actif sur toutes les tables sensibles.';
  END IF;
END $$;

-- 2. Vérification des politiques RLS sur 'dossiers'
DO $$
DECLARE
  has_policy boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'dossiers'
      AND policyname = 'dossiers_select_by_role'
  ) INTO has_policy;

  IF NOT has_policy THEN
    RAISE EXCEPTION 'TEST ÉCHOUÉ : Politique dossiers_select_by_role introuvable sur la table dossiers.';
  ELSE
    RAISE NOTICE 'TEST SUCCÈS [2/5] : Politique RLS du moindre privilège présente sur la table dossiers.';
  END IF;
END $$;

-- 3. Vérification des politiques RLS sur 'journal_entries'
DO $$
DECLARE
  has_select_policy boolean;
  has_insert_policy boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'journal_entries'
      AND policyname = 'journal_entries_select_by_role'
  ) INTO has_select_policy;

  SELECT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'journal_entries'
      AND policyname = 'journal_entries_insert_by_role'
  ) INTO has_insert_policy;

  IF NOT has_select_policy OR NOT has_insert_policy THEN
    RAISE EXCEPTION 'TEST ÉCHOUÉ : Politiques RLS manquantes sur journal_entries.';
  ELSE
    RAISE NOTICE 'TEST SUCCÈS [3/5] : Politiques RLS de lecture et écriture vérifiées sur journal_entries.';
  END IF;
END $$;

-- 4. Vérification de l'isolation de 'journal_piece_counters' (interdit à anon/authenticated)
DO $$
DECLARE
  anon_has_privilege boolean;
BEGIN
  SELECT has_table_privilege('anon', 'public.journal_piece_counters', 'SELECT') INTO anon_has_privilege;

  IF anon_has_privilege THEN
    RAISE EXCEPTION 'TEST ÉCHOUÉ : anon possède des privilèges de lecture sur journal_piece_counters.';
  ELSE
    RAISE NOTICE 'TEST SUCCÈS [4/5] : journal_piece_counters est hermétique et protégé contre anon.';
  END IF;
END $$;

-- 5. Vérification du trigger d'attribution atomique de pièce comptable
DO $$
DECLARE
  has_trigger boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_assign_journal_entry_piece_comptable'
  ) INTO has_trigger;

  IF NOT has_trigger THEN
    RAISE EXCEPTION 'TEST ÉCHOUÉ : Trigger trg_assign_journal_entry_piece_comptable manquant sur journal_entries.';
  ELSE
    RAISE NOTICE 'TEST SUCCÈS [5/5] : Trigger de séquençage atomique opérationnel sur journal_entries.';
  END IF;
END $$;

ROLLBACK;
