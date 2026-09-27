- ============================================================================
-- DIGITAL-TRX — Reproduction complète du schéma Supabase
-- Généré le 27/09/2026 par introspection directe du projet acpnphsvdcvagljlcrvl
-- (pg_type, information_schema.columns, pg_constraint, pg_indexes, pg_proc,
--  pg_trigger, pg_policies, information_schema.role_table_grants)
--
-- À exécuter sur un projet Supabase VIERGE, via SQL Editor, dans l'ordre tel quel.
-- Hypothèses : schéma `auth` standard Supabase déjà présent (auth.users, auth.uid()),
-- rôles anon/authenticated/service_role déjà créés (par défaut sur tout projet Supabase),
-- extension pgcrypto déjà active (par défaut sur tout projet Supabase, fournit gen_random_uuid()).
-- ============================================================================

BEGIN;

SET LOCAL statement_timeout = '5min';

-- ----------------------------------------------------------------------------
-- 1. TYPES ÉNUMÉRÉS
-- ----------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.user_role_enum AS ENUM (
    'admin', 'rh', 'manager_stock', 'caissier', 'agent',
    'manager', 'caissiere', 'employe', 'tresorier', 'comptable'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.transaction_type_category AS ENUM ('entree', 'sortie');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.cashier_transaction_status AS ENUM ('draft', 'posted', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- 2. FONCTIONS UTILITAIRES (sans dépendance à une table applicative)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_short_id()
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  chars text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 3. TABLE profiles
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.profiles (
  id                    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                 text NOT NULL UNIQUE,
  first_name            text NOT NULL,
  last_name             text NOT NULL,
  role                  public.user_role_enum NOT NULL DEFAULT 'agent',
  department            text DEFAULT 'Services Généraux',
  phone                 text,
  avatar_url            text,
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  user_code             text NOT NULL UNIQUE DEFAULT public.generate_short_id(),
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_department ON public.profiles (department);
CREATE INDEX IF NOT EXISTS idx_profiles_email      ON public.profiles (email);
CREATE INDEX IF NOT EXISTS idx_profiles_role        ON public.profiles (role);

-- ----------------------------------------------------------------------------
-- 4. FONCTIONS DÉPENDANT DE profiles
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_current_user_role()
 RETURNS public.user_role_enum
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    user_role public.user_role_enum;
BEGIN
    SELECT role INTO user_role
    FROM public.profiles
    WHERE id = auth.uid();

    RETURN user_role;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT (public.get_current_user_role() = 'admin');
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  requested_role TEXT;
  safe_role public.user_role_enum;
BEGIN
  -- Seul app_metadata, écrit par le serveur, peut proposer un rôle privilégié.
  requested_role := COALESCE(new.raw_app_meta_data->>'role', 'employe');

  BEGIN
    safe_role := requested_role::public.user_role_enum;
  EXCEPTION WHEN invalid_text_representation THEN
    safe_role := 'employe'::public.user_role_enum;
  END;

  INSERT INTO public.profiles (
    id, email, first_name, last_name, role, department, phone, is_active, created_at, updated_at
  )
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'firstName', ''),
    COALESCE(new.raw_user_meta_data->>'last_name', new.raw_user_meta_data->>'lastName', ''),
    safe_role,
    COALESCE(new.raw_user_meta_data->>'department', 'Services Généraux'),
    COALESCE(new.raw_user_meta_data->>'phone', ''),
    true,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    first_name = CASE WHEN EXCLUDED.first_name <> '' THEN EXCLUDED.first_name ELSE public.profiles.first_name END,
    last_name = CASE WHEN EXCLUDED.last_name <> '' THEN EXCLUDED.last_name ELSE public.profiles.last_name END,
    role = EXCLUDED.role,
    department = CASE WHEN EXCLUDED.department <> '' THEN EXCLUDED.department ELSE public.profiles.department END,
    updated_at = now();

  RETURN new;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 5. TABLE dossiers
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dossiers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no_dossier  text NOT NULL UNIQUE,
  client      text,
  statut      text NOT NULL DEFAULT 'ouvert',
  description text,
  created_by  uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dossiers_created_by ON public.dossiers (created_by);

-- ----------------------------------------------------------------------------
-- 6. TABLE journals
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.journals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  type            text NOT NULL
    CHECK (type IN ('cash', 'bank', 'sale', 'purchase', 'general', 'divers')),
  ledger_type     text DEFAULT '',
  sequence_prefix varchar(10) NOT NULL UNIQUE,
  default_account text NOT NULL,
  currency        varchar(10) NOT NULL DEFAULT 'XAF',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journals_is_active ON public.journals (is_active);
CREATE INDEX IF NOT EXISTS idx_journals_type       ON public.journals (type);

INSERT INTO public.journals
  (name, type, ledger_type, sequence_prefix, default_account, currency, is_active)
VALUES
  ('Caisse Principale', 'cash', 'Journal des opérations de caisse',
   'CSH1', '510000 Valeurs à encaisser', 'XAF', true)
ON CONFLICT (sequence_prefix) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 7. TABLE cashier_piece_counters
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cashier_piece_counters (
  annee          integer PRIMARY KEY,
  dernier_numero integer NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------------------------
-- 8. TABLE cashier_transactions
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cashier_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date             text NOT NULL,
  libelle          text NOT NULL,
  service          text,
  type_description text,
  category         public.transaction_type_category NOT NULL,
  status           public.cashier_transaction_status NOT NULL DEFAULT 'draft',
  no_dossier       text,
  dossier_id       uuid REFERENCES public.dossiers(id),
  first_name       text,
  partenaire       text,
  employee         text,
  employee_id      uuid REFERENCES public.profiles(id),
  quantity         numeric,
  montant          numeric NOT NULL,
  solde_apres      numeric,
  selected         boolean DEFAULT false,
  created_by       uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
  piece_comptable  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  journal_id       uuid REFERENCES public.journals(id) ON DELETE RESTRICT,

  CONSTRAINT chk_operations_requires_dossier
    CHECK (service <> 'Opérations' OR no_dossier IS NOT NULL OR dossier_id IS NOT NULL),
  CONSTRAINT chk_operations_requires_quantity
    CHECK (service <> 'Opérations' OR quantity IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashier_transactions_piece_comptable
  ON public.cashier_transactions (piece_comptable) WHERE (piece_comptable IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cashier_piece_comptable        ON public.cashier_transactions (piece_comptable);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_category  ON public.cashier_transactions (category);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_created_by ON public.cashier_transactions (created_by);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_date       ON public.cashier_transactions (date);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_dossier_id ON public.cashier_transactions (dossier_id);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_employee_id ON public.cashier_transactions (employee_id);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_journal_id ON public.cashier_transactions (journal_id);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_service    ON public.cashier_transactions (service);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_status     ON public.cashier_transactions (status);

-- ----------------------------------------------------------------------------
-- 9. TABLE audit_logs
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_email  text,
  user_role   text,
  action      text NOT NULL,
  entity_type text NOT NULL DEFAULT 'cashier_transaction',
  entity_id   text,
  details     jsonb DEFAULT '{}'::jsonb,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity      ON public.audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id     ON public.audit_logs (user_id);

-- ----------------------------------------------------------------------------
-- 10. FONCTIONS ET TRIGGERS DE CAISSE (dépendent des tables ci-dessus)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_piece_comptable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  annee_piece integer;
  prochain_numero integer;
  candidat_piece text;
  existe boolean;
BEGIN
  -- Si une pièce est fournie manuellement (non vide), on la conserve telle quelle
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' THEN
    RETURN NEW;
  END IF;

  -- Détermination de l'année (depuis NEW.date au format DD/MM/YYYY, ou année courante)
  annee_piece := COALESCE(
    NULLIF(substring(NEW.date from '\d{4}$'), '')::int,
    EXTRACT(YEAR FROM now())::int
  );

  -- Initialisation ou verrouillage de ligne du compteur d'année
  INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
  VALUES (annee_piece, 0)
  ON CONFLICT (annee) DO NOTHING;

  -- Boucle de sécurité : incrémente jusqu'à trouver un numéro non encore utilisé
  LOOP
    UPDATE public.cashier_piece_counters
    SET dernier_numero = public.cashier_piece_counters.dernier_numero + 1
    WHERE annee = annee_piece
    RETURNING dernier_numero INTO prochain_numero;

    candidat_piece := 'CSH1/' || annee_piece || '/' || lpad(prochain_numero::text, 5, '0');

    -- Vérification si ce numéro existe déjà dans les transactions
    SELECT EXISTS (
      SELECT 1 FROM public.cashier_transactions WHERE piece_comptable = candidat_piece
    ) INTO existe;

    IF NOT existe THEN
      NEW.piece_comptable := candidat_piece;
      EXIT;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assign_cashier_journal_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.journal_id IS NULL THEN
    SELECT j.id
      INTO NEW.journal_id
      FROM public.journals AS j
     WHERE j.sequence_prefix = 'CSH1'
       AND j.is_active;
  END IF;

  RETURN NEW;
END;
$function$;

-- ----------------------------------------------------------------------------
-- 11. TRIGGERS
-- ----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_dossiers_updated_at ON public.dossiers;
CREATE TRIGGER trg_dossiers_updated_at
  BEFORE UPDATE ON public.dossiers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_assign_piece_comptable ON public.cashier_transactions;
CREATE TRIGGER trg_assign_piece_comptable
  BEFORE INSERT ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION public.assign_piece_comptable();

DROP TRIGGER IF EXISTS trg_assign_cashier_journal_id ON public.cashier_transactions;
CREATE TRIGGER trg_assign_cashier_journal_id
  BEFORE INSERT ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION public.assign_cashier_journal_id();

DROP TRIGGER IF EXISTS trg_cashier_transactions_updated_at ON public.cashier_transactions;
CREATE TRIGGER trg_cashier_transactions_updated_at
  BEFORE UPDATE ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 12. RLS + PRIVILÈGES
-- ----------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

ALTER TABLE public.profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dossiers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashier_piece_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashier_transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs             ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.profiles               FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.dossiers               FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.journals               FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.cashier_piece_counters FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.cashier_transactions   FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.audit_logs             FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE          ON TABLE public.profiles             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON TABLE public.dossiers             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON TABLE public.journals             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON TABLE public.cashier_transactions TO authenticated;
GRANT SELECT                          ON TABLE public.audit_logs           TO authenticated;

GRANT ALL PRIVILEGES ON TABLE public.profiles,
  public.dossiers,
  public.journals,
  public.cashier_piece_counters,
  public.cashier_transactions,
  public.audit_logs
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_current_user_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_admin()               FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin()               TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 13. POLICIES RLS
-- ----------------------------------------------------------------------------

-- profiles
DROP POLICY IF EXISTS "Acces complet admin service_role" ON public.profiles;
CREATE POLICY "Acces complet admin service_role"
  ON public.profiles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS profiles_select_policy ON public.profiles;
CREATE POLICY profiles_select_policy
  ON public.profiles FOR SELECT TO authenticated
  USING (is_active = true OR id = (SELECT auth.uid()) OR public.is_admin());

DROP POLICY IF EXISTS profiles_insert_policy ON public.profiles;
CREATE POLICY profiles_insert_policy
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (id = (SELECT auth.uid()) AND role = 'employe')
  );

DROP POLICY IF EXISTS profiles_update_policy ON public.profiles;
CREATE POLICY profiles_update_policy
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()) OR public.is_admin())
  WITH CHECK (
    public.is_admin()
    OR (
      id = (SELECT auth.uid())
      AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
      AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    )
  );

-- dossiers
DROP POLICY IF EXISTS dossiers_select_authenticated ON public.dossiers;
CREATE POLICY dossiers_select_authenticated
  ON public.dossiers FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS dossiers_insert_by_role ON public.dossiers;
CREATE POLICY dossiers_insert_by_role
  ON public.dossiers FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager')
    )
  );

