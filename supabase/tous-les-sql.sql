-- ==============================================================================
-- Bundle documentaire de tous les fichiers SQL de DIGITAL-TRX
-- Généré le 2026-09-29
--
-- Ce fichier regroupe schema, migrations et tests.
-- Ne pas exécuter ce bundle tel quel : les tests et migrations ont des
-- transactions et des dépendances qui doivent être exécutés séparément.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\schema.sql
-- ------------------------------------------------------------------------------
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

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\migrations_consolidees.sql
-- ------------------------------------------------------------------------------
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



-- ------------------------------------------------------------------------------
-- SOURCE: supabase\migrations\20260929100000_access_control_foundation.sql
-- ------------------------------------------------------------------------------
BEGIN;

CREATE TABLE public.access_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL UNIQUE
    CHECK (role_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.access_permissions (
  permission_key text PRIMARY KEY
    CHECK (permission_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_key text NOT NULL,
  action_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_sensitive boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_permissions_key_parts_match
    CHECK (permission_key = resource_key || '.' || action_key)
);

CREATE TABLE public.access_role_permissions (
  role_id uuid NOT NULL REFERENCES public.access_roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.access_permissions(permission_key) ON DELETE CASCADE,
  scope jsonb NOT NULL DEFAULT '{"type":"all","version":1}'::jsonb
    CHECK (
      jsonb_typeof(scope) = 'object'
      AND jsonb_typeof(scope->'type') = 'string'
      AND NULLIF(btrim(scope->>'type'), '') IS NOT NULL
      AND jsonb_typeof(scope->'version') = 'number'
      AND (scope->>'version')::integer >= 1
    ),
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key, scope)
);

CREATE TABLE public.access_user_roles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.access_roles(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assignment_source text NOT NULL DEFAULT 'admin'
    CHECK (assignment_source IN ('admin', 'legacy_profile')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (user_id, role_id),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE public.access_user_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.access_permissions(permission_key) ON DELETE CASCADE,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  scope jsonb NOT NULL DEFAULT '{"type":"all","version":1}'::jsonb
    CHECK (
      jsonb_typeof(scope) = 'object'
      AND jsonb_typeof(scope->'type') = 'string'
      AND NULLIF(btrim(scope->>'type'), '') IS NOT NULL
      AND jsonb_typeof(scope->'version') = 'number'
      AND (scope->>'version')::integer >= 1
    ),
  reason text NOT NULL,
  granted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT access_user_overrides_unique_scope
    UNIQUE (user_id, permission_key, scope),
  CHECK (length(trim(reason)) > 0),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE public.access_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  subject_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action_key text NOT NULL,
  role_key text,
  permission_key text,
  reason text,
  before_state jsonb,
  after_state jsonb,
  request_id text,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_access_role_permissions_permission
  ON public.access_role_permissions (permission_key, role_id);
CREATE INDEX idx_access_user_roles_role
  ON public.access_user_roles (role_id, user_id);
CREATE INDEX idx_access_user_roles_expiration
  ON public.access_user_roles (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX idx_access_user_overrides_lookup
  ON public.access_user_overrides (user_id, permission_key, expires_at);
CREATE INDEX idx_access_audit_log_subject_created
  ON public.access_audit_log (subject_user_id, created_at DESC);
CREATE INDEX idx_access_audit_log_actor_created
  ON public.access_audit_log (actor_user_id, created_at DESC);

ALTER TABLE public.access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_user_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.access_roles,
  public.access_permissions,
  public.access_role_permissions,
  public.access_user_roles,
  public.access_user_overrides,
  public.access_audit_log
FROM PUBLIC, anon, authenticated;

GRANT ALL PRIVILEGES ON TABLE
  public.access_roles,
  public.access_permissions,
  public.access_role_permissions,
  public.access_user_roles,
  public.access_user_overrides,
  public.access_audit_log
TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.access_audit_log_id_seq TO service_role;

INSERT INTO public.access_roles (role_key, label, description, is_system)
VALUES
  ('admin', 'Administrateur', 'Administration complète de la plateforme.', true),
  ('manager', 'Manager', 'Supervision des opérations et des équipes.', true),
  ('caissiere', 'Caissière', 'Opérations autorisées sur la caisse.', true),
  ('comptable', 'Comptable', 'Consultation et opérations comptables autorisées.', true),
  ('tresorier', 'Trésorier', 'Gestion des journaux dont il est propriétaire.', true),
  ('employe', 'Employé', 'Accès de base aux fonctions employé.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.access_user_roles (user_id, role_id, assignment_source)
SELECT
  p.id,
  r.id,
  'legacy_profile'
FROM public.profiles p
JOIN public.access_roles r
  ON r.role_key = CASE p.role::text
    WHEN 'caissier' THEN 'caissiere'
    WHEN 'manager_stock' THEN 'manager'
    WHEN 'agent' THEN 'employe'
    WHEN 'rh' THEN 'employe'
    ELSE p.role::text
  END
-- Preserve assignments for inactive profiles; authorization checks activity separately.
ON CONFLICT (user_id, role_id) DO NOTHING;

COMMIT;

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\migrations\20260929110000_access_control_initial_permissions.sql
-- ------------------------------------------------------------------------------
BEGIN;

INSERT INTO public.access_permissions (
  permission_key, resource_key, action_key, label, description, is_sensitive
)
VALUES
  ('apps.view', 'apps', 'view', 'Consulter les applications', 'Accéder au lanceur des modules autorisés.', false),
  ('dashboard.view', 'dashboard', 'view', 'Consulter les tableaux de bord', 'Accéder aux indicateurs autorisés.', false),
  ('profile.read', 'profile', 'read', 'Consulter son profil', 'Lire les informations de son propre profil.', false),
  ('profile.update', 'profile', 'update', 'Modifier son profil', 'Modifier les champs autorisés de son propre profil.', false),
  ('users.read', 'users', 'read', 'Consulter les utilisateurs', 'Afficher les profils collaborateurs.', true),
  ('users.create', 'users', 'create', 'Créer un utilisateur', 'Créer un compte et son profil.', true),
  ('users.update', 'users', 'update', 'Modifier un utilisateur', 'Modifier rôle, statut et informations d’un collaborateur.', true),
  ('users.delete', 'users', 'delete', 'Supprimer un utilisateur', 'Supprimer un compte utilisateur.', true),
  ('hr.read', 'hr', 'read', 'Consulter le personnel', 'Accéder aux données RH.', true),
  ('hr.manage', 'hr', 'manage', 'Gérer le personnel', 'Créer et modifier les données RH.', true),
  ('cashier.read', 'cashier', 'read', 'Consulter la caisse', 'Lire les opérations du journal de caisse.', true),
  ('cashier.create', 'cashier', 'create', 'Saisir en caisse', 'Créer des opérations dans le journal de caisse.', true),
  ('cashier.update', 'cashier', 'update', 'Modifier en caisse', 'Modifier les opérations du journal de caisse.', true),
  ('cashier.delete', 'cashier', 'delete', 'Supprimer en caisse', 'Supprimer les opérations du journal de caisse.', true),
  ('cashier.duplicate', 'cashier', 'duplicate', 'Dupliquer en caisse', 'Dupliquer des opérations de caisse.', true),
  ('cashier.status_update', 'cashier', 'status_update', 'Modifier le statut en caisse', 'Changer le statut des opérations de caisse.', true),
  ('cashier.import', 'cashier', 'import', 'Importer en caisse', 'Importer des opérations dans le journal de caisse.', true),
  ('cashier.export', 'cashier', 'export', 'Exporter la caisse', 'Exporter les données autorisées de la caisse.', true),
  ('journals.read', 'journals', 'read', 'Consulter les journaux', 'Afficher les journaux comptables.', true),
  ('journals.create', 'journals', 'create', 'Créer un journal', 'Créer un journal comptable.', true),
  ('journals.update', 'journals', 'update', 'Modifier un journal', 'Modifier les métadonnées d’un journal autorisé.', true),
  ('journals.delete', 'journals', 'delete', 'Supprimer un journal', 'Supprimer un journal autorisé.', true),
  ('journal_entries.read', 'journal_entries', 'read', 'Consulter les écritures', 'Lire les écritures d’un journal autorisé.', true),
  ('journal_entries.chart_read', 'journal_entries', 'chart_read', 'Consulter les graphiques', 'Lire les données graphiques d’un journal autorisé.', true),
  ('journal_entries.create', 'journal_entries', 'create', 'Créer une écriture', 'Créer une écriture dans un journal autorisé.', true),
  ('journal_entries.update', 'journal_entries', 'update', 'Modifier une écriture', 'Modifier une écriture dans un journal autorisé.', true),
  ('journal_entries.delete', 'journal_entries', 'delete', 'Supprimer une écriture', 'Supprimer une écriture d’un journal autorisé.', true),
  ('configuration.read', 'configuration', 'read', 'Consulter la configuration', 'Afficher les écrans de configuration autorisés.', true),
  ('configuration.manage', 'configuration', 'manage', 'Gérer la configuration', 'Modifier les réglages et journaux autorisés.', true),
  ('access.roles.read', 'access.roles', 'read', 'Consulter les rôles', 'Afficher le catalogue des rôles.', true),
  ('access.roles.manage', 'access.roles', 'manage', 'Gérer les rôles', 'Créer et modifier les rôles applicatifs.', true),
  ('access.permissions.read', 'access.permissions', 'read', 'Consulter les permissions', 'Afficher le catalogue des permissions.', true),
  ('access.permissions.assign', 'access.permissions', 'assign', 'Attribuer des permissions', 'Modifier les permissions affectées aux rôles.', true),
  ('access.users.read', 'access.users', 'read', 'Consulter les accès utilisateurs', 'Afficher les rôles et exceptions d’un utilisateur.', true),
  ('access.users.assign_roles', 'access.users', 'assign_roles', 'Attribuer des rôles', 'Affecter ou retirer des rôles à un utilisateur.', true),
  ('access.users.override', 'access.users', 'override', 'Définir une exception utilisateur', 'Ajouter une permission ou un refus individuel motivé.', true),
  ('access.audit.read', 'access.audit', 'read', 'Consulter le journal d’audit', 'Lire les changements de rôles et permissions.', true)
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive,
    updated_at = now();

WITH initial_grants(role_key, permission_key, scope) AS (
  SELECT 'admin', permission_key, '{"type":"all","version":1}'::jsonb
  FROM public.access_permissions
  UNION ALL
  SELECT role_key, permission_key, '{"type":"all","version":1}'::jsonb
  FROM (VALUES
    ('manager', 'apps.view'),
    ('manager', 'dashboard.view'),
    ('manager', 'profile.read'),
    ('manager', 'profile.update'),
    ('manager', 'cashier.read'),
    ('manager', 'journals.read'),
    ('manager', 'journal_entries.read'),
    ('manager', 'journal_entries.chart_read'),
    ('manager', 'configuration.read'),
    ('caissiere', 'apps.view'),
    ('caissiere', 'dashboard.view'),
    ('caissiere', 'profile.read'),
    ('caissiere', 'profile.update'),
    ('caissiere', 'cashier.read'),
    ('caissiere', 'cashier.create'),
    ('caissiere', 'cashier.update'),
    ('caissiere', 'cashier.delete'),
    ('caissiere', 'cashier.duplicate'),
    ('caissiere', 'cashier.status_update'),
    ('caissiere', 'cashier.import'),
    ('caissiere', 'cashier.export'),
    ('comptable', 'apps.view'),
    ('comptable', 'dashboard.view'),
    ('comptable', 'profile.read'),
    ('comptable', 'profile.update'),
    ('comptable', 'cashier.read'),
    ('comptable', 'cashier.export'),
    ('comptable', 'journals.read'),
    ('comptable', 'journal_entries.read'),
    ('comptable', 'journal_entries.chart_read'),
    ('tresorier', 'apps.view'),
    ('tresorier', 'dashboard.view'),
    ('tresorier', 'profile.read'),
    ('tresorier', 'profile.update'),
    ('tresorier', 'cashier.read'),
    ('tresorier', 'journals.read'),
    ('tresorier', 'journals.create'),
    ('tresorier', 'journal_entries.read'),
    ('tresorier', 'journal_entries.chart_read'),
    ('tresorier', 'journal_entries.create'),
    ('tresorier', 'journal_entries.update'),
    ('tresorier', 'journal_entries.delete'),
    ('tresorier', 'configuration.read'),
    ('tresorier', 'configuration.manage'),
    ('employe', 'apps.view'),
    ('employe', 'dashboard.view'),
    ('employe', 'profile.read'),
    ('employe', 'profile.update')
  ) AS grants(role_key, permission_key)
  UNION ALL
  SELECT 'tresorier', permission_key, '{"type":"owner","version":1}'::jsonb
  FROM (VALUES
    ('journals.update'),
    ('journals.delete'),
    ('journal_entries.create'),
    ('journal_entries.update'),
    ('journal_entries.delete')
  ) AS owner_scoped(permission_key)
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT roles.id, permissions.permission_key, initial_grants.scope, NULL
FROM initial_grants
JOIN public.access_roles roles ON roles.role_key = initial_grants.role_key
JOIN public.access_permissions permissions ON permissions.permission_key = initial_grants.permission_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\migrations\20260929120000_access_control_mutations.sql
-- ------------------------------------------------------------------------------
BEGIN;

CREATE OR REPLACE FUNCTION public.access_control_mutate(
  p_actor_user_id uuid,
  p_operation text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  required_permission text;
  actor_is_active boolean;
  actor_is_authorized boolean;
  target_role_id uuid;
  target_role_key text;
  target_role_is_system boolean;
  target_user_id uuid;
  target_permission_key text;
  target_scope jsonb;
  target_effect text;
  target_reason text;
  previous_state jsonb;
  next_state jsonb;
  audit_subject uuid;
BEGIN
  SELECT p.is_active
    INTO actor_is_active
  FROM public.profiles p
  WHERE p.id = p_actor_user_id;

  IF actor_is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  required_permission := CASE p_operation
    WHEN 'role.create' THEN 'access.roles.manage'
    WHEN 'role.update' THEN 'access.roles.manage'
    WHEN 'role.delete' THEN 'access.roles.manage'
    WHEN 'role.permissions.replace' THEN 'access.permissions.assign'
    WHEN 'user.role.assign' THEN 'access.users.assign_roles'
    WHEN 'user.role.revoke' THEN 'access.users.assign_roles'
    WHEN 'user.permission.override' THEN 'access.users.override'
    WHEN 'user.permission.override.revoke' THEN 'access.users.override'
    ELSE NULL
  END;

  IF required_permission IS NULL THEN
    RAISE EXCEPTION 'Unsupported access-control operation' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.access_user_roles ur
    JOIN public.access_roles r ON r.id = ur.role_id AND r.is_active IS TRUE
    JOIN public.access_role_permissions rp ON rp.role_id = r.id
    WHERE ur.user_id = p_actor_user_id
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND rp.permission_key = required_permission
      AND rp.scope->>'type' = 'all'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.access_user_overrides uo
    WHERE uo.user_id = p_actor_user_id
      AND uo.permission_key = required_permission
      AND uo.effect = 'deny'
      AND uo.scope->>'type' = 'all'
      AND (uo.expires_at IS NULL OR uo.expires_at > now())
  )
  INTO actor_is_authorized;

  IF actor_is_authorized IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Insufficient access-control permission' USING ERRCODE = '42501';
  END IF;

  target_user_id := NULLIF(payload->>'userId', '')::uuid;
  target_permission_key := NULLIF(payload->>'permissionKey', '');
  target_scope := COALESCE(payload->'scope', '{"type":"all","version":1}'::jsonb);
  target_effect := COALESCE(payload->>'effect', 'allow');
  target_reason := NULLIF(btrim(payload->>'reason'), '');

  IF jsonb_typeof(target_scope) <> 'object'
     OR COALESCE(target_scope->>'type', '') = ''
     OR target_scope->>'version' <> '1' THEN
    RAISE EXCEPTION 'Unsupported permission scope document' USING ERRCODE = '22023';
  END IF;

  CASE p_operation
    WHEN 'role.create' THEN
      target_role_key := lower(btrim(payload->>'roleKey'));
      IF target_role_key IS NULL OR target_role_key !~ '^[a-z][a-z0-9_]{1,63}$' THEN
        RAISE EXCEPTION 'Invalid role key' USING ERRCODE = '22023';
      END IF;
      IF COALESCE(length(btrim(payload->>'label')), 0) < 2 THEN
        RAISE EXCEPTION 'Role label must contain at least two characters' USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.access_roles (role_key, label, description, created_by)
      VALUES (target_role_key, btrim(payload->>'label'), COALESCE(payload->>'description', ''), p_actor_user_id)
      RETURNING id, role_key INTO target_role_id, target_role_key;

      next_state := jsonb_build_object('id', target_role_id, 'roleKey', target_role_key);
      audit_subject := NULL;

    WHEN 'role.update' THEN
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key, r.is_system
        INTO target_role_key, target_role_is_system
      FROM public.access_roles r
      WHERE r.id = target_role_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_is_system THEN
        RAISE EXCEPTION 'System role identity cannot be changed' USING ERRCODE = '42501';
      END IF;
      IF COALESCE(length(btrim(payload->>'label')), 0) < 2 THEN
        RAISE EXCEPTION 'Role label must contain at least two characters' USING ERRCODE = '22023';
      END IF;

      SELECT to_jsonb(r) INTO previous_state
      FROM public.access_roles r WHERE r.id = target_role_id;

      UPDATE public.access_roles
      SET label = btrim(payload->>'label'),
          description = COALESCE(payload->>'description', ''),
          is_active = COALESCE((payload->>'isActive')::boolean, is_active),
          updated_at = now()
      WHERE id = target_role_id
      RETURNING to_jsonb(access_roles) INTO next_state;
      audit_subject := NULL;

    WHEN 'role.delete' THEN
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key, r.is_system, to_jsonb(r)
        INTO target_role_key, target_role_is_system, previous_state
      FROM public.access_roles r
      WHERE r.id = target_role_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_is_system THEN
        RAISE EXCEPTION 'System roles cannot be deleted' USING ERRCODE = '42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.access_user_roles ur WHERE ur.role_id = target_role_id) THEN
        RAISE EXCEPTION 'Role still has user assignments' USING ERRCODE = '23503';
      END IF;

      DELETE FROM public.access_roles WHERE id = target_role_id;
      next_state := jsonb_build_object('deleted', true, 'roleKey', target_role_key);
      audit_subject := NULL;

    WHEN 'role.permissions.replace' THEN
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r
      WHERE r.id = target_role_id AND r.is_active IS TRUE
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Active role not found' USING ERRCODE = 'P0002';
      END IF;
      IF COALESCE(jsonb_typeof(payload->'grants'), '') <> 'array' THEN
        RAISE EXCEPTION 'Permission grants must be an array' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(payload->'grants') AS item
        WHERE NOT EXISTS (
          SELECT 1 FROM public.access_permissions p
          WHERE p.permission_key = item->>'permissionKey'
        )
        OR jsonb_typeof(item->'scope') <> 'object'
        OR COALESCE(item->'scope'->>'type', '') = ''
        OR item->'scope'->>'version' <> '1'
      ) THEN
        RAISE EXCEPTION 'Unknown permission or invalid scope' USING ERRCODE = '22023';
      END IF;

      IF target_role_key = 'admin' AND EXISTS (
        SELECT required_key.permission_key
        FROM (VALUES
          ('access.roles.manage'),
          ('access.permissions.assign'),
          ('access.users.assign_roles'),
          ('access.users.override'),
          ('access.audit.read')
        ) AS required_key(permission_key)
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(payload->'grants') AS item
          WHERE item->>'permissionKey' = required_key.permission_key
            AND item->'scope'->>'type' = 'all'
        )
      ) THEN
        RAISE EXCEPTION 'The administrator role must retain access-management permissions' USING ERRCODE = '42501';
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope)), '[]'::jsonb)
        INTO previous_state
      FROM public.access_role_permissions rp
      WHERE rp.role_id = target_role_id;

      DELETE FROM public.access_role_permissions WHERE role_id = target_role_id;
      INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
      SELECT target_role_id, item->>'permissionKey', item->'scope', p_actor_user_id
      FROM jsonb_array_elements(payload->'grants') AS item;

      SELECT COALESCE(jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope)), '[]'::jsonb)
        INTO next_state
      FROM public.access_role_permissions rp
      WHERE rp.role_id = target_role_id;
      audit_subject := NULL;

    WHEN 'user.role.assign' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r
      WHERE r.id = target_role_id AND r.is_active IS TRUE;

      IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = target_user_id) THEN
        RAISE EXCEPTION 'Active role or user profile not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_key <> 'admin' AND EXISTS (
        SELECT 1
        FROM public.access_user_roles ur
        JOIN public.access_roles r ON r.id = ur.role_id
        WHERE ur.user_id = target_user_id
          AND r.role_key = 'admin'
          AND (ur.expires_at IS NULL OR ur.expires_at > now())
          AND (
            SELECT count(*)
            FROM public.access_user_roles active_admins
            JOIN public.access_roles admin_roles ON admin_roles.id = active_admins.role_id
            WHERE admin_roles.role_key = 'admin'
              AND (active_admins.expires_at IS NULL OR active_admins.expires_at > now())
          ) <= 1
      ) THEN
        RAISE EXCEPTION 'Cannot replace the last administrator assignment' USING ERRCODE = '42501';
      END IF;

      DELETE FROM public.access_user_roles
      WHERE user_id = target_user_id AND role_id <> target_role_id;

      INSERT INTO public.access_user_roles (user_id, role_id, assigned_by, assignment_source, expires_at)
      VALUES (target_user_id, target_role_id, p_actor_user_id, 'admin', NULLIF(payload->>'expiresAt', '')::timestamptz)
      ON CONFLICT (user_id, role_id) DO UPDATE
      SET assigned_by = EXCLUDED.assigned_by,
          assignment_source = 'admin',
          expires_at = EXCLUDED.expires_at;

      IF target_role_key IN ('admin', 'manager', 'tresorier', 'caissiere', 'comptable', 'employe') THEN
        UPDATE public.profiles
        SET role = target_role_key::public.user_role_enum,
            updated_at = now()
        WHERE id = target_user_id;

        UPDATE auth.users
        SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
          || jsonb_build_object('role', target_role_key)
        WHERE id = target_user_id;
      END IF;

      next_state := jsonb_build_object('userId', target_user_id, 'roleKey', target_role_key, 'expiresAt', payload->'expiresAt');
      audit_subject := target_user_id;

    WHEN 'user.role.revoke' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r WHERE r.id = target_role_id;

      IF target_role_key IS NULL THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_key = 'admin' AND (
        SELECT count(*) FROM public.access_user_roles ur
        JOIN public.access_roles r ON r.id = ur.role_id
        WHERE r.role_key = 'admin' AND (ur.expires_at IS NULL OR ur.expires_at > now())
      ) <= 1 THEN
        RAISE EXCEPTION 'Cannot revoke the last administrator assignment' USING ERRCODE = '42501';
      END IF;

      DELETE FROM public.access_user_roles
      WHERE user_id = target_user_id AND role_id = target_role_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'User role assignment not found' USING ERRCODE = 'P0002';
      END IF;
      next_state := jsonb_build_object('revoked', true, 'roleKey', target_role_key);
      audit_subject := target_user_id;

    WHEN 'user.permission.override' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_permission_key := NULLIF(payload->>'permissionKey', '');
      target_effect := payload->>'effect';

      IF target_permission_key LIKE 'access.%' THEN
        RAISE EXCEPTION 'Access-management permissions cannot be overridden per user' USING ERRCODE = '42501';
      END IF;
      IF target_effect NOT IN ('allow', 'deny') OR target_reason IS NULL THEN
        RAISE EXCEPTION 'Override effect and reason are required' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = target_user_id)
         OR NOT EXISTS (SELECT 1 FROM public.access_permissions p WHERE p.permission_key = target_permission_key) THEN
        RAISE EXCEPTION 'User or permission not found' USING ERRCODE = 'P0002';
      END IF;

      SELECT to_jsonb(uo) INTO previous_state
      FROM public.access_user_overrides uo
      WHERE uo.user_id = target_user_id
        AND uo.permission_key = target_permission_key
        AND uo.scope = target_scope
      FOR UPDATE;

      INSERT INTO public.access_user_overrides (
        user_id, permission_key, effect, scope, reason, granted_by, expires_at
      )
      VALUES (
        target_user_id, target_permission_key, target_effect, target_scope,
        target_reason, p_actor_user_id, NULLIF(payload->>'expiresAt', '')::timestamptz
      )
      ON CONFLICT (user_id, permission_key, scope) DO UPDATE
      SET effect = EXCLUDED.effect,
          reason = EXCLUDED.reason,
          granted_by = EXCLUDED.granted_by,
          created_at = now(),
          expires_at = EXCLUDED.expires_at
      RETURNING to_jsonb(access_user_overrides) INTO next_state;
      audit_subject := target_user_id;

    WHEN 'user.permission.override.revoke' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'overrideId', '')::uuid;
      SELECT to_jsonb(uo), uo.permission_key INTO previous_state, target_permission_key
      FROM public.access_user_overrides uo
      WHERE uo.id = target_role_id AND uo.user_id = target_user_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'User permission override not found' USING ERRCODE = 'P0002';
      END IF;
      DELETE FROM public.access_user_overrides WHERE id = target_role_id;
      next_state := jsonb_build_object('revoked', true, 'permissionKey', target_permission_key);
      audit_subject := target_user_id;
  END CASE;

  INSERT INTO public.access_audit_log (
    actor_user_id, subject_user_id, action_key, role_key, permission_key,
    reason, before_state, after_state
  )
  VALUES (
    p_actor_user_id, audit_subject, p_operation, target_role_key, target_permission_key,
    target_reason, previous_state, next_state
  );

  RETURN COALESCE(next_state, '{}'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.access_control_mutate(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.access_control_mutate(uuid, text, jsonb) TO service_role;

COMMIT;

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\tests\access_control_rls.test.sql
-- ------------------------------------------------------------------------------
BEGIN;

SELECT plan(12);

SELECT ok(
  NOT has_table_privilege('anon', 'public.access_roles', 'select,insert,update,delete'),
  'anon cannot access the access role catalog directly'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.access_roles', 'select,insert,update,delete'),
  'authenticated cannot access the access role catalog directly'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.access_role_permissions', 'select,insert,update,delete'),
  'authenticated cannot mutate role permissions directly'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.access_user_overrides', 'select,insert,update,delete'),
  'authenticated cannot mutate user overrides directly'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.access_audit_log', 'select,insert,update,delete'),
  'authenticated cannot read or write access audit directly'
);
SELECT ok(
  has_function_privilege('service_role', 'public.access_control_mutate(uuid,text,jsonb)', 'execute'),
  'service_role can execute the audited access mutation RPC'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.access_control_mutate(uuid,text,jsonb)', 'execute'),
  'authenticated cannot execute the access mutation RPC'
);

SELECT is(
  (SELECT count(*)::integer FROM public.access_roles WHERE is_system IS TRUE),
  6,
  'the six canonical system roles are seeded'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.access_permissions WHERE permission_key = 'access.roles.manage'),
  'role management permission is catalogued'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.access_permissions WHERE permission_key = 'cashier.create'),
  'cashier create permission is catalogued'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.access_role_permissions rp
    JOIN public.access_roles r ON r.id = rp.role_id
    WHERE r.role_key = 'tresorier'
      AND rp.permission_key = 'journal_entries.create'
      AND rp.scope->>'type' = 'owner'
  ),
  'treasurer journal entry creation is owner scoped'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.access_role_permissions rp
    JOIN public.access_roles r ON r.id = rp.role_id
    WHERE r.role_key = 'tresorier'
      AND rp.permission_key = 'cashier.create'
  ),
  'treasurer has no native cashier create permission'
);

