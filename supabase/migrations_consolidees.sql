-- ==============================================================================
-- Source: 20260927000001_atomic_journal_entries_and_strict_rls.sql
-- ==============================================================================
-- ==============================================================================
-- Migration: 20260927000001_atomic_journal_entries_and_strict_rls.sql
-- Description:
--   1. Création de la table 'journal_piece_counters' pour le séquençage atomique des écritures
--   2. Trigger et fonction PL/pgSQL 'assign_journal_entry_piece_comptable' pour verrouillage de séquence
--   3. Durcissement RLS des tables 'dossiers' et 'profiles' (moindre privilège)
--   4. RLS pour 'journal_piece_counters'
-- ==============================================================================

BEGIN;

-- 1. Table de compteurs atomiques pour les journaux
CREATE TABLE IF NOT EXISTS public.journal_piece_counters (
  journal_id uuid NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
  annee integer NOT NULL,
  dernier_numero integer NOT NULL DEFAULT 0,
  PRIMARY KEY (journal_id, annee)
);

-- RLS sur journal_piece_counters
ALTER TABLE public.journal_piece_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.journal_piece_counters FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.journal_piece_counters TO service_role;

-- 2. Procédure stockée d'attribution atomique de pièces comptables
CREATE OR REPLACE FUNCTION public.assign_journal_entry_piece_comptable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  prefix text;
  annee_piece integer;
  prochain_num integer;
  candidat text;
  existe boolean;
BEGIN
  -- Si une pièce est déjà fournie avec un numéro de séquence valide, la conserver
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' AND NEW.sequence_number IS NOT NULL AND NEW.sequence_number > 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sequence_prefix, 'JRNL') INTO prefix
  FROM public.journals WHERE id = NEW.journal_id;

  IF prefix IS NULL THEN
    prefix := 'JRNL';
  END IF;

  annee_piece := COALESCE(
    NULLIF(substring(NEW.date::text from '^\d{4}'), '')::int,
    NULLIF(substring(NEW.date::text from '\d{4}$'), '')::int,
    EXTRACT(YEAR FROM now())::int
  );

  INSERT INTO public.journal_piece_counters (journal_id, annee, dernier_numero)
  VALUES (NEW.journal_id, annee_piece, 0)
  ON CONFLICT (journal_id, annee) DO NOTHING;

  LOOP
    UPDATE public.journal_piece_counters
    SET dernier_numero = public.journal_piece_counters.dernier_numero + 1
    WHERE journal_id = NEW.journal_id AND annee = annee_piece
    RETURNING dernier_numero INTO prochain_num;

    candidat := prefix || '/' || annee_piece || '/' || lpad(prochain_num::text, 5, '0');

    SELECT EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE journal_id = NEW.journal_id AND piece_comptable = candidat
    ) INTO existe;

    IF NOT existe THEN
      NEW.sequence_number := prochain_num;
      NEW.piece_comptable := candidat;
      EXIT;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- Création ou remplacement du trigger
DROP TRIGGER IF EXISTS trg_assign_journal_entry_piece_comptable ON public.journal_entries;
CREATE TRIGGER trg_assign_journal_entry_piece_comptable
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.assign_journal_entry_piece_comptable();

-- 3. Durcissement des politiques RLS sur dossiers
DROP POLICY IF EXISTS dossiers_select_authenticated ON public.dossiers;
DROP POLICY IF EXISTS dossiers_select_by_role ON public.dossiers;

CREATE POLICY dossiers_select_by_role ON public.dossiers
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('admin', 'caissier', 'caissiere', 'manager', 'tresorier', 'comptable', 'rh')
    )
    OR created_by = (SELECT auth.uid())
  );

COMMIT;


-- ==============================================================================
-- Source: 20260927000002_harden_financial_data_access.sql
-- ==============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.is_active IS TRUE
  );
$function$;

REVOKE ALL ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS public.user_role_enum
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
    AND p.is_active IS TRUE
  LIMIT 1;
$function$;

DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (
      public.is_active_user()
      AND (is_active IS TRUE OR public.is_admin())
    )
  );

DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (id = (SELECT auth.uid()) OR public.is_admin())
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        id = (SELECT auth.uid())
        AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
        AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS dossiers_select_by_role ON public.dossiers;
CREATE POLICY dossiers_select_by_role ON public.dossiers
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager', 'tresorier', 'comptable', 'rh')
      )
      OR created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS dossiers_insert_by_role ON public.dossiers;
CREATE POLICY dossiers_insert_by_role ON public.dossiers
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS dossiers_update_by_role ON public.dossiers;
CREATE POLICY dossiers_update_by_role ON public.dossiers
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS dossiers_delete_admin_only ON public.dossiers;
CREATE POLICY dossiers_delete_admin_only ON public.dossiers
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin());

DROP POLICY IF EXISTS journals_select_authenticated ON public.journals;
CREATE POLICY journals_select_authenticated ON public.journals
  FOR SELECT TO authenticated
  USING (public.is_active_user());

DROP POLICY IF EXISTS journals_insert_management ON public.journals;
CREATE POLICY journals_insert_management ON public.journals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  );

DROP POLICY IF EXISTS journals_update_management ON public.journals;
CREATE POLICY journals_update_management ON public.journals
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  );

DROP POLICY IF EXISTS journals_delete_admin ON public.journals;
CREATE POLICY journals_delete_admin ON public.journals
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin() AND sequence_prefix <> 'CSH1');

DROP POLICY IF EXISTS journal_entries_select_by_role ON public.journal_entries;
CREATE POLICY journal_entries_select_by_role ON public.journal_entries
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('tresorier', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_insert_by_role ON public.journal_entries;
CREATE POLICY journal_entries_insert_by_role ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_update_by_role ON public.journal_entries;
CREATE POLICY journal_entries_update_by_role ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_delete_by_role ON public.journal_entries;
CREATE POLICY journal_entries_delete_by_role ON public.journal_entries
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_select_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_select_by_role ON public.cashier_transactions
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager', 'comptable', 'tresorier')
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_insert_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_insert_by_role ON public.cashier_transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role IN ('caissier', 'caissiere', 'manager')
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_update_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_update_own_or_admin ON public.cashier_transactions
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR COALESCE(created_by, employee_id) = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_delete_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_delete_own_or_admin ON public.cashier_transactions
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR COALESCE(created_by, employee_id) = (SELECT auth.uid())
    )
  );

REVOKE ALL PRIVILEGES ON TABLE public.journal_entries, public.cashier_transactions
  FROM anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.journal_entries, public.cashier_transactions
  TO service_role;

COMMIT;

-- ==============================================================================
-- Source: 20260927000003_restrict_profile_and_journal_reads.sql
-- ==============================================================================
BEGIN;

DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (public.is_active_user() AND public.is_admin())
  );

DROP POLICY IF EXISTS journals_select_authenticated ON public.journals;
CREATE POLICY journals_select_authenticated ON public.journals
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('tresorier', 'manager')
      )
    )
  );

COMMIT;

-- ==============================================================================
-- Source: 20260927000004_consolidated_security_hardening.sql
-- ==============================================================================
-- ============================================================================== 
-- Migration consolidée : durcissement des accès financiers et lecture des profils
-- Description :
--   - helper public.is_active_user() + public.is_admin()
--   - durcissement des règles RLS sur profiles, dossiers, journals, journal_entries,
--     cashier_transactions
--   - blocage des privilèges Data API directs sur les tables financières pour
--     authenticated/anon ; service_role conservé pour le backend serveur
--   - restriction de lecture des profils/journaux aux cas autorisés
-- ============================================================================== 

BEGIN;

-- 1) Helpers de sécurité utilisateur
CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.is_active IS TRUE
  );
$function$;

REVOKE ALL ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS public.user_role_enum
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p.role
  FROM public.profiles p
  WHERE p.id = (SELECT auth.uid())
    AND p.is_active IS TRUE
  LIMIT 1;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT (public.get_current_user_role() = 'admin');
$function$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- 2) Politique de lecture et modification des profils
DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = (SELECT auth.uid())
    OR (
      public.is_active_user()
      AND public.is_admin()
    )
  );

DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy ON public.profiles
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      id = (SELECT auth.uid())
      OR public.is_admin()
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        id = (SELECT auth.uid())
        AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
        AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
      )
    )
  );

-- 3) Dossiers : lecture par rôle opérationnel ou créateur ; écriture par rôle maîtrisé
DROP POLICY IF EXISTS dossiers_select_by_role ON public.dossiers;
CREATE POLICY dossiers_select_by_role ON public.dossiers
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager', 'tresorier', 'comptable', 'rh')
      )
      OR created_by = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS dossiers_insert_by_role ON public.dossiers;
CREATE POLICY dossiers_insert_by_role ON public.dossiers
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS dossiers_update_by_role ON public.dossiers;
CREATE POLICY dossiers_update_by_role ON public.dossiers
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS dossiers_delete_admin_only ON public.dossiers;
CREATE POLICY dossiers_delete_admin_only ON public.dossiers
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin());

-- 4) Journaux : lecture réservée aux rôles autorisés, écriture au trésorier/admin
DROP POLICY IF EXISTS journals_select_authenticated ON public.journals;
CREATE POLICY journals_select_authenticated ON public.journals
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('tresorier', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS journals_insert_management ON public.journals;
CREATE POLICY journals_insert_management ON public.journals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  );

DROP POLICY IF EXISTS journals_update_management ON public.journals;
CREATE POLICY journals_update_management ON public.journals
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  );

DROP POLICY IF EXISTS journals_delete_admin ON public.journals;
CREATE POLICY journals_delete_admin ON public.journals
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin() AND sequence_prefix <> 'CSH1');

-- 5) Journal entries : lecture et mutations strictement limitées aux comptes actifs
DROP POLICY IF EXISTS journal_entries_select_by_role ON public.journal_entries;
CREATE POLICY journal_entries_select_by_role ON public.journal_entries
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('tresorier', 'manager')
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_insert_by_role ON public.journal_entries;
CREATE POLICY journal_entries_insert_by_role ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_update_by_role ON public.journal_entries;
CREATE POLICY journal_entries_update_by_role ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_delete_by_role ON public.journal_entries;
CREATE POLICY journal_entries_delete_by_role ON public.journal_entries
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

-- 6) Transactions de caisse : lecture et écriture par rôle de caisse/manager/admin,
--    avec validation que l'utilisateur actif est bien le propriétaire ou un admin.
DROP POLICY IF EXISTS cashier_transactions_select_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_select_by_role ON public.cashier_transactions
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role IN ('caissier', 'caissiere', 'manager', 'comptable', 'tresorier')
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_insert_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_insert_by_role ON public.cashier_transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role IN ('caissier', 'caissiere', 'manager')
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_update_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_update_own_or_admin ON public.cashier_transactions
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR COALESCE(created_by, employee_id) = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_delete_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_delete_own_or_admin ON public.cashier_transactions
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR COALESCE(created_by, employee_id) = (SELECT auth.uid())
    )
  );

-- 7) Restriction des accès Data API directs sur les tables financières
REVOKE ALL PRIVILEGES ON TABLE public.journal_entries, public.cashier_transactions
  FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE public.journal_entries, public.cashier_transactions
  TO service_role;

-- 8) Les fonctions utilitaires d'auth restent limitées à l'authentifié/service_role
REVOKE EXECUTE ON FUNCTION public.get_current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

COMMIT;


-- ==============================================================================
-- Source: 20260929000001_enforce_journal_ownership.sql
-- ==============================================================================
BEGIN;

ALTER TABLE public.journals
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journals_created_by
  ON public.journals (created_by);

DROP POLICY IF EXISTS journals_insert_management ON public.journals;
CREATE POLICY journals_insert_management ON public.journals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND created_by = (SELECT auth.uid())
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.is_active IS TRUE
          AND p.role = 'tresorier'
      )
    )
  );

DROP POLICY IF EXISTS journals_update_management ON public.journals;
CREATE POLICY journals_update_management ON public.journals
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_insert_by_role ON public.journal_entries;
CREATE POLICY journal_entries_insert_by_role ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
        AND EXISTS (
          SELECT 1
          FROM public.journals j
          WHERE j.id = journal_entries.journal_id
            AND j.created_by = (SELECT auth.uid())
            AND j.is_active IS TRUE
            AND j.sequence_prefix <> 'CSH1'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_update_by_role ON public.journal_entries;
CREATE POLICY journal_entries_update_by_role ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
        AND EXISTS (
          SELECT 1
          FROM public.journals j
          WHERE j.id = journal_entries.journal_id
            AND j.created_by = (SELECT auth.uid())
            AND j.sequence_prefix <> 'CSH1'
        )
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
        AND EXISTS (
          SELECT 1
          FROM public.journals j
          WHERE j.id = journal_entries.journal_id
            AND j.created_by = (SELECT auth.uid())
            AND j.sequence_prefix <> 'CSH1'
        )
      )
    )
  );

DROP POLICY IF EXISTS journal_entries_delete_by_role ON public.journal_entries;
CREATE POLICY journal_entries_delete_by_role ON public.journal_entries
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
        AND EXISTS (
          SELECT 1
          FROM public.journals j
          WHERE j.id = journal_entries.journal_id
            AND j.created_by = (SELECT auth.uid())
            AND j.sequence_prefix <> 'CSH1'
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_insert_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_insert_by_role ON public.cashier_transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'caissiere'
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_update_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_update_own_or_admin ON public.cashier_transactions
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        COALESCE(created_by, employee_id) = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'caissiere'
        )
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        created_by = (SELECT auth.uid())
        AND (employee_id IS NULL OR employee_id = (SELECT auth.uid()))
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'caissiere'
        )
      )
    )
  );

DROP POLICY IF EXISTS cashier_transactions_delete_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_delete_own_or_admin ON public.cashier_transactions
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        COALESCE(created_by, employee_id) = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'caissiere'
        )
      )
    )
  );

COMMIT;

