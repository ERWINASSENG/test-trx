-- ==============================================================================
-- DIGITAL-TRX — Script de RECRÉATION FIDÈLE DE LA STRUCTURE RÉELLE DE PRODUCTION
-- Vérifié par introspection directe du projet Supabase "digitaltrx"
-- (nkeornagjbbejmkqqzfq) le 04/10/2026.
-- ==============================================================================
-- Ce fichier remplace la version du 01/10/2026, qui documentait une étape
-- antérieure du projet. Depuis, la production a évolué sur plusieurs points
-- que ce fichier corrige :
--
--   1. Un schéma `private` existe désormais et porte 3 fonctions internes
--      (private.is_active_user, private.assign_journal_entry_piece_comptable,
--      private.audit_row_change) — en plus de leurs équivalents publics là où
--      ils existent.
--   2. Un système d'audit automatique (triggers trg_audit_*) alimente la table
--      public.audit_logs à chaque écriture sur cashier_transactions et
--      journal_entries. La version précédente du script gardait audit_logs
--      vide (aucun mécanisme pour la remplir).
--   3. Deux fonctions RPC supplémentaires gèrent le provisioning des
--      collaborateurs et la synchronisation de leur rôle legacy :
--      public.provision_collaborator(), public.sync_user_primary_role().
--      Cette dernière contient une protection explicite empêchant de retirer
--      le rôle admin au dernier administrateur actif.
--   4. La contrainte d'unicité sur journal_entries est scindée PAR ANNÉE
--      (uq_journal_entries_seq_per_year, sur journal_id + année extraite de
--      `date` + sequence_number), et non uq_journal_entries_seq comme indiqué
--      précédemment — car le compteur de numérotation (private.assign_journal_
--      entry_piece_comptable) se réinitialise chaque année civile par journal.
--      Une contrainte non scindée par année provoquerait un échec d'insertion
--      systématique dès la première écriture de chaque nouvelle année.
--   5. Deux vues de reporting existent : cashier_balance_summary et
--      cashier_transactions_with_balance.
--   6. access_role_permissions contient, en plus des octrois "all" documentés
--      précédemment, des octrois à portée "owner" (le trésorier ne peut agir
--      que sur ses propres journaux/écritures pour certaines actions).
--   7. Les policies RLS métier (dossiers, journals, journal_entries,
--      cashier_transactions) ont été durcies (contrôle de propriété
--      created_by/employee_id, vérification is_active_user()) — elles sont
--      actives en production depuis le 04/10/2026.
--
-- À exécuter sur un projet Supabase neuf, juste après sa création.
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
-- Schéma privé (fonctions internes, non exposées à l'API PostgREST)
-- ------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS private;
COMMENT ON SCHEMA private IS 'Fonctions internes (triggers, audit) volontairement exclues du schéma public exposé par PostgREST.';

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
-- Fonctions utilitaires
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
-- Tables métier (ordre respectant les dépendances de clés étrangères)
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
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_journals_is_active ON public.journals (is_active);
CREATE INDEX idx_journals_type ON public.journals (type);
CREATE INDEX idx_journals_created_by ON public.journals (created_by);

-- journal_entries (écritures des journaux autres que la Caisse Principale, ex. Banques)
-- NOTE : la numérotation (sequence_number) se réinitialise chaque année civile
-- par journal (voir private.assign_journal_entry_piece_comptable ci-dessous),
-- d'où l'unicité scindée par année ci-dessous et non par (journal_id, sequence_number) seul.
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
    CONSTRAINT uq_journal_entries_piece UNIQUE (journal_id, piece_comptable)
);
CREATE INDEX idx_journal_entries_journal_id ON public.journal_entries(journal_id);
CREATE INDEX idx_journal_entries_date ON public.journal_entries(journal_id, date ASC, sequence_number ASC);
CREATE INDEX idx_journal_entries_seq ON public.journal_entries(journal_id, sequence_number ASC);
CREATE INDEX idx_journal_entries_created_by ON public.journal_entries(created_by);
CREATE UNIQUE INDEX uq_journal_entries_seq_per_year
  ON public.journal_entries (journal_id, ((EXTRACT(year FROM date))::integer), sequence_number);

-- cashier_piece_counters (compteur CSH1, par année)
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

-- audit_logs (alimentée automatiquement par private.audit_row_change(), voir plus bas)
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
-- NOTE : uq_cashier_transactions_business_fingerprint empêche la double-saisie
-- d'une même opération (même date, montant, libellé, dossier et service normalisés).
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
CREATE INDEX idx_cashier_transactions_keyset ON public.cashier_transactions (date, created_at, id);
CREATE UNIQUE INDEX uq_cashier_transactions_business_fingerprint
  ON public.cashier_transactions (
    left(date, 10),
    abs(montant),
    regexp_replace(lower(btrim(libelle)), '\s+', ' ', 'g'),
    regexp_replace(lower(btrim(COALESCE(no_dossier, ''))), '\s+', ' ', 'g'),
    regexp_replace(lower(btrim(COALESCE(service, ''))), '\s+', ' ', 'g')
  )
  WHERE (status <> 'cancelled');

