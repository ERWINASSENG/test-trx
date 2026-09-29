-- ==============================================================================
-- Recréation complète de la base DIGITAL-TRX (état au 27/09/2026, à jour)
-- À exécuter sur un projet Supabase neuf, juste après sa création
-- (auth.users, schéma auth, extensions système et event triggers Supabase
--  par défaut sont déjà en place sur tout nouveau projet).
-- ==============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- ------------------------------------------------------------------
-- Extensions
-- ------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------
-- Types énumérés
-- ------------------------------------------------------------------
CREATE TYPE public.user_role_enum AS ENUM (
  'admin', 'rh', 'manager_stock', 'caissier', 'agent',
  'manager', 'caissiere', 'employe', 'tresorier', 'comptable'
);

CREATE TYPE public.transaction_type_category AS ENUM ('entree', 'sortie');

CREATE TYPE public.cashier_transaction_status AS ENUM ('draft', 'posted', 'cancelled');

-- ------------------------------------------------------------------
-- Fonctions utilitaires (créées avant les tables qui les utilisent
-- en DEFAULT, mais leur corps n'est vérifié qu'à l'exécution)
-- ------------------------------------------------------------------
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

-- ------------------------------------------------------------------
-- Tables (ordre respectant les dépendances de clés étrangères)
-- ------------------------------------------------------------------

-- profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  role public.user_role_enum NOT NULL DEFAULT 'agent',
  department text DEFAULT 'Services Généraux',
  phone text,
  avatar_url text,
  is_active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  user_code text NOT NULL UNIQUE DEFAULT public.generate_short_id(),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_profiles_department ON public.profiles (department);
CREATE INDEX idx_profiles_email ON public.profiles (email);
CREATE INDEX idx_profiles_role ON public.profiles (role);

-- dossiers
CREATE TABLE public.dossiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no_dossier text NOT NULL UNIQUE,
  client text,
  statut text NOT NULL DEFAULT 'ouvert',
  description text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dossiers_created_by ON public.dossiers (created_by);

-- journals
CREATE TABLE public.journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL
    CHECK (type IN ('cash', 'bank', 'sale', 'purchase', 'general', 'divers')),
  ledger_type text DEFAULT '',
  sequence_prefix varchar(10) NOT NULL UNIQUE,
  default_account text NOT NULL,
  currency varchar(10) NOT NULL DEFAULT 'XAF',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_journals_is_active ON public.journals (is_active);
CREATE INDEX idx_journals_type ON public.journals (type);
CREATE INDEX idx_journals_created_by ON public.journals (created_by);

-- journal_entries (écritures des journaux autres que la Caisse Principale, ex. Banques)
CREATE TABLE public.journal_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    journal_id UUID NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
    sequence_number INTEGER NOT NULL,
    piece_comptable VARCHAR(50) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    libelle TEXT NOT NULL,
    service VARCHAR(100),
    type_description VARCHAR(150),
    category VARCHAR(20) NOT NULL CHECK (category IN ('entree', 'sortie')),
    status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
    no_dossier VARCHAR(100),
    partenaire VARCHAR(200),
    employee VARCHAR(200),
    quantity NUMERIC(10,2) DEFAULT 1,
    montant NUMERIC(15,2) NOT NULL,
    solde_apres NUMERIC(15,2),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    employee_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_journal_entries_piece UNIQUE (journal_id, piece_comptable),
    CONSTRAINT uq_journal_entries_seq UNIQUE (journal_id, sequence_number)
);
CREATE INDEX idx_journal_entries_journal_id ON public.journal_entries(journal_id);
CREATE INDEX idx_journal_entries_date ON public.journal_entries(journal_id, date ASC, sequence_number ASC);
CREATE INDEX idx_journal_entries_seq ON public.journal_entries(journal_id, sequence_number ASC);

-- cashier_piece_counters
CREATE TABLE public.cashier_piece_counters (
  annee integer PRIMARY KEY,
  dernier_numero integer NOT NULL DEFAULT 0
);

-- journal_piece_counters (compteurs atomiques par journal et par année)
CREATE TABLE public.journal_piece_counters (
  journal_id uuid NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
  annee integer NOT NULL,
  dernier_numero integer NOT NULL DEFAULT 0,
  PRIMARY KEY (journal_id, annee)
);

-- audit_logs
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_email text,
  user_role text,
  action text NOT NULL,
  entity_type text NOT NULL DEFAULT 'cashier_transaction',
  entity_id text,
  details jsonb DEFAULT '{}'::jsonb,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_user_id ON public.audit_logs (user_id);

-- cashier_transactions
CREATE TABLE public.cashier_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date text NOT NULL,
  libelle text NOT NULL,
  service text,
  type_description text,
  category public.transaction_type_category NOT NULL,
  status public.cashier_transaction_status NOT NULL DEFAULT 'draft',
  no_dossier text,
  dossier_id uuid REFERENCES public.dossiers(id),
  first_name text,
  partenaire text,
  employee text,
  employee_id uuid REFERENCES public.profiles(id),
  quantity numeric,
  montant numeric NOT NULL,
  solde_apres numeric,
  selected boolean DEFAULT false,
  created_by uuid DEFAULT auth.uid() REFERENCES public.profiles(id),
  piece_comptable text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  journal_id uuid REFERENCES public.journals(id) ON DELETE RESTRICT,
  CONSTRAINT chk_operations_requires_dossier
    CHECK (service <> 'Opérations' OR no_dossier IS NOT NULL OR dossier_id IS NOT NULL),
  CONSTRAINT chk_operations_requires_quantity
    CHECK (service <> 'Opérations' OR quantity IS NOT NULL)
);
CREATE INDEX idx_cashier_piece_comptable ON public.cashier_transactions (piece_comptable);
CREATE UNIQUE INDEX uq_cashier_transactions_piece_comptable
  ON public.cashier_transactions (piece_comptable) WHERE (piece_comptable IS NOT NULL);
CREATE INDEX idx_cashier_transactions_category ON public.cashier_transactions (category);
CREATE INDEX idx_cashier_transactions_created_by ON public.cashier_transactions (created_by);
CREATE INDEX idx_cashier_transactions_date ON public.cashier_transactions (date);
CREATE INDEX idx_cashier_transactions_dossier_id ON public.cashier_transactions (dossier_id);
CREATE INDEX idx_cashier_transactions_employee_id ON public.cashier_transactions (employee_id);
CREATE INDEX idx_cashier_transactions_journal_id ON public.cashier_transactions (journal_id);
CREATE INDEX idx_cashier_transactions_service ON public.cashier_transactions (service);
CREATE INDEX idx_cashier_transactions_status ON public.cashier_transactions (status);

-- ------------------------------------------------------------------
-- Fonctions dépendant des tables
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_current_user_role()
 RETURNS user_role_enum
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
  -- Si une pièce est déjà fournie avec sa séquence, la conserver
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

-- ------------------------------------------------------------------
-- Event trigger (RLS auto-activé sur toute nouvelle table publique)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();

-- ------------------------------------------------------------------
-- Triggers
-- ------------------------------------------------------------------
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER trg_dossiers_updated_at
  BEFORE UPDATE ON public.dossiers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_cashier_transactions_updated_at
  BEFORE UPDATE ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_assign_piece_comptable
  BEFORE INSERT ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION public.assign_piece_comptable();

CREATE TRIGGER trg_assign_cashier_journal_id
  BEFORE INSERT ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION public.assign_cashier_journal_id();

CREATE TRIGGER trg_assign_journal_entry_piece_comptable
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.assign_journal_entry_piece_comptable();

-- ------------------------------------------------------------------
-- RLS + privilèges
-- ------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashier_piece_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_piece_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashier_transactions ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.profiles, public.dossiers, public.journals,
  public.journal_entries, public.cashier_piece_counters, public.journal_piece_counters,
  public.audit_logs, public.cashier_transactions
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dossiers, public.journals TO authenticated;
GRANT SELECT ON TABLE public.audit_logs TO authenticated;

GRANT ALL PRIVILEGES ON TABLE public.profiles, public.dossiers, public.journals,
  public.journal_entries, public.cashier_piece_counters, public.journal_piece_counters,
  public.audit_logs, public.cashier_transactions
  TO service_role;

-- profiles
CREATE POLICY "Acces complet admin service_role" ON public.profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY profiles_select_policy ON public.profiles
  FOR SELECT TO authenticated
  USING (is_active = true OR id = (SELECT auth.uid()) OR public.is_admin());

CREATE POLICY profiles_insert_policy ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() OR (id = (SELECT auth.uid()) AND role = 'employe'));

CREATE POLICY profiles_update_policy ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()) OR public.is_admin())
  WITH CHECK (
    public.is_admin()
    OR (
      id = (SELECT auth.uid())
      AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
      AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    )
  );

-- dossiers (moindre privilège : admin, rôles opérationnels/comptables ou créateur)
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

CREATE POLICY dossiers_insert_by_role ON public.dossiers
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (SELECT auth.uid())
      AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager')
  ));

CREATE POLICY dossiers_update_by_role ON public.dossiers
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (SELECT auth.uid())
      AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager')
  ));

CREATE POLICY dossiers_delete_admin_only ON public.dossiers
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE profiles.id = (SELECT auth.uid()) AND profiles.role = 'admin'
  ));

-- journals: un trésorier ne gère que les journaux qu'il a créés.
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

CREATE POLICY journals_insert_management ON public.journals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND created_by = (SELECT auth.uid())
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

CREATE POLICY journals_update_management ON public.journals
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

CREATE POLICY journals_delete_admin ON public.journals
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin() AND sequence_prefix <> 'CSH1');

-- journal_entries: les écritures d'un trésorier sont limitées à ses journaux.
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
        AND EXISTS (
          SELECT 1 FROM public.journals j
          WHERE j.id = journal_entries.journal_id
            AND j.created_by = (SELECT auth.uid())
            AND j.is_active IS TRUE
            AND j.sequence_prefix <> 'CSH1'
        )
      )
    )
  );

CREATE POLICY journal_entries_update_by_role ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
        AND EXISTS (
          SELECT 1 FROM public.journals j
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
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
        AND EXISTS (
          SELECT 1 FROM public.journals j
          WHERE j.id = journal_entries.journal_id
            AND j.created_by = (SELECT auth.uid())
            AND j.sequence_prefix <> 'CSH1'
        )
      )
    )
  );

CREATE POLICY journal_entries_delete_by_role ON public.journal_entries
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'tresorier'
        )
        AND EXISTS (
          SELECT 1 FROM public.journals j
          WHERE j.id = journal_entries.journal_id
            AND j.created_by = (SELECT auth.uid())
            AND j.sequence_prefix <> 'CSH1'
        )
      )
    )
  );

CREATE POLICY journal_entries_service_role_all ON public.journal_entries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cashier_piece_counters
CREATE POLICY cashier_piece_counters_service_role ON public.cashier_piece_counters
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cashier_transactions
CREATE POLICY cashier_transactions_select_by_role ON public.cashier_transactions
  FOR SELECT TO authenticated
  USING (public.is_admin() OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.role IN ('caissier', 'caissiere', 'manager', 'comptable', 'tresorier')
  ));

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
            AND p.role = 'caissiere'
        )
      )
    )
  );

CREATE POLICY cashier_transactions_update_own_or_admin ON public.cashier_transactions
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        COALESCE(created_by, employee_id) = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
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
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'caissiere'
        )
      )
    )
  );

CREATE POLICY cashier_transactions_delete_own_or_admin ON public.cashier_transactions
  FOR DELETE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR (
        COALESCE(created_by, employee_id) = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid())
            AND p.is_active IS TRUE
            AND p.role = 'caissiere'
        )
      )
    )
  );

-- audit_logs
CREATE POLICY audit_logs_admin_select ON public.audit_logs
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY audit_logs_service_role_all ON public.audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------
-- Restrictions d'exécution des fonctions RPC de rôle
-- ------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.get_current_user_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- ------------------------------------------------------------------
-- Donnée d'amorçage : journal Caisse Principale
-- ------------------------------------------------------------------
INSERT INTO public.journals (name, type, ledger_type, sequence_prefix, default_account, currency, is_active)
VALUES ('Caisse Principale', 'cash', 'Journal des opérations de caisse', 'CSH1', '510000 Valeurs à encaisser', 'XAF', true)
ON CONFLICT (sequence_prefix) DO NOTHING;

COMMIT;