SELECT * FROM finish();
ROLLBACK;

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\tests\financial_access_rls.test.sql
-- ------------------------------------------------------------------------------
BEGIN;

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10',
  'rls-inactive@example.test',
  '{"provider":"email","role":"employe"}'::jsonb,
  '{}'::jsonb
);

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c',
  'rls-active@example.test',
  '{"provider":"email","role":"manager"}'::jsonb,
  '{}'::jsonb
);

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  'c0a2e7a1-47d9-4c4f-85a8-0e36c3be1a72',
  'rls-employee@example.test',
  '{"provider":"email","role":"employe"}'::jsonb,
  '{}'::jsonb
);

UPDATE public.profiles
SET is_active = false
WHERE id = 'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10';

INSERT INTO public.journals (id, name, type, sequence_prefix, default_account, currency)
VALUES (
  'c610e774-6748-4b24-8aa3-ef08a649267e',
  'Financial access RLS test',
  'bank',
  'TSTSEC2026',
  'TEST',
  'XAF'
);

SELECT plan(15);

SELECT ok(
  NOT has_table_privilege('anon', 'public.cashier_transactions', 'select,insert,update,delete'),
  'anon has no direct Data API privileges on cashier transactions'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.cashier_transactions', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on cashier transactions'
);
SELECT ok(
  NOT has_table_privilege('anon', 'public.journal_entries', 'select,insert,update,delete'),
  'anon has no direct Data API privileges on journal entries'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.journal_entries', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on journal entries'
);
SELECT ok(
  has_function_privilege('authenticated', 'public.is_active_user()', 'execute'),
  'authenticated can evaluate the active-user policy helper'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = 'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10';

SELECT is(public.is_active_user(), false, 'inactive profile fails the active-user check');
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'f72c04ee-297b-4b2a-a8cf-1f5d47d08a10'),
  1,
  'inactive user can read only their own profile for session recovery'
);
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c'),
  0,
  'inactive user cannot read another profile'
);
SELECT is(
  (SELECT count(*)::integer FROM public.journals WHERE id = 'c610e774-6748-4b24-8aa3-ef08a649267e'),
  0,
  'inactive user cannot read journals'
);

SET LOCAL request.jwt.claim.sub = 'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c';

SELECT is(public.is_active_user(), true, 'active profile passes the active-user check');
SELECT is(
  (SELECT count(*)::integer FROM public.journals WHERE id = 'c610e774-6748-4b24-8aa3-ef08a649267e'),
  1,
  'active manager can read journals through the intended policy'
);

SET LOCAL request.jwt.claim.sub = 'c0a2e7a1-47d9-4c4f-85a8-0e36c3be1a72';

SELECT is(public.is_active_user(), true, 'active employee passes the active-user check');
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'c0a2e7a1-47d9-4c4f-85a8-0e36c3be1a72'),
  1,
  'active employee can read their own profile'
);
SELECT is(
  (SELECT count(*)::integer FROM public.profiles WHERE id = 'a13f9a5d-8167-4b5a-b75b-36a2f86eb12c'),
  0,
  'active employee cannot read another profile'
);
SELECT is(
  (SELECT count(*)::integer FROM public.journals WHERE id = 'c610e774-6748-4b24-8aa3-ef08a649267e'),
  0,
  'active employee cannot read journals'
);

SELECT * FROM finish();
ROLLBACK;

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\tests\journal_ownership_rls.test.sql
-- ------------------------------------------------------------------------------
BEGIN;

INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner-a@example.test', '{"provider":"email","role":"tresorier"}'::jsonb, '{}'::jsonb),
  ('22222222-2222-4222-8222-222222222222', 'owner-b@example.test', '{"provider":"email","role":"tresorier"}'::jsonb, '{}'::jsonb),
  ('33333333-3333-4333-8333-333333333333', 'cashier@example.test', '{"provider":"email","role":"caissiere"}'::jsonb, '{}'::jsonb),
  ('44444444-4444-4444-8444-444444444444', 'manager@example.test', '{"provider":"email","role":"manager"}'::jsonb, '{}'::jsonb),
  ('55555555-5555-4555-8555-555555555555', 'admin@example.test', '{"provider":"email","role":"admin"}'::jsonb, '{}'::jsonb);

UPDATE public.profiles
SET role = 'tresorier', is_active = true
WHERE id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

UPDATE public.profiles
SET role = 'caissiere', is_active = true
WHERE id = '33333333-3333-4333-8333-333333333333';

UPDATE public.profiles
SET role = 'manager', is_active = true
WHERE id = '44444444-4444-4444-8444-444444444444';

UPDATE public.profiles
SET role = 'admin', is_active = true
WHERE id = '55555555-5555-4555-8555-555555555555';

INSERT INTO public.journals (id, name, type, sequence_prefix, default_account, currency, created_by)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'Owner A journal', 'bank', 'OWNA', 'TEST', 'XAF', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Owner B journal', 'bank', 'OWNB', 'TEST', 'XAF', '22222222-2222-4222-8222-222222222222')
ON CONFLICT (sequence_prefix) DO NOTHING;

INSERT INTO public.journals (id, name, type, ledger_type, sequence_prefix, default_account, currency, created_by)
SELECT
  'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
  'Caisse Principale',
  'cash',
  'Journal des opérations de caisse',
  'CSH1',
  'TEST',
  'XAF',
  '11111111-1111-4111-8111-111111111111'
WHERE NOT EXISTS (SELECT 1 FROM public.journals WHERE sequence_prefix = 'CSH1');

UPDATE public.journals
SET created_by = '11111111-1111-4111-8111-111111111111'
WHERE sequence_prefix = 'CSH1';

INSERT INTO public.journal_entries (
  id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
)
VALUES (
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  1,
  'OWNB/2026/00001',
  CURRENT_DATE,
  'Owner B fixture',
  'entree',
  'draft',
  100,
  '22222222-2222-4222-8222-222222222222'
);

SELECT plan(15);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.journal_entries', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on journal entries'
);
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.cashier_transactions', 'select,insert,update,delete'),
  'authenticated has no direct Data API privileges on cashier transactions'
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.journals, public.journal_entries, public.cashier_transactions TO authenticated;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';

SELECT results_eq(
  $$INSERT INTO public.journal_entries (
      id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
    )
    VALUES (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      1,
      'OWNA/2026/00001',
      CURRENT_DATE,
      'Owner A write',
      'entree',
      'draft',
      100,
      '11111111-1111-4111-8111-111111111111'
    )
    RETURNING journal_id::text$$,
  ARRAY['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1']::text[],
  'a treasurer can insert into their own journal'
);

SELECT throws_ok(
  $$INSERT INTO public.journal_entries (
      id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
    )
    VALUES (
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      2,
      'OWNB/2026/00002',
      CURRENT_DATE,
      'Unauthorized cross-journal write',
      'entree',
      'draft',
      100,
      '11111111-1111-4111-8111-111111111111'
    )$$,
  '42501',
  NULL,
  'a treasurer cannot insert into another treasurer journal'
);

SELECT throws_ok(
  $$INSERT INTO public.journal_entries (
      id, journal_id, sequence_number, piece_comptable, date, libelle, category, status, montant, created_by
    )
    SELECT
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee7', id, 1, 'CSH1/2026/00001', CURRENT_DATE,
      'Unauthorized CSH1 write', 'entree', 'draft', 100, '11111111-1111-4111-8111-111111111111'
    FROM public.journals WHERE sequence_prefix = 'CSH1'$$,
  '42501',
  NULL,
  'a treasurer cannot insert into CSH1 even if its owner id matches'
);

SELECT is_empty(
  $$UPDATE public.journal_entries SET libelle = 'Unauthorized update'
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4' RETURNING id$$,
  'a treasurer cannot update an entry in another journal'
);
SELECT results_eq(
  $$SELECT libelle FROM public.journal_entries WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'$$,
  ARRAY['Owner B fixture']::text[],
  'the denied cross-journal update leaves the entry unchanged'
);
SELECT is_empty(
  $$DELETE FROM public.journal_entries WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4' RETURNING id$$,
  'a treasurer cannot delete an entry in another journal'
);
SELECT results_eq(
  $$SELECT libelle FROM public.journal_entries WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4'$$,
  ARRAY['Owner B fixture']::text[],
  'the denied cross-journal delete leaves the entry unchanged'
);
SELECT is_empty(
  $$UPDATE public.journals SET name = 'Unauthorized journal update'
    WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2' RETURNING id$$,
  'a treasurer cannot update another treasurer journal'
);
SELECT results_eq(
  $$SELECT name FROM public.journals WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'$$,
  ARRAY['Owner B journal']::text[],
  'the denied journal update leaves its metadata unchanged'
);

SELECT throws_ok(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff1', CURRENT_DATE::text, 'Treasurer cash write',
      'entree', 100, '11111111-1111-4111-8111-111111111111'
    )$$,
  '42501',
  NULL,
  'a treasurer cannot write to the cash journal'
);

SET LOCAL request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SELECT results_eq(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff2', CURRENT_DATE::text, 'Cashier cash write',
      'entree', 100, '33333333-3333-4333-8333-333333333333'
    )
    RETURNING created_by::text$$,
  ARRAY['33333333-3333-4333-8333-333333333333']::text[],
  'a caissiere can write to the cash journal'
);

SET LOCAL request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';
SELECT throws_ok(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff3', CURRENT_DATE::text, 'Manager cash write',
      'entree', 100, '44444444-4444-4444-8444-444444444444'
    )$$,
  '42501',
  NULL,
  'a manager cannot write to the cash journal'
);

SET LOCAL request.jwt.claim.sub = '55555555-5555-4555-8555-555555555555';
SELECT results_eq(
  $$INSERT INTO public.cashier_transactions (id, date, libelle, category, montant, created_by)
    VALUES (
      'ffffffff-ffff-4fff-8fff-fffffffffff4', CURRENT_DATE::text, 'Admin cash write',
      'entree', 100, '55555555-5555-4555-8555-555555555555'
    )
    RETURNING created_by::text$$,
  ARRAY['55555555-5555-4555-8555-555555555555']::text[],
  'an admin can write to the cash journal'
);

SELECT * FROM finish();
ROLLBACK;

-- ------------------------------------------------------------------------------
-- SOURCE: supabase\tests\rls_policies.sql
-- ------------------------------------------------------------------------------
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