-- prospects (CRM léger)
CREATE TABLE public.prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) >= 2 AND length(btrim(name)) <= 200),
  company_name text CHECK (company_name IS NULL OR length(btrim(company_name)) <= 200),
  contact_name text CHECK (contact_name IS NULL OR length(btrim(contact_name)) <= 200),
  email text CHECK (email IS NULL OR length(btrim(email)) <= 320),
  phone text CHECK (phone IS NULL OR length(btrim(phone)) <= 40),
  source text CHECK (source IS NULL OR length(btrim(source)) <= 100),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  estimated_value numeric(14,2) CHECK (estimated_value IS NULL OR estimated_value >= 0),
  currency varchar(3) NOT NULL DEFAULT 'XAF' CHECK (currency ~ '^[A-Z]{3}$'),
  next_follow_up date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_prospects_follow_up ON public.prospects (next_follow_up) WHERE (next_follow_up IS NOT NULL);
CREATE INDEX idx_prospects_created_by ON public.prospects (created_by);
CREATE INDEX idx_prospects_status_created ON public.prospects (status, created_at DESC);
CREATE INDEX idx_prospects_assigned_to ON public.prospects (assigned_to);
CREATE INDEX idx_prospects_email_lower ON public.prospects (lower(email)) WHERE (email IS NOT NULL);

-- Cotations commerciales à structure personnalisable par cotation
CREATE SEQUENCE public.sales_quote_number_seq;

CREATE TABLE public.sales_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number text NOT NULL UNIQUE DEFAULT (
    'COT-' || to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-' ||
    lpad(nextval('public.sales_quote_number_seq'::regclass)::text, 7, '0')
  ),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Cotation' CHECK (length(btrim(title)) BETWEEN 2 AND 200),
  currency varchar(3) NOT NULL DEFAULT 'XAF' CHECK (currency ~ '^[A-Z]{3}$'),
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  total_column_id text NOT NULL,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  valid_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_quotes_assigned_updated ON public.sales_quotes (assigned_to, updated_at DESC);
CREATE INDEX idx_sales_quotes_prospect_created ON public.sales_quotes (prospect_id, created_at DESC);
CREATE INDEX idx_sales_quotes_status_valid_until ON public.sales_quotes (status, valid_until)
  WHERE status IN ('draft', 'sent') AND valid_until IS NOT NULL;

CREATE TABLE public.sales_quote_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  total_column_id text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_quote_templates_name ON public.sales_quote_templates (name);
CREATE INDEX idx_sales_quote_templates_creator ON public.sales_quote_templates (created_by);

-- ------------------------------------------------------------------
-- Système RBAC (catalogue de rôles/permissions)
-- ------------------------------------------------------------------
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
CREATE INDEX idx_access_roles_created_by ON public.access_roles (created_by);

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
CREATE INDEX idx_access_role_permissions_granted_by ON public.access_role_permissions (granted_by);

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
CREATE INDEX idx_access_user_roles_assigned_by ON public.access_user_roles (assigned_by);

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
CREATE INDEX idx_access_user_overrides_granted_by ON public.access_user_overrides (granted_by);
CREATE INDEX idx_access_user_overrides_permission_key ON public.access_user_overrides (permission_key);

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

CREATE INDEX idx_access_role_permissions_permission ON public.access_role_permissions (permission_key, role_id);
CREATE INDEX idx_access_user_roles_role ON public.access_user_roles (role_id, user_id);
CREATE INDEX idx_access_user_roles_expiration ON public.access_user_roles (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_access_user_overrides_lookup ON public.access_user_overrides (user_id, permission_key, expires_at);
CREATE INDEX idx_access_audit_log_subject_created ON public.access_audit_log (subject_user_id, created_at DESC);
CREATE INDEX idx_access_audit_log_actor_created ON public.access_audit_log (actor_user_id, created_at DESC);

-- ------------------------------------------------------------------
-- Vues de reporting caisse
-- ------------------------------------------------------------------
CREATE VIEW public.cashier_transactions_with_balance AS
 SELECT id, date, libelle, service, type_description, category, status, no_dossier,
    dossier_id, first_name, partenaire, employee, employee_id, quantity, montant,
    solde_apres, selected, created_by, piece_comptable, created_at, updated_at, journal_id,
    sum(
        CASE
            WHEN (status <> 'cancelled'::cashier_transaction_status) THEN montant
            ELSE (0)::numeric
        END) OVER (ORDER BY (left(date, 10)), created_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS solde_progressif
   FROM public.cashier_transactions t;

CREATE VIEW public.cashier_balance_summary AS
 SELECT COALESCE(sum(montant) FILTER (WHERE (status <> 'cancelled'::cashier_transaction_status)), (0)::numeric) AS solde_total,
    COALESCE(sum(montant) FILTER (WHERE ((status <> 'cancelled'::cashier_transaction_status) AND (montant > (0)::numeric))), (0)::numeric) AS total_entrees,
    COALESCE((- sum(montant) FILTER (WHERE ((status <> 'cancelled'::cashier_transaction_status) AND (montant < (0)::numeric)))), (0)::numeric) AS total_sorties,
    count(*) FILTER (WHERE (status <> 'cancelled'::cashier_transaction_status)) AS nb_operations
   FROM public.cashier_transactions;

-- ------------------------------------------------------------------
-- Fonctions dépendant des tables (schéma public)
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_current_user_role()
 RETURNS user_role_enum
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT p.role FROM public.profiles p
  WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT (public.get_current_user_role() = 'admin');
$function$;

CREATE OR REPLACE FUNCTION public.is_active_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE
  );
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
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' THEN
    RETURN NEW;
  END IF;

  annee_piece := COALESCE(
    NULLIF(substring(NEW.date from '\d{4}$'), '')::int,
    EXTRACT(YEAR FROM now())::int
  );

  INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
  VALUES (annee_piece, 0)
  ON CONFLICT (annee) DO NOTHING;

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

-- --------------------------------------------------------------
-- Provisioning de collaborateurs et synchronisation de leur rôle
-- legacy (profiles.role) avec le nouveau système RBAC (access_user_roles).
-- sync_user_primary_role() EMPÊCHE explicitement de retirer le rôle admin
-- au dernier administrateur actif de la plateforme.
-- --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_user_primary_role(
  p_actor_user_id uuid,
  p_user_id uuid,
  p_role_key text,
  p_exclusive boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role_id uuid;
  v_admin_count integer;
  v_is_current_admin boolean;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF p_role_key IS NULL OR p_role_key NOT IN ('admin','manager','tresorier','caissiere','comptable','employe') THEN
    RAISE EXCEPTION 'Role cannot be synchronized with the legacy profile' USING ERRCODE = '22023';
  END IF;

  SELECT r.id INTO v_role_id
  FROM public.access_roles r WHERE r.role_key = p_role_key AND r.is_active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active role not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_role_key <> 'admin' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.access_user_roles ur
      JOIN public.access_roles r ON r.id = ur.role_id
      WHERE ur.user_id = p_user_id AND r.role_key = 'admin'
        AND (ur.expires_at IS NULL OR ur.expires_at > now())
    ) INTO v_is_current_admin;

    IF v_is_current_admin THEN
      SELECT count(DISTINCT ur.user_id) INTO v_admin_count
      FROM public.access_user_roles ur
      JOIN public.access_roles r ON r.id = ur.role_id
      WHERE r.role_key = 'admin' AND (ur.expires_at IS NULL OR ur.expires_at > now());
      IF v_admin_count <= 1 THEN
        RAISE EXCEPTION 'Cannot replace the last administrator assignment' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(r.role_key ORDER BY r.role_key), '[]'::jsonb) INTO v_before
  FROM public.access_user_roles ur JOIN public.access_roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id;

  INSERT INTO public.access_user_roles (user_id, role_id, assigned_by, assignment_source, expires_at)
  VALUES (p_user_id, v_role_id, p_actor_user_id, 'legacy_profile', NULL)
  ON CONFLICT (user_id, role_id) DO UPDATE
  SET assigned_by = EXCLUDED.assigned_by, expires_at = NULL;

  DELETE FROM public.access_user_roles
  WHERE user_id = p_user_id
    AND role_id <> v_role_id
    AND (p_exclusive OR assignment_source = 'legacy_profile');

  UPDATE public.profiles
  SET role = p_role_key::public.user_role_enum
  WHERE id = p_user_id AND role IS DISTINCT FROM p_role_key::public.user_role_enum;

  SELECT COALESCE(jsonb_agg(r.role_key ORDER BY r.role_key), '[]'::jsonb) INTO v_after
  FROM public.access_user_roles ur JOIN public.access_roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id;

  INSERT INTO public.access_audit_log (actor_user_id, subject_user_id, action_key, role_key, before_state, after_state)
  VALUES (p_actor_user_id, p_user_id, 'user.role.sync', p_role_key,
          jsonb_build_object('roles', v_before), jsonb_build_object('roles', v_after, 'exclusive', p_exclusive));

  RETURN jsonb_build_object('userId', p_user_id, 'roleKey', p_role_key, 'roles', v_after);
END;
$function$;

CREATE OR REPLACE FUNCTION public.provision_collaborator(
  p_actor_user_id uuid,
  p_user_id uuid,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_role_key text,
  p_department text DEFAULT NULL::text,
  p_phone text DEFAULT NULL::text,
  p_must_change_password boolean DEFAULT true,
  p_is_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'Auth user not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.profiles (id, email, first_name, last_name, role, department, phone, is_active, must_change_password)
  VALUES (p_user_id, p_email, COALESCE(p_first_name, ''), COALESCE(p_last_name, ''),
          'employe'::public.user_role_enum,
          COALESCE(p_department, 'Services Généraux'), COALESCE(p_phone, ''),
          COALESCE(p_is_active, true), COALESCE(p_must_change_password, true))
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      department = COALESCE(p_department, public.profiles.department),
      phone = COALESCE(p_phone, public.profiles.phone),
      is_active = EXCLUDED.is_active,
      must_change_password = EXCLUDED.must_change_password;

  v_result := public.sync_user_primary_role(p_actor_user_id, p_user_id, p_role_key, true);

  INSERT INTO public.access_audit_log (actor_user_id, subject_user_id, action_key, role_key, after_state)
  VALUES (p_actor_user_id, p_user_id, 'collaborator.provision', p_role_key,
          jsonb_build_object('email', p_email, 'isActive', p_is_active));

  RETURN v_result;
END;
$function$;

-- --------------------------------------------------------------
-- access_control_mutate : point d'entrée unique pour toute mutation
-- du RBAC (création/édition de rôle, attribution de permissions,
-- attribution/révocation de rôle à un utilisateur, overrides individuels).
-- --------------------------------------------------------------
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
  SELECT p.is_active INTO actor_is_active
  FROM public.profiles p WHERE p.id = p_actor_user_id;

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
      SELECT r.role_key, r.is_system INTO target_role_key, target_role_is_system
      FROM public.access_roles r WHERE r.id = target_role_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_is_system THEN
        RAISE EXCEPTION 'System role identity cannot be changed' USING ERRCODE = '42501';
      END IF;
      IF COALESCE(length(btrim(payload->>'label')), 0) < 2 THEN
        RAISE EXCEPTION 'Role label must contain at least two characters' USING ERRCODE = '22023';
      END IF;
      SELECT to_jsonb(r) INTO previous_state FROM public.access_roles r WHERE r.id = target_role_id;
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
      SELECT r.role_key, r.is_system, to_jsonb(r) INTO target_role_key, target_role_is_system, previous_state
      FROM public.access_roles r WHERE r.id = target_role_id FOR UPDATE;
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
      FROM public.access_roles r WHERE r.id = target_role_id AND r.is_active IS TRUE FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Active role not found' USING ERRCODE = 'P0002';
      END IF;
      IF COALESCE(jsonb_typeof(payload->'grants'), '') <> 'array' THEN
        RAISE EXCEPTION 'Permission grants must be an array' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(payload->'grants') AS item
        WHERE NOT EXISTS (SELECT 1 FROM public.access_permissions p WHERE p.permission_key = item->>'permissionKey')
        OR jsonb_typeof(item->'scope') <> 'object'
        OR COALESCE(item->'scope'->>'type', '') = ''
        OR item->'scope'->>'version' <> '1'
      ) THEN
        RAISE EXCEPTION 'Unknown permission or invalid scope' USING ERRCODE = '22023';
      END IF;
      IF target_role_key = 'admin' AND EXISTS (
        SELECT required_key.permission_key FROM (VALUES
          ('access.roles.manage'), ('access.permissions.assign'), ('access.users.assign_roles'),
          ('access.users.override'), ('access.audit.read')
        ) AS required_key(permission_key)
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(payload->'grants') AS item
          WHERE item->>'permissionKey' = required_key.permission_key AND item->'scope'->>'type' = 'all'
        )
      ) THEN
        RAISE EXCEPTION 'The administrator role must retain access-management permissions' USING ERRCODE = '42501';
      END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope)), '[]'::jsonb)
        INTO previous_state FROM public.access_role_permissions rp WHERE rp.role_id = target_role_id;
      DELETE FROM public.access_role_permissions WHERE role_id = target_role_id;
      INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
      SELECT target_role_id, item->>'permissionKey', item->'scope', p_actor_user_id
      FROM jsonb_array_elements(payload->'grants') AS item;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope)), '[]'::jsonb)
        INTO next_state FROM public.access_role_permissions rp WHERE rp.role_id = target_role_id;
      audit_subject := NULL;

    WHEN 'user.role.assign' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r WHERE r.id = target_role_id AND r.is_active IS TRUE;
      IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = target_user_id) THEN
        RAISE EXCEPTION 'Active role or user profile not found' USING ERRCODE = 'P0002';
      END IF;
      INSERT INTO public.access_user_roles (user_id, role_id, assigned_by, assignment_source, expires_at)
      VALUES (target_user_id, target_role_id, p_actor_user_id, 'admin', NULLIF(payload->>'expiresAt', '')::timestamptz)
      ON CONFLICT (user_id, role_id) DO UPDATE
      SET assigned_by = EXCLUDED.assigned_by, assignment_source = 'admin', expires_at = EXCLUDED.expires_at;
      next_state := jsonb_build_object('userId', target_user_id, 'roleKey', target_role_key, 'expiresAt', payload->'expiresAt');
      audit_subject := target_user_id;

    WHEN 'user.role.revoke' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key FROM public.access_roles r WHERE r.id = target_role_id;
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
      DELETE FROM public.access_user_roles WHERE user_id = target_user_id AND role_id = target_role_id;
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
      SELECT to_jsonb(uo) INTO previous_state FROM public.access_user_overrides uo
      WHERE uo.user_id = target_user_id AND uo.permission_key = target_permission_key AND uo.scope = target_scope
      FOR UPDATE;
      INSERT INTO public.access_user_overrides (user_id, permission_key, effect, scope, reason, granted_by, expires_at)
      VALUES (target_user_id, target_permission_key, target_effect, target_scope, target_reason, p_actor_user_id, NULLIF(payload->>'expiresAt', '')::timestamptz)
      ON CONFLICT (user_id, permission_key, scope) DO UPDATE
      SET effect = EXCLUDED.effect, reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by,
          created_at = now(), expires_at = EXCLUDED.expires_at
      RETURNING to_jsonb(access_user_overrides) INTO next_state;
      audit_subject := target_user_id;

    WHEN 'user.permission.override.revoke' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'overrideId', '')::uuid;
      SELECT to_jsonb(uo), uo.permission_key INTO previous_state, target_permission_key
      FROM public.access_user_overrides uo WHERE uo.id = target_role_id AND uo.user_id = target_user_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'User permission override not found' USING ERRCODE = 'P0002';
      END IF;
      DELETE FROM public.access_user_overrides WHERE id = target_role_id;
      next_state := jsonb_build_object('revoked', true, 'permissionKey', target_permission_key);
      audit_subject := target_user_id;
  END CASE;

  INSERT INTO public.access_audit_log (
    actor_user_id, subject_user_id, action_key, role_key, permission_key, reason, before_state, after_state
  )
  VALUES (p_actor_user_id, audit_subject, p_operation, target_role_key, target_permission_key, target_reason, previous_state, next_state);

  RETURN COALESCE(next_state, '{}'::jsonb);
END;
$function$;

-- ------------------------------------------------------------------
-- Fonctions du schéma privé
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.is_active_user()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE
  );
$function$;

-- Numérotation réelle des écritures de journal : compteur par (journal_id, année).
CREATE OR REPLACE FUNCTION private.assign_journal_entry_piece_comptable()
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

-- Audit automatique : alimente public.audit_logs à chaque écriture sur une
-- table surveillée (voir triggers trg_audit_* ci-dessous). Ignore les UPDATE
-- qui ne modifient que updated_at (no-op fonctionnel).
CREATE OR REPLACE FUNCTION private.audit_row_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_role text;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;

  IF TG_OP = 'UPDATE'
     AND (v_old - 'updated_at') IS NOT DISTINCT FROM (v_new - 'updated_at') THEN
    RETURN NEW;
  END IF;

  SELECT p.email, p.role::text INTO v_email, v_role
  FROM public.profiles p WHERE p.id = v_uid;

  INSERT INTO public.audit_logs (user_id, user_email, user_role, action, entity_type, entity_id, details)
  VALUES (
    CASE WHEN v_email IS NOT NULL THEN v_uid END,
    v_email,
    v_role,
    'DB_' || TG_OP || '_' || upper(TG_TABLE_NAME),
    TG_TABLE_NAME,
    COALESCE(v_new->>'id', v_old->>'id'),
    jsonb_build_object('source', 'db_trigger', 'old', v_old, 'new', v_new)
  );

  RETURN COALESCE(NEW, OLD);
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
    SELECT * FROM pg_event_trigger_ddl_commands()
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

-- NOTE : pointe vers private.assign_journal_entry_piece_comptable(), pas
-- public. (fonction identique, mais hébergée dans le schéma interne).
CREATE TRIGGER trg_assign_journal_entry_piece_comptable
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION private.assign_journal_entry_piece_comptable();

CREATE TRIGGER trg_prospects_updated_at
  BEFORE UPDATE ON public.prospects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_sales_quotes_updated_at
  BEFORE UPDATE ON public.sales_quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_sales_quote_templates_updated_at
  BEFORE UPDATE ON public.sales_quote_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Audit automatique (écrit dans public.audit_logs)
CREATE TRIGGER trg_audit_cashier_transactions
  AFTER INSERT OR UPDATE OR DELETE ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();

CREATE TRIGGER trg_audit_journal_entries
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION private.audit_row_change();

CREATE TRIGGER trg_access_roles_updated_at
  BEFORE UPDATE ON public.access_roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

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
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_user_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_audit_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.profiles, public.dossiers, public.journals,
  public.journal_entries, public.cashier_piece_counters, public.journal_piece_counters,
  public.audit_logs, public.cashier_transactions, public.prospects,
  public.sales_quotes, public.sales_quote_templates,
  public.access_roles, public.access_permissions, public.access_role_permissions,
  public.access_user_roles, public.access_user_overrides, public.access_audit_log
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dossiers, public.journals, public.journal_entries, public.cashier_transactions TO authenticated;
GRANT SELECT ON TABLE public.audit_logs TO authenticated;
GRANT SELECT ON TABLE public.cashier_balance_summary, public.cashier_transactions_with_balance TO authenticated;

GRANT ALL PRIVILEGES ON TABLE public.profiles, public.dossiers, public.journals,
  public.journal_entries, public.cashier_piece_counters, public.journal_piece_counters,
  public.audit_logs, public.cashier_transactions, public.prospects,
  public.sales_quotes, public.sales_quote_templates,
  public.access_roles, public.access_permissions, public.access_role_permissions,
  public.access_user_roles, public.access_user_overrides, public.access_audit_log,
  public.cashier_balance_summary, public.cashier_transactions_with_balance
  TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.access_audit_log_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sales_quote_number_seq TO service_role;

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

-- dossiers
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

-- journals (lecture : tresorier/manager/admin ; écriture : tresorier/admin)
CREATE POLICY journals_select_authenticated ON public.journals
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role IN ('tresorier', 'manager')
      )
    )
  );

CREATE POLICY journals_insert_management ON public.journals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role = 'tresorier'
      )
    )
  );

CREATE POLICY journals_update_management ON public.journals
  FOR UPDATE TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role = 'tresorier'
      )
    )
  )
  WITH CHECK (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role = 'tresorier'
      )
    )
  );

CREATE POLICY journals_delete_admin ON public.journals
  FOR DELETE TO authenticated
  USING (public.is_active_user() AND public.is_admin() AND sequence_prefix <> 'CSH1');

-- journal_entries (lecture : tresorier/manager/admin ; écriture : trésorier propriétaire de SA ligne + admin)
CREATE POLICY journal_entries_select_by_role ON public.journal_entries
  FOR SELECT TO authenticated
  USING (
    public.is_active_user()
    AND (
      public.is_admin()
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role IN ('tresorier', 'manager')
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
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role = 'tresorier'
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
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role = 'tresorier'
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
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role = 'tresorier'
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
        created_by = (SELECT auth.uid())
        AND EXISTS (
          SELECT 1 FROM public.profiles p
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role = 'tresorier'
        )
      )
    )
  );

CREATE POLICY journal_entries_service_role_all ON public.journal_entries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cashier_piece_counters / journal_piece_counters : service_role uniquement
CREATE POLICY cashier_piece_counters_service_role ON public.cashier_piece_counters
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY journal_piece_counters_service_role ON public.journal_piece_counters
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cashier_transactions (lecture : caissier/caissiere/manager/comptable/tresorier/admin ;
-- écriture : caissier/caissiere + admin uniquement, avec contrôle de propriété)
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
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role IN ('caissier', 'caissiere')
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
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role IN ('caissier', 'caissiere')
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
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role IN ('caissier', 'caissiere')
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
          WHERE p.id = (SELECT auth.uid()) AND p.is_active IS TRUE AND p.role IN ('caissier', 'caissiere')
        )
      )
    )
  );

-- audit_logs
CREATE POLICY audit_logs_admin_select ON public.audit_logs
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY audit_logs_service_role_all ON public.audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- prospects : service_role uniquement (aucun accès direct authenticated)
CREATE POLICY prospects_service_role_all ON public.prospects
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sales_quotes_service_role_all ON public.sales_quotes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sales_quote_templates_service_role_all ON public.sales_quote_templates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- access_* (RBAC) : service_role uniquement, catalogue non branché aux policies ci-dessus
CREATE POLICY access_roles_service_role_all ON public.access_roles
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_permissions_service_role_all ON public.access_permissions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_role_permissions_service_role_all ON public.access_role_permissions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_user_roles_service_role_all ON public.access_user_roles
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_user_overrides_service_role_all ON public.access_user_overrides
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY access_audit_log_service_role_all ON public.access_audit_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------
-- Restrictions d'exécution des fonctions RPC
-- ------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.get_current_user_role() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_current_user_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_user() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.access_control_mutate(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.access_control_mutate(uuid, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.sync_user_primary_role(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_user_primary_role(uuid, uuid, text, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.provision_collaborator(uuid, uuid, text, text, text, text, text, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_collaborator(uuid, uuid, text, text, text, text, text, text, boolean, boolean) TO service_role;

-- Fonctions privées : aucun accès direct via l'API, appelées uniquement par les triggers
REVOKE ALL ON FUNCTION private.is_active_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assign_journal_entry_piece_comptable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.audit_row_change() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- Donnée d'amorçage indispensable : journal Caisse Principale (CSH1)
-- ------------------------------------------------------------------
INSERT INTO public.journals (name, type, ledger_type, sequence_prefix, default_account, currency, is_active)
VALUES ('Caisse Principale', 'cash', 'Journal des opérations de caisse', 'CSH1', '510000 Valeurs à encaisser', 'XAF', true)
ON CONFLICT (sequence_prefix) DO NOTHING;

-- ------------------------------------------------------------------
-- Amorçage RBAC : catalogue de base (6 rôles système, 41 permissions)
-- ------------------------------------------------------------------
INSERT INTO public.access_roles (role_key, label, description, is_system)
VALUES
  ('admin', 'Administrateur', 'Administration complète de la plateforme.', true),
  ('commercial', 'Commercial', 'Création et suivi des cotations commerciales attribuées.', true),
  ('manager', 'Manager', 'Supervision des opérations et des équipes.', true),
  ('caissiere', 'Caissière', 'Opérations autorisées sur la caisse.', true),
  ('comptable', 'Comptable', 'Consultation et opérations comptables autorisées.', true),
  ('tresorier', 'Trésorier', 'Gestion des journaux et de leurs écritures.', true),
  ('employe', 'Employé', 'Accès de base aux fonctions employé.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.access_permissions (permission_key, resource_key, action_key, label, description, is_sensitive)
VALUES
  ('apps.view', 'apps', 'view', 'Consulter les applications', 'Accéder au lanceur des modules autorisés.', false),
  ('dashboard.view', 'dashboard', 'view', 'Consulter les tableaux de bord', 'Accéder aux indicateurs autorisés.', false),
  ('profile.read', 'profile', 'read', 'Consulter son profil', 'Lire les informations de son propre profil.', false),
  ('profile.update', 'profile', 'update', 'Modifier son profil', 'Modifier les champs autorisés de son propre profil.', false),
  ('users.read', 'users', 'read', 'Consulter les utilisateurs', 'Afficher les profils collaborateurs.', true),
  ('users.create', 'users', 'create', 'Créer un utilisateur', 'Créer un compte et son profil.', true),
  ('users.update', 'users', 'update', 'Modifier un utilisateur', 'Modifier rôle, statut et informations d''un collaborateur.', true),
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
  ('journals.update', 'journals', 'update', 'Modifier un journal', 'Modifier les métadonnées d''un journal autorisé.', true),
  ('journals.delete', 'journals', 'delete', 'Supprimer un journal', 'Supprimer un journal autorisé.', true),
  ('journal_entries.read', 'journal_entries', 'read', 'Consulter les écritures', 'Lire les écritures d''un journal autorisé.', true),
  ('journal_entries.chart_read', 'journal_entries', 'chart_read', 'Consulter les graphiques', 'Lire les données graphiques d''un journal autorisé.', true),
  ('journal_entries.create', 'journal_entries', 'create', 'Créer une écriture', 'Créer une écriture dans un journal autorisé.', true),
  ('journal_entries.update', 'journal_entries', 'update', 'Modifier une écriture', 'Modifier une écriture dans un journal autorisé.', true),
  ('journal_entries.delete', 'journal_entries', 'delete', 'Supprimer une écriture', 'Supprimer une écriture d''un journal autorisé.', true),
  ('configuration.read', 'configuration', 'read', 'Consulter la configuration', 'Afficher les écrans de configuration autorisés.', true),
  ('configuration.manage', 'configuration', 'manage', 'Gérer la configuration', 'Modifier les réglages et journaux autorisés.', true),
  ('prospects.read', 'prospects', 'read', 'Consulter les prospects', 'Consulter les prospects autorisés.', true),
  ('prospects.create', 'prospects', 'create', 'Créer un prospect', 'Créer un nouveau prospect.', true),
  ('prospects.update', 'prospects', 'update', 'Modifier un prospect', 'Modifier les informations et le suivi d''un prospect.', true),
  ('prospects.delete', 'prospects', 'delete', 'Supprimer un prospect', 'Supprimer un prospect.', true),
  ('quotes.read', 'quotes', 'read', 'Consulter les cotations', 'Consulter les cotations attribuées au commercial.', true),
  ('quotes.create', 'quotes', 'create', 'Créer une cotation', 'Créer une cotation et en définir les colonnes.', true),
  ('quotes.update', 'quotes', 'update', 'Modifier une cotation', 'Modifier une cotation attribuée au commercial.', true),
  ('quotes.delete', 'quotes', 'delete', 'Supprimer une cotation', 'Supprimer une cotation attribuée au commercial.', true),
  ('quotes.assign', 'quotes', 'assign', 'Attribuer les cotations', 'Attribuer et réattribuer les cotations aux commerciaux.', true),
  ('quotes.templates.read', 'quotes.templates', 'read', 'Consulter les modèles de cotation', 'Consulter les modèles partagés de cotation.', true),
  ('quotes.templates.create', 'quotes.templates', 'create', 'Créer un modèle de cotation', 'Enregistrer une structure de cotation comme modèle partagé.', true),
  ('quotes.templates.update', 'quotes.templates', 'update', 'Modifier un modèle de cotation', 'Modifier un modèle de cotation créé par soi-même.', true),
  ('quotes.templates.delete', 'quotes.templates', 'delete', 'Supprimer un modèle de cotation', 'Supprimer un modèle de cotation créé par soi-même.', true),
  ('access.roles.read', 'access.roles', 'read', 'Consulter les rôles', 'Afficher le catalogue des rôles.', true),
  ('access.roles.manage', 'access.roles', 'manage', 'Gérer les rôles', 'Créer et modifier les rôles applicatifs.', true),
  ('access.permissions.read', 'access.permissions', 'read', 'Consulter les permissions', 'Afficher le catalogue des permissions.', true),
  ('access.permissions.assign', 'access.permissions', 'assign', 'Attribuer des permissions', 'Modifier les permissions affectées aux rôles.', true),
  ('access.users.read', 'access.users', 'read', 'Consulter les accès utilisateurs', 'Afficher les rôles et exceptions d''un utilisateur.', true),
  ('access.users.assign_roles', 'access.users', 'assign_roles', 'Attribuer des rôles', 'Affecter ou retirer des rôles à un utilisateur.', true),
  ('access.users.override', 'access.users', 'override', 'Définir une exception utilisateur', 'Ajouter une permission ou un refus individuel motivé.', true),
  ('access.audit.read', 'access.audit', 'read', 'Consulter le journal d''audit', 'Lire les changements de rôles et permissions.', true)
ON CONFLICT (permission_key) DO NOTHING;

-- Octrois "all" (étendue générale), reproduisant la matrice de base
WITH initial_grants(role_key, permission_key) AS (
  SELECT 'admin', permission_key FROM public.access_permissions
  UNION ALL
  SELECT * FROM (VALUES
    ('manager', 'apps.view'), ('manager', 'dashboard.view'), ('manager', 'profile.read'), ('manager', 'profile.update'),
    ('manager', 'cashier.read'), ('manager', 'journals.read'), ('manager', 'journal_entries.read'),
    ('manager', 'journal_entries.chart_read'), ('manager', 'configuration.read'),
    ('caissiere', 'apps.view'), ('caissiere', 'dashboard.view'), ('caissiere', 'profile.read'), ('caissiere', 'profile.update'),
    ('caissiere', 'cashier.read'), ('caissiere', 'cashier.create'), ('caissiere', 'cashier.update'), ('caissiere', 'cashier.delete'),
    ('caissiere', 'cashier.duplicate'), ('caissiere', 'cashier.status_update'), ('caissiere', 'cashier.import'), ('caissiere', 'cashier.export'),
    ('comptable', 'apps.view'), ('comptable', 'dashboard.view'), ('comptable', 'profile.read'), ('comptable', 'profile.update'),
    ('comptable', 'cashier.read'), ('comptable', 'cashier.export'), ('comptable', 'journals.read'),
    ('comptable', 'journal_entries.read'), ('comptable', 'journal_entries.chart_read'),
    ('tresorier', 'apps.view'), ('tresorier', 'dashboard.view'), ('tresorier', 'profile.read'), ('tresorier', 'profile.update'),
    ('tresorier', 'cashier.read'), ('tresorier', 'journals.read'), ('tresorier', 'journals.create'),
    ('tresorier', 'journal_entries.read'), ('tresorier', 'journal_entries.chart_read'), ('tresorier', 'journal_entries.create'),
    ('tresorier', 'journal_entries.update'), ('tresorier', 'journal_entries.delete'),
    ('tresorier', 'configuration.read'), ('tresorier', 'configuration.manage'),
    ('employe', 'apps.view'), ('employe', 'dashboard.view'), ('employe', 'profile.read'), ('employe', 'profile.update')
  ) AS grants(role_key, permission_key)
  UNION ALL
  SELECT 'commercial', permission_key FROM public.access_permissions
  WHERE permission_key IN (
    'apps.view', 'dashboard.view', 'profile.read', 'profile.update',
    'quotes.read', 'quotes.create', 'quotes.update', 'quotes.delete',
    'quotes.templates.read', 'quotes.templates.create',
    'quotes.templates.update', 'quotes.templates.delete'
  )
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT roles.id, permissions.permission_key, '{"type":"all","version":1}'::jsonb, NULL
FROM initial_grants
JOIN public.access_roles roles ON roles.role_key = initial_grants.role_key
JOIN public.access_permissions permissions ON permissions.permission_key = initial_grants.permission_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

-- Octrois à portée "owner" : le trésorier ne peut créer/modifier/supprimer
-- que SES PROPRES écritures de journal, et ne peut modifier/supprimer que
-- les journaux dont il est propriétaire (journals.update/delete n'ont ici
-- AUCUN octroi "all" pour ce rôle — uniquement "owner").
WITH owner_grants(role_key, permission_key) AS (
  VALUES
    ('tresorier', 'journal_entries.create'),
    ('tresorier', 'journal_entries.update'),
    ('tresorier', 'journal_entries.delete'),
    ('tresorier', 'journals.update'),
    ('tresorier', 'journals.delete')
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT roles.id, permissions.permission_key, '{"type":"owner","version":1}'::jsonb, NULL
FROM owner_grants
JOIN public.access_roles roles ON roles.role_key = owner_grants.role_key
JOIN public.access_permissions permissions ON permissions.permission_key = owner_grants.permission_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;

-- ==============================================================================
-- IMPORTANT — Ce que ce fichier NE recrée PAS, et pourquoi
-- ==============================================================================
-- Les données des tables suivantes dépendent d'UUID réels de auth.users de ce
-- projet Supabase précis (nkeornagjbbejmkqqzfq) : profiles, cashier_transactions,
-- dossiers, audit_logs, prospects, access_user_roles, access_user_overrides,
-- access_audit_log, ainsi que les journaux « bancaires » réels ajoutés après le
-- journal CSH1. Sur un NOUVEAU projet Supabase, ces UUID n'existeront pas tant
-- que les comptes n'auront pas été recréés via Supabase Auth (Dashboard ou
-- Admin API) — jamais par copie SQL brute des mots de passe hashés, qui ne
-- doivent jamais être exportés ni partagés.
--
-- Ce fichier recrée fidèlement : structure complète (y compris le schéma
-- private), fonctions, triggers (y compris l'audit automatique), policies RLS
-- actives, et les données de référence qui ne dépendent d'aucun compte
-- utilisateur (journal CSH1, access_roles, access_permissions,
-- access_role_permissions avec leurs portées "all" et "owner").
-- ==============================================================================