DROP POLICY IF EXISTS dossiers_update_by_role ON public.dossiers;
CREATE POLICY dossiers_update_by_role
  ON public.dossiers FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager')
    )
  );

DROP POLICY IF EXISTS dossiers_delete_admin_only ON public.dossiers;
CREATE POLICY dossiers_delete_admin_only
  ON public.dossiers FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = (SELECT auth.uid())
        AND profiles.role = 'admin'
    )
  );

-- journals
DROP POLICY IF EXISTS journals_select_authenticated ON public.journals;
CREATE POLICY journals_select_authenticated
  ON public.journals FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS journals_insert_management ON public.journals;
CREATE POLICY journals_insert_management
  ON public.journals FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('manager', 'comptable', 'tresorier')
    )
  );

DROP POLICY IF EXISTS journals_update_management ON public.journals;
CREATE POLICY journals_update_management
  ON public.journals FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('manager', 'comptable', 'tresorier')
    )
  )
  WITH CHECK (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('manager', 'comptable', 'tresorier')
    )
  );

DROP POLICY IF EXISTS journals_delete_admin ON public.journals;
CREATE POLICY journals_delete_admin
  ON public.journals FOR DELETE TO authenticated
  USING (public.is_admin() AND sequence_prefix <> 'CSH1');

