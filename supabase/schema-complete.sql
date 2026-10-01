-- DIGITAL-TRX canonical database schema
-- Generated from the application code and the consolidated SQL source.
-- This file creates structure, functions, triggers, indexes, RLS and access-control seeds.
-- It intentionally excludes demo data and pgTAP fixtures.
-- Supabase auth.users/auth schema must already exist.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN
  CREATE TYPE public.user_role_enum AS ENUM (
    'admin', 'rh', 'manager_stock', 'caissier', 'agent',
    'manager', 'caissiere', 'employe', 'tresorier', 'comptable'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.transaction_type_category AS ENUM ('entree', 'sortie');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.cashier_transaction_status AS ENUM ('draft', 'posted', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.generate_short_id()
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE chars text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; result text := '';
BEGIN
  FOR i IN 1..8 LOOP result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1); END LOOP;
  RETURN result;
END; $$;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  first_name text NOT NULL DEFAULT '',
  last_name text NOT NULL DEFAULT '',
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

CREATE TABLE public.dossiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  no_dossier text NOT NULL UNIQUE,
  client text,
  statut text NOT NULL DEFAULT 'ouvert',
  description text,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('cash', 'bank', 'sale', 'purchase', 'general', 'divers')),
  ledger_type text DEFAULT '',
  sequence_prefix varchar(10) NOT NULL UNIQUE,
  default_account text NOT NULL,
  currency varchar(10) NOT NULL DEFAULT 'XAF',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  piece_comptable varchar(50) NOT NULL,
  date date NOT NULL DEFAULT current_date,
  libelle text NOT NULL,
  service varchar(100),
  type_description varchar(150),
  category varchar(20) NOT NULL CHECK (category IN ('entree', 'sortie')),
  status varchar(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  no_dossier varchar(100),
  partenaire varchar(200),
  employee varchar(200),
  quantity numeric(10,2) DEFAULT 1,
  montant numeric(15,2) NOT NULL,
  solde_apres numeric(15,2),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_journal_entries_piece UNIQUE (journal_id, piece_comptable),
  CONSTRAINT uq_journal_entries_seq UNIQUE (journal_id, sequence_number)
);

CREATE TABLE public.cashier_piece_counters (
  annee integer PRIMARY KEY,
  dernier_numero integer NOT NULL DEFAULT 0
);

CREATE TABLE public.journal_piece_counters (
  journal_id uuid NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
  annee integer NOT NULL,
  dernier_numero integer NOT NULL DEFAULT 0,
  PRIMARY KEY (journal_id, annee)
);

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

CREATE TABLE public.cashier_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date text NOT NULL,
  libelle text NOT NULL,
  service text,
  type_description text,
  category public.transaction_type_category NOT NULL,
  status public.cashier_transaction_status NOT NULL DEFAULT 'draft',
  no_dossier text,
  dossier_id uuid REFERENCES public.dossiers(id) ON DELETE SET NULL,
  first_name text,
  partenaire text,
  employee text,
  employee_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  quantity numeric,
  montant numeric NOT NULL,
  solde_apres numeric,
  selected boolean DEFAULT false,
  created_by uuid DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  piece_comptable text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  journal_id uuid REFERENCES public.journals(id) ON DELETE RESTRICT,
  CONSTRAINT chk_operations_requires_dossier CHECK (service <> 'Opérations' OR no_dossier IS NOT NULL OR dossier_id IS NOT NULL),
  CONSTRAINT chk_operations_requires_quantity CHECK (service <> 'Opérations' OR quantity IS NOT NULL)
);

CREATE TABLE public.access_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL UNIQUE CHECK (role_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.access_permissions (
  permission_key text PRIMARY KEY CHECK (permission_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_key text NOT NULL,
  action_key text NOT NULL,
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_sensitive boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_permissions_key_parts_match CHECK (permission_key = resource_key || '.' || action_key)
);

CREATE TABLE public.access_role_permissions (
  role_id uuid NOT NULL REFERENCES public.access_roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.access_permissions(permission_key) ON DELETE CASCADE,
  scope jsonb NOT NULL DEFAULT '{"type":"all","version":1}'::jsonb,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key, scope),
  CHECK (jsonb_typeof(scope) = 'object' AND jsonb_typeof(scope->'type') = 'string' AND NULLIF(btrim(scope->>'type'), '') IS NOT NULL AND jsonb_typeof(scope->'version') = 'number' AND (scope->>'version')::integer >= 1)
);

CREATE TABLE public.access_user_roles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.access_roles(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assignment_source text NOT NULL DEFAULT 'admin' CHECK (assignment_source IN ('admin', 'legacy_profile')),
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
  scope jsonb NOT NULL DEFAULT '{"type":"all","version":1}'::jsonb,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  granted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (user_id, permission_key, scope),
  CHECK (jsonb_typeof(scope) = 'object' AND jsonb_typeof(scope->'type') = 'string' AND jsonb_typeof(scope->'version') = 'number' AND (scope->>'version')::integer >= 1),
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

CREATE INDEX idx_profiles_department ON public.profiles (department);
CREATE INDEX idx_profiles_email ON public.profiles (email);
CREATE INDEX idx_profiles_role ON public.profiles (role);
CREATE INDEX idx_dossiers_created_by ON public.dossiers (created_by);
CREATE INDEX idx_journals_is_active ON public.journals (is_active);
CREATE INDEX idx_journals_type ON public.journals (type);
CREATE INDEX idx_journals_created_by ON public.journals (created_by);
CREATE INDEX idx_journal_entries_journal_id ON public.journal_entries (journal_id);
CREATE INDEX idx_journal_entries_date ON public.journal_entries (journal_id, date ASC, sequence_number ASC);
CREATE INDEX idx_journal_entries_seq ON public.journal_entries (journal_id, sequence_number ASC);
CREATE INDEX idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_logs_user_id ON public.audit_logs (user_id);
CREATE INDEX idx_cashier_piece_comptable ON public.cashier_transactions (piece_comptable);
CREATE UNIQUE INDEX uq_cashier_transactions_piece_comptable ON public.cashier_transactions (piece_comptable) WHERE piece_comptable IS NOT NULL;
CREATE INDEX idx_cashier_transactions_category ON public.cashier_transactions (category);
CREATE INDEX idx_cashier_transactions_created_by ON public.cashier_transactions (created_by);
CREATE INDEX idx_cashier_transactions_date ON public.cashier_transactions (date);
CREATE INDEX idx_cashier_transactions_dossier_id ON public.cashier_transactions (dossier_id);
CREATE INDEX idx_cashier_transactions_employee_id ON public.cashier_transactions (employee_id);
CREATE INDEX idx_cashier_transactions_journal_id ON public.cashier_transactions (journal_id);
CREATE INDEX idx_cashier_transactions_service ON public.cashier_transactions (service);
CREATE INDEX idx_cashier_transactions_status ON public.cashier_transactions (status);
CREATE INDEX idx_access_role_permissions_permission ON public.access_role_permissions (permission_key, role_id);
CREATE INDEX idx_access_user_roles_role ON public.access_user_roles (role_id, user_id);
CREATE INDEX idx_access_user_roles_expiration ON public.access_user_roles (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_access_user_overrides_lookup ON public.access_user_overrides (user_id, permission_key, expires_at);
CREATE INDEX idx_access_audit_log_subject_created ON public.access_audit_log (subject_user_id, created_at DESC);
CREATE INDEX idx_access_audit_log_actor_created ON public.access_audit_log (actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.is_active_user()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE);
$$;

CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS public.user_role_enum LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.get_current_user_role() = 'admin';
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE requested_role text; safe_role public.user_role_enum;
BEGIN
  requested_role := COALESCE(new.raw_app_meta_data->>'role', 'employe');
  BEGIN safe_role := requested_role::public.user_role_enum;
  EXCEPTION WHEN invalid_text_representation THEN safe_role := 'employe'; END;
  INSERT INTO public.profiles (id, email, first_name, last_name, role, department, phone)
  VALUES (new.id, new.email, COALESCE(new.raw_user_meta_data->>'first_name',''), COALESCE(new.raw_user_meta_data->>'last_name',''), safe_role, COALESCE(new.raw_user_meta_data->>'department','Services Généraux'), COALESCE(new.raw_user_meta_data->>'phone',''))
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role, updated_at = now();
  RETURN new;
END; $$;

CREATE OR REPLACE FUNCTION public.assign_cashier_journal_id()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.journal_id IS NULL THEN SELECT j.id INTO NEW.journal_id FROM public.journals j WHERE j.sequence_prefix = 'CSH1' AND j.is_active; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.assign_piece_comptable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE annee_piece integer; prochain_numero integer; candidat_piece text;
BEGIN
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' THEN RETURN NEW; END IF;
  annee_piece := COALESCE(NULLIF(substring(NEW.date from '\d{4}$'), '')::int, EXTRACT(YEAR FROM now())::int);
  INSERT INTO public.cashier_piece_counters (annee) VALUES (annee_piece) ON CONFLICT DO NOTHING;
  LOOP
    UPDATE public.cashier_piece_counters SET dernier_numero = dernier_numero + 1 WHERE annee = annee_piece RETURNING dernier_numero INTO prochain_numero;
    candidat_piece := 'CSH1/' || annee_piece || '/' || lpad(prochain_numero::text, 5, '0');
    IF NOT EXISTS (SELECT 1 FROM public.cashier_transactions WHERE piece_comptable = candidat_piece) THEN NEW.piece_comptable := candidat_piece; EXIT; END IF;
  END LOOP;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.assign_journal_entry_piece_comptable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prefix text; annee_piece integer; prochain_num integer; candidat text;
BEGIN
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' AND NEW.sequence_number IS NOT NULL AND NEW.sequence_number > 0 THEN RETURN NEW; END IF;
  SELECT COALESCE(sequence_prefix, 'JRNL') INTO prefix FROM public.journals WHERE id = NEW.journal_id;
  annee_piece := COALESCE(NULLIF(substring(NEW.date::text from '^\d{4}'), '')::int, EXTRACT(YEAR FROM now())::int);
  INSERT INTO public.journal_piece_counters (journal_id, annee) VALUES (NEW.journal_id, annee_piece) ON CONFLICT DO NOTHING;
  LOOP
    UPDATE public.journal_piece_counters SET dernier_numero = dernier_numero + 1 WHERE journal_id = NEW.journal_id AND annee = annee_piece RETURNING dernier_numero INTO prochain_num;
    candidat := COALESCE(prefix, 'JRNL') || '/' || annee_piece || '/' || lpad(prochain_num::text, 5, '0');
    IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE journal_id = NEW.journal_id AND piece_comptable = candidat) THEN NEW.sequence_number := prochain_num; NEW.piece_comptable := candidat; EXIT; END IF;
  END LOOP;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.write_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE command_row record;
BEGIN
  FOR command_row IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table', 'partitioned table')
  LOOP
    IF command_row.schema_name = 'public' THEN
      BEGIN
        EXECUTE format('ALTER TABLE IF EXISTS %s ENABLE ROW LEVEL SECURITY', command_row.object_identity);
      EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'Unable to enable RLS automatically on %', command_row.object_identity;
      END;
    END IF;
  END LOOP;
END; $$;

DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.write_updated_at();
CREATE TRIGGER trg_dossiers_updated_at BEFORE UPDATE ON public.dossiers FOR EACH ROW EXECUTE FUNCTION public.write_updated_at();
CREATE TRIGGER trg_cashier_transactions_updated_at BEFORE UPDATE ON public.cashier_transactions FOR EACH ROW EXECUTE FUNCTION public.write_updated_at();
CREATE TRIGGER trg_assign_piece_comptable BEFORE INSERT ON public.cashier_transactions FOR EACH ROW EXECUTE FUNCTION public.assign_piece_comptable();
CREATE TRIGGER trg_assign_cashier_journal_id BEFORE INSERT ON public.cashier_transactions FOR EACH ROW EXECUTE FUNCTION public.assign_cashier_journal_id();
CREATE TRIGGER trg_assign_journal_entry_piece_comptable BEFORE INSERT ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION public.assign_journal_entry_piece_comptable();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dossiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashier_piece_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_piece_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashier_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_user_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.access_roles, public.access_permissions, public.access_role_permissions, public.access_user_roles, public.access_user_overrides, public.access_audit_log FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.access_roles, public.access_permissions, public.access_role_permissions, public.access_user_roles, public.access_user_overrides, public.access_audit_log TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.access_audit_log_id_seq TO service_role;
REVOKE ALL PRIVILEGES ON TABLE public.journal_entries, public.cashier_transactions FROM anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.profiles, public.dossiers, public.journals, public.journal_entries, public.cashier_piece_counters, public.journal_piece_counters, public.audit_logs, public.cashier_transactions TO service_role;

CREATE POLICY profiles_service_role_all ON public.profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY profiles_select_self_or_admin ON public.profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()) OR (public.is_active_user() AND public.is_admin()));
CREATE POLICY profiles_update_self_or_admin ON public.profiles FOR UPDATE TO authenticated USING (public.is_active_user() AND (id = (SELECT auth.uid()) OR public.is_admin())) WITH CHECK (public.is_active_user() AND (public.is_admin() OR (id = (SELECT auth.uid()) AND role = public.get_current_user_role())));
CREATE POLICY dossiers_select_by_role ON public.dossiers FOR SELECT TO authenticated USING (public.is_active_user() AND (public.is_admin() OR created_by = (SELECT auth.uid()) OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role IN ('caissier','caissiere','manager','tresorier','comptable','rh'))));
CREATE POLICY dossiers_write_by_role ON public.dossiers FOR INSERT TO authenticated WITH CHECK (public.is_active_user() AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role IN ('caissier','caissiere','manager'))));
CREATE POLICY dossiers_update_by_role ON public.dossiers FOR UPDATE TO authenticated USING (public.is_active_user() AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role IN ('caissier','caissiere','manager')))) WITH CHECK (public.is_active_user());
CREATE POLICY dossiers_delete_admin_only ON public.dossiers FOR DELETE TO authenticated USING (public.is_active_user() AND public.is_admin());
CREATE POLICY journals_select_by_role ON public.journals FOR SELECT TO authenticated USING (public.is_active_user() AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role IN ('tresorier','manager'))));
CREATE POLICY journals_insert_owner ON public.journals FOR INSERT TO authenticated WITH CHECK (public.is_active_user() AND created_by = (SELECT auth.uid()) AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'tresorier')));
CREATE POLICY journals_update_owner ON public.journals FOR UPDATE TO authenticated USING (public.is_active_user() AND (public.is_admin() OR (created_by = (SELECT auth.uid()) AND (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid())) = 'tresorier'))) WITH CHECK (public.is_active_user());
CREATE POLICY journals_delete_admin ON public.journals FOR DELETE TO authenticated USING (public.is_active_user() AND public.is_admin() AND sequence_prefix <> 'CSH1');
CREATE POLICY journal_entries_select_by_role ON public.journal_entries FOR SELECT TO authenticated USING (public.is_active_user() AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role IN ('tresorier','manager'))));
CREATE POLICY journal_entries_insert_owner ON public.journal_entries FOR INSERT TO authenticated WITH CHECK (public.is_active_user() AND (public.is_admin() OR (created_by = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.journals j WHERE j.id = journal_entries.journal_id AND j.created_by = (SELECT auth.uid()) AND j.is_active AND j.sequence_prefix <> 'CSH1'))));
CREATE POLICY journal_entries_update_owner ON public.journal_entries FOR UPDATE TO authenticated USING (public.is_active_user() AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.journals j WHERE j.id = journal_entries.journal_id AND j.created_by = (SELECT auth.uid()) AND (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid())) = 'tresorier'))) WITH CHECK (public.is_active_user());
CREATE POLICY journal_entries_delete_owner ON public.journal_entries FOR DELETE TO authenticated USING (public.is_active_user() AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.journals j WHERE j.id = journal_entries.journal_id AND j.created_by = (SELECT auth.uid()) AND (SELECT p.role FROM public.profiles p WHERE p.id = (SELECT auth.uid())) = 'tresorier')));
CREATE POLICY cashier_transactions_select_by_role ON public.cashier_transactions FOR SELECT TO authenticated USING (public.is_active_user() AND (public.is_admin() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role IN ('caissier','caissiere','manager','comptable','tresorier'))));
CREATE POLICY cashier_transactions_insert_own ON public.cashier_transactions FOR INSERT TO authenticated WITH CHECK (public.is_active_user() AND (public.is_admin() OR (created_by = (SELECT auth.uid()) AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'caissiere'))));
CREATE POLICY cashier_transactions_update_own ON public.cashier_transactions FOR UPDATE TO authenticated USING (public.is_active_user() AND (public.is_admin() OR COALESCE(created_by, employee_id) = (SELECT auth.uid()))) WITH CHECK (public.is_active_user());
CREATE POLICY cashier_transactions_delete_own ON public.cashier_transactions FOR DELETE TO authenticated USING (public.is_active_user() AND (public.is_admin() OR COALESCE(created_by, employee_id) = (SELECT auth.uid())));
CREATE POLICY audit_logs_admin_select ON public.audit_logs FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY audit_logs_service_role_all ON public.audit_logs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_roles_service_role_all ON public.access_roles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_permissions_service_role_all ON public.access_permissions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_role_permissions_service_role_all ON public.access_role_permissions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_user_roles_service_role_all ON public.access_user_roles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_user_overrides_service_role_all ON public.access_user_overrides FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_audit_log_service_role_all ON public.access_audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.access_roles (role_key, label, description, is_system) VALUES
 ('admin','Administrateur','Administration complète de la plateforme.',true),
 ('manager','Manager','Supervision des opérations et des équipes.',true),
 ('caissiere','Caissière','Opérations autorisées sur la caisse.',true),
 ('comptable','Comptable','Consultation et opérations comptables autorisées.',true),
 ('tresorier','Trésorier','Gestion des journaux dont il est propriétaire.',true),
 ('employe','Employé','Accès de base aux fonctions employé.',true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.access_permissions (permission_key, resource_key, action_key, label, description, is_sensitive)
SELECT v.permission_key, split_part(v.permission_key,'.',1), split_part(v.permission_key,'.',2), v.label, v.description, v.is_sensitive
FROM (VALUES
 ('apps.view','Consulter les applications','Accéder au lanceur des modules autorisés.',false),
 ('dashboard.view','Consulter les tableaux de bord','Accéder aux indicateurs autorisés.',false),
 ('profile.read','Consulter son profil','Lire les informations de son propre profil.',false),
 ('profile.update','Modifier son profil','Modifier les champs autorisés de son propre profil.',false),
 ('users.read','Consulter les utilisateurs','Afficher les profils collaborateurs.',true),
 ('users.create','Créer un utilisateur','Créer un compte et son profil.',true),
 ('users.update','Modifier un utilisateur','Modifier un collaborateur.',true),
 ('users.delete','Supprimer un utilisateur','Supprimer un compte utilisateur.',true),
 ('hr.read','Consulter le personnel','Accéder aux données RH.',true),
 ('hr.manage','Gérer le personnel','Créer et modifier les données RH.',true),
 ('cashier.read','Consulter la caisse','Lire les opérations de caisse.',true),
 ('cashier.create','Saisir en caisse','Créer des opérations de caisse.',true),
 ('cashier.update','Modifier en caisse','Modifier les opérations de caisse.',true),
 ('cashier.delete','Supprimer en caisse','Supprimer les opérations de caisse.',true),
 ('cashier.duplicate','Dupliquer en caisse','Dupliquer des opérations.',true),
 ('cashier.status_update','Modifier le statut en caisse','Changer le statut.',true),
 ('cashier.import','Importer en caisse','Importer des opérations.',true),
 ('cashier.export','Exporter la caisse','Exporter les opérations.',true),
 ('journals.read','Consulter les journaux','Afficher les journaux comptables.',true),
 ('journals.create','Créer un journal','Créer un journal comptable.',true),
 ('journals.update','Modifier un journal','Modifier un journal autorisé.',true),
 ('journals.delete','Supprimer un journal','Supprimer un journal autorisé.',true),
 ('journal_entries.read','Consulter les écritures','Lire les écritures.',true),
 ('journal_entries.chart_read','Consulter les graphiques','Lire les graphiques.',true),
 ('journal_entries.create','Créer une écriture','Créer une écriture.',true),
 ('journal_entries.update','Modifier une écriture','Modifier une écriture.',true),
 ('journal_entries.delete','Supprimer une écriture','Supprimer une écriture.',true),
 ('configuration.read','Consulter la configuration','Afficher la configuration.',true),
 ('configuration.manage','Gérer la configuration','Modifier la configuration.',true),
 ('access.roles.read','Consulter les rôles','Afficher les rôles.',true),
 ('access.roles.manage','Gérer les rôles','Gérer les rôles.',true),
 ('access.permissions.read','Consulter les permissions','Afficher les permissions.',true),
 ('access.permissions.assign','Attribuer des permissions','Modifier les grants.',true),
 ('access.users.read','Consulter les accès utilisateurs','Afficher les accès.',true),
 ('access.users.assign_roles','Attribuer des rôles','Affecter des rôles.',true),
 ('access.users.override','Définir une exception utilisateur','Ajouter une exception.',true),
 ('access.audit.read','Consulter le journal d’audit','Lire les changements.',true)
) AS v(permission_key,label,description,is_sensitive)
ON CONFLICT (permission_key) DO UPDATE SET label=EXCLUDED.label, description=EXCLUDED.description, is_sensitive=EXCLUDED.is_sensitive;

WITH grants(role_key, permission_key, scope) AS (
  SELECT 'admin', permission_key, '{"type":"all","version":1}'::jsonb FROM public.access_permissions
  UNION ALL SELECT * FROM (VALUES
   ('manager','apps.view'),('manager','dashboard.view'),('manager','profile.read'),('manager','profile.update'),('manager','cashier.read'),('manager','journals.read'),('manager','journal_entries.read'),('manager','journal_entries.chart_read'),('manager','configuration.read'),
   ('caissiere','apps.view'),('caissiere','dashboard.view'),('caissiere','profile.read'),('caissiere','profile.update'),('caissiere','cashier.read'),('caissiere','cashier.create'),('caissiere','cashier.update'),('caissiere','cashier.delete'),('caissiere','cashier.duplicate'),('caissiere','cashier.status_update'),('caissiere','cashier.import'),('caissiere','cashier.export'),
   ('comptable','apps.view'),('comptable','dashboard.view'),('comptable','profile.read'),('comptable','profile.update'),('comptable','cashier.read'),('comptable','cashier.export'),('comptable','journals.read'),('comptable','journal_entries.read'),('comptable','journal_entries.chart_read'),
   ('tresorier','apps.view'),('tresorier','dashboard.view'),('tresorier','profile.read'),('tresorier','profile.update'),('tresorier','cashier.read'),('tresorier','journals.read'),('tresorier','journals.create'),('tresorier','journal_entries.read'),('tresorier','journal_entries.chart_read'),('tresorier','journal_entries.create'),('tresorier','journal_entries.update'),('tresorier','journal_entries.delete'),('tresorier','configuration.read'),('tresorier','configuration.manage'),
   ('employe','apps.view'),('employe','dashboard.view'),('employe','profile.read'),('employe','profile.update')
  ) AS x(role_key,permission_key) CROSS JOIN LATERAL (SELECT '{"type":"all","version":1}'::jsonb) s(scope)
  UNION ALL SELECT 'tresorier', x.permission_key, '{"type":"owner","version":1}'::jsonb FROM (VALUES ('journals.update'),('journals.delete'),('journal_entries.create'),('journal_entries.update'),('journal_entries.delete')) x(permission_key)
)
INSERT INTO public.access_role_permissions(role_id, permission_key, scope)
SELECT r.id, g.permission_key, g.scope FROM grants g JOIN public.access_roles r ON r.role_key=g.role_key JOIN public.access_permissions p ON p.permission_key=g.permission_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

CREATE OR REPLACE FUNCTION public.access_control_mutate(p_actor_user_id uuid, p_operation text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  payload jsonb := coalesce(p_payload, '{}');
  required_permission text;
  actor_ok boolean;
  role_id uuid;
  role_key text;
  target_user_id uuid;
  target_role_id uuid;
  permission_key text;
  override_id uuid;
  item jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_actor_user_id AND is_active) THEN
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
  END;
  IF required_permission IS NULL THEN RAISE EXCEPTION 'Unsupported access-control operation' USING ERRCODE = '22023'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.access_user_roles ur
    JOIN public.access_roles r ON r.id = ur.role_id AND r.is_active
    JOIN public.access_role_permissions rp ON rp.role_id = r.id
    WHERE ur.user_id = p_actor_user_id
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND rp.permission_key = required_permission
      AND rp.scope->>'type' = 'all'
  ) INTO actor_ok;
  IF NOT actor_ok THEN RAISE EXCEPTION 'Insufficient access-control permission' USING ERRCODE = '42501'; END IF;

  IF p_operation = 'role.create' THEN
    INSERT INTO public.access_roles(role_key, label, description, created_by)
    VALUES(lower(btrim(payload->>'roleKey')), btrim(payload->>'label'), coalesce(payload->>'description',''), p_actor_user_id)
    RETURNING id, role_key INTO role_id, role_key;
    INSERT INTO public.access_audit_log(actor_user_id, action_key, role_key, after_state) VALUES(p_actor_user_id, p_operation, role_key, jsonb_build_object('id', role_id));
    RETURN jsonb_build_object('id', role_id, 'roleKey', role_key);
  ELSIF p_operation = 'role.update' THEN
    role_id := (payload->>'roleId')::uuid;
    UPDATE public.access_roles SET label = btrim(payload->>'label'), description = coalesce(payload->>'description',''), is_active = coalesce((payload->>'isActive')::boolean, is_active), updated_at = now()
    WHERE public.access_roles.id = role_id AND NOT public.access_roles.is_system RETURNING role_key INTO role_key;
    IF role_key IS NULL THEN RAISE EXCEPTION 'Role not found or system role' USING ERRCODE = '42501'; END IF;
    INSERT INTO public.access_audit_log(actor_user_id, action_key, role_key) VALUES(p_actor_user_id, p_operation, role_key);
    RETURN jsonb_build_object('id', role_id, 'roleKey', role_key);
  ELSIF p_operation = 'role.delete' THEN
    role_id := (payload->>'roleId')::uuid;
    SELECT access_roles.role_key INTO role_key FROM public.access_roles WHERE access_roles.id = role_id AND NOT access_roles.is_system;
    IF role_key IS NULL OR EXISTS (SELECT 1 FROM public.access_user_roles ur WHERE ur.role_id = role_id) THEN RAISE EXCEPTION 'Role not found or still assigned' USING ERRCODE = '23503'; END IF;
    DELETE FROM public.access_roles WHERE public.access_roles.id = role_id;
    INSERT INTO public.access_audit_log(actor_user_id, action_key, role_key) VALUES(p_actor_user_id, p_operation, role_key);
    RETURN jsonb_build_object('deleted', true, 'roleKey', role_key);
  ELSIF p_operation = 'role.permissions.replace' THEN
    role_id := (payload->>'roleId')::uuid;
    SELECT access_roles.role_key INTO role_key FROM public.access_roles WHERE access_roles.id = role_id AND access_roles.is_active;
    IF role_key IS NULL OR jsonb_typeof(payload->'grants') <> 'array' THEN RAISE EXCEPTION 'Invalid role or grants' USING ERRCODE = '22023'; END IF;
    DELETE FROM public.access_role_permissions WHERE access_role_permissions.role_id = role_id;
    FOR item IN SELECT * FROM jsonb_array_elements(payload->'grants') LOOP
      IF NOT EXISTS (SELECT 1 FROM public.access_permissions WHERE permission_key = item->>'permissionKey') THEN RAISE EXCEPTION 'Unknown permission' USING ERRCODE = '22023'; END IF;
      INSERT INTO public.access_role_permissions(role_id, permission_key, scope, granted_by) VALUES(role_id, item->>'permissionKey', item->'scope', p_actor_user_id);
    END LOOP;
    INSERT INTO public.access_audit_log(actor_user_id, action_key, role_key, after_state) VALUES(p_actor_user_id, p_operation, role_key, payload->'grants');
    RETURN jsonb_build_object('roleId', role_id, 'saved', true);
  ELSIF p_operation = 'user.role.assign' THEN
    target_user_id := (payload->>'userId')::uuid;
    target_role_id := (payload->>'roleId')::uuid;
    SELECT role_key INTO role_key FROM public.access_roles WHERE id = target_role_id AND is_active;
    IF role_key IS NULL THEN RAISE EXCEPTION 'Active role not found' USING ERRCODE = 'P0002'; END IF;
    DELETE FROM public.access_user_roles WHERE user_id = target_user_id AND role_id <> target_role_id;
    INSERT INTO public.access_user_roles(user_id, role_id, assigned_by, assignment_source, expires_at) VALUES(target_user_id, target_role_id, p_actor_user_id, 'admin', NULLIF(payload->>'expiresAt','')::timestamptz)
    ON CONFLICT(user_id, role_id) DO UPDATE SET assigned_by = excluded.assigned_by, assignment_source = 'admin', expires_at = excluded.expires_at;
    IF role_key IN ('admin','manager','tresorier','caissiere','comptable','employe') THEN
      UPDATE public.profiles SET role = role_key::public.user_role_enum, updated_at = now() WHERE id = target_user_id;
      UPDATE auth.users SET raw_app_meta_data = coalesce(raw_app_meta_data,'{}') || jsonb_build_object('role', role_key) WHERE id = target_user_id;
    END IF;
    INSERT INTO public.access_audit_log(actor_user_id, subject_user_id, action_key, role_key) VALUES(p_actor_user_id, target_user_id, p_operation, role_key);
    RETURN jsonb_build_object('userId', target_user_id, 'roleKey', role_key);
  ELSIF p_operation = 'user.role.revoke' THEN
    target_user_id := (payload->>'userId')::uuid; target_role_id := (payload->>'roleId')::uuid;
    DELETE FROM public.access_user_roles WHERE user_id = target_user_id AND role_id = target_role_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'User role assignment not found' USING ERRCODE = 'P0002'; END IF;
    INSERT INTO public.access_audit_log(actor_user_id, subject_user_id, action_key) VALUES(p_actor_user_id, target_user_id, p_operation);
    RETURN jsonb_build_object('revoked', true);
  ELSIF p_operation = 'user.permission.override' THEN
    target_user_id := (payload->>'userId')::uuid; permission_key := payload->>'permissionKey';
    INSERT INTO public.access_user_overrides(user_id, permission_key, effect, scope, reason, granted_by, expires_at)
    VALUES(target_user_id, permission_key, payload->>'effect', payload->'scope', btrim(payload->>'reason'), p_actor_user_id, NULLIF(payload->>'expiresAt','')::timestamptz)
    ON CONFLICT(user_id, permission_key, scope) DO UPDATE SET effect=excluded.effect, reason=excluded.reason, granted_by=excluded.granted_by, expires_at=excluded.expires_at;
    INSERT INTO public.access_audit_log(actor_user_id, subject_user_id, action_key, permission_key) VALUES(p_actor_user_id, target_user_id, p_operation, permission_key);
    RETURN jsonb_build_object('saved', true);
  ELSIF p_operation = 'user.permission.override.revoke' THEN
    override_id := (payload->>'overrideId')::uuid;
    DELETE FROM public.access_user_overrides WHERE id = override_id;
    INSERT INTO public.access_audit_log(actor_user_id, action_key) VALUES(p_actor_user_id, p_operation);
    RETURN jsonb_build_object('revoked', true);
  END IF;
  RAISE EXCEPTION 'Unsupported access-control operation' USING ERRCODE = '22023';
END; $$;
REVOKE ALL ON FUNCTION public.access_control_mutate(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.access_control_mutate(uuid,text,jsonb) TO service_role;

INSERT INTO public.journals(name,type,ledger_type,sequence_prefix,default_account,currency,is_active)
VALUES ('Caisse Principale','cash','Journal des opérations de caisse','CSH1','510000 Valeurs à encaisser','XAF',true)
ON CONFLICT (sequence_prefix) DO NOTHING;

COMMIT;