-- cashier_piece_counters
DROP POLICY IF EXISTS cashier_piece_counters_service_role ON public.cashier_piece_counters;
CREATE POLICY cashier_piece_counters_service_role
  ON public.cashier_piece_counters FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- cashier_transactions
DROP POLICY IF EXISTS cashier_transactions_select_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_select_by_role
  ON public.cashier_transactions FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('caissier', 'caissiere', 'manager', 'comptable', 'tresorier')
    )
  );

DROP POLICY IF EXISTS cashier_transactions_insert_by_role ON public.cashier_transactions;
CREATE POLICY cashier_transactions_insert_by_role
  ON public.cashier_transactions FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('caissier', 'caissiere', 'manager')
    )
  );

DROP POLICY IF EXISTS cashier_transactions_update_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_update_own_or_admin
  ON public.cashier_transactions FOR UPDATE TO authenticated
  USING (
    public.is_admin()
    OR created_by = (SELECT auth.uid())
    OR employee_id = (SELECT auth.uid())
  )
  WITH CHECK (
    public.is_admin()
    OR created_by = (SELECT auth.uid())
    OR employee_id = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS cashier_transactions_delete_own_or_admin ON public.cashier_transactions;
CREATE POLICY cashier_transactions_delete_own_or_admin
  ON public.cashier_transactions FOR DELETE TO authenticated
  USING (
    public.is_admin()
    OR created_by = (SELECT auth.uid())
    OR employee_id = (SELECT auth.uid())
  );

-- audit_logs
DROP POLICY IF EXISTS audit_logs_admin_select ON public.audit_logs;
CREATE POLICY audit_logs_admin_select
  ON public.audit_logs FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS audit_logs_service_role_all ON public.audit_logs;
CREATE POLICY audit_logs_service_role_all
  ON public.audit_logs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMIT;