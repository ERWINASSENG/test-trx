-- ==============================================================================
-- SCHEMA SUPABASE : GESTION DE CAISSE & UTILISATEURS (TRANSIMEX / DIGITALTRX)
-- État consolidé de production incluant les migrations :
--   - 202609200001_security_roles_and_status.sql (enum 'cancelled', handle_new_user sécurisé)
--   - 202609201200_sequential_piece_comptable.sql & 202609220001_resync_piece_counter.sql (attribution atomique des pièces comptables)
--   - 202609221200_rls_auto_enable.sql (activation automatique de RLS)
-- ==============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- pour gen_random_uuid()

-- 2. ENUMÉRATIONS & TYPES
DO $$ BEGIN
    CREATE TYPE public.user_role_enum AS ENUM (
        'admin', 'rh', 'manager_stock', 'caissier', 'agent', 'manager', 'caissiere', 'employe', 'tresorier', 'comptable'
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

-- Synchronise si le type existait déjà sans la valeur 'cancelled'
ALTER TYPE public.cashier_transaction_status ADD VALUE IF NOT EXISTS 'cancelled';

-- 3. FONCTIONS UTILITAIRES
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

CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS public.user_role_enum
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
SET search_path TO 'public'
AS $function$
    SELECT (public.get_current_user_role() = 'admin');
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
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user exception: %', SQLERRM;
  END;

  RETURN new;
END;
$function$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 4. TABLE DES PROFILS UTILISATEURS
CREATE TABLE IF NOT EXISTS public.profiles (
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

CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles (email);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles (role);
CREATE INDEX IF NOT EXISTS idx_profiles_department ON public.profiles (department);

DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acces complet admin service_role" ON public.profiles;
CREATE POLICY "Acces complet admin service_role"
    ON public.profiles FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "profiles_select_policy" ON public.profiles;
CREATE POLICY "profiles_select_policy"
    ON public.profiles FOR SELECT
    TO authenticated
    USING (is_active = true OR id = (select auth.uid()) OR public.is_admin());

DROP POLICY IF EXISTS "profiles_insert_policy" ON public.profiles;
CREATE POLICY "profiles_insert_policy"
    ON public.profiles FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_admin()
        OR (
            id = (select auth.uid())
            AND role = 'employe'
        )
    );

DROP POLICY IF EXISTS "profiles_update_policy" ON public.profiles;
CREATE POLICY "profiles_update_policy"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (id = (select auth.uid()) OR public.is_admin())
    WITH CHECK (
        public.is_admin()
        OR (
            id = (select auth.uid())
            AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (select auth.uid()))
            AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = (select auth.uid()))
        )
    );

-- 5. TABLE DES DOSSIERS OPÉRATIONNELS
CREATE TABLE IF NOT EXISTS public.dossiers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    no_dossier text NOT NULL UNIQUE,
    client text,
    statut text NOT NULL DEFAULT 'ouvert',
    description text,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dossiers IS 'Dossiers opérationnels référencés par les transactions de caisse de service "Opérations".';

CREATE INDEX IF NOT EXISTS idx_dossiers_created_by ON public.dossiers (created_by);

DROP TRIGGER IF EXISTS trg_dossiers_updated_at ON public.dossiers;
CREATE TRIGGER trg_dossiers_updated_at
    BEFORE UPDATE ON public.dossiers
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.dossiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dossiers_select_authenticated" ON public.dossiers;
CREATE POLICY "dossiers_select_authenticated"
    ON public.dossiers FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "dossiers_insert_by_role" ON public.dossiers;
CREATE POLICY "dossiers_insert_by_role"
    ON public.dossiers FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid())
              AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager')
        )
    );

DROP POLICY IF EXISTS "dossiers_update_by_role" ON public.dossiers;
CREATE POLICY "dossiers_update_by_role"
    ON public.dossiers FOR UPDATE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid())
              AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager')
        )
    );

DROP POLICY IF EXISTS "dossiers_delete_admin_only" ON public.dossiers;
CREATE POLICY "dossiers_delete_admin_only"
    ON public.dossiers FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid())
              AND profiles.role = 'admin'
        )
    );

-- 6. COMPTEURS ET GESTION ATOMIQUE DES PIÈCES COMPTABLES
CREATE TABLE IF NOT EXISTS public.cashier_piece_counters (
    annee integer PRIMARY KEY,
    dernier_numero integer NOT NULL DEFAULT 0
);

ALTER TABLE public.cashier_piece_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cashier_piece_counters_service_role" ON public.cashier_piece_counters;
CREATE POLICY "cashier_piece_counters_service_role"
    ON public.cashier_piece_counters FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

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
  -- Si une pièce est déjà fournie (non vide), on la respecte
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' THEN
    RETURN NEW;
  END IF;

  -- Détermination de l'année (depuis new.date ou année courante)
  annee_piece := COALESCE(
    NULLIF(substring(NEW.date from '^\d{4}'), '')::int,
    EXTRACT(YEAR FROM now())::int
  );

  -- Initialisation si non existant
  INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
  VALUES (annee_piece, 0)
  ON CONFLICT (annee) DO NOTHING;

  -- Boucle atomique : verrouille la ligne et incrémente jusqu'à trouver un numéro disponible
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

-- 7. TABLE DES TRANSACTIONS DE CAISSE
CREATE TABLE IF NOT EXISTS public.cashier_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    piece_comptable text UNIQUE,                                -- Numéro de pièce comptable unique (ex: CSH1/2026/00001)
    date text NOT NULL,                                        -- Format standard ISO YYYY-MM-DD
    libelle text NOT NULL,
    service text,                                              -- "Opérations", "Administration", etc.
    type_description text,
    category public.transaction_type_category NOT NULL,       -- entree (+) / sortie (-)
    status public.cashier_transaction_status NOT NULL DEFAULT 'draft',
    no_dossier text,                                            -- texte libre
    dossier_id uuid REFERENCES public.dossiers(id),
    first_name text,
    partenaire text,
    employee text,
    employee_id uuid REFERENCES public.profiles(id),
    quantity numeric,
    montant numeric NOT NULL,
    solde_apres numeric,
    selected boolean DEFAULT false,
    created_by uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_operations_requires_dossier
        CHECK (service <> 'Opérations' OR no_dossier IS NOT NULL OR dossier_id IS NOT NULL),
    CONSTRAINT chk_operations_requires_quantity
        CHECK (service <> 'Opérations' OR quantity IS NOT NULL)
);

COMMENT ON TABLE public.cashier_transactions IS 'Transactions de caisse (entrées/sorties) — correspond à l''interface CashierTransaction côté app.';
COMMENT ON COLUMN public.cashier_transactions.piece_comptable IS 'Numéro de pièce comptable unique (ex: CSH1/2026/00001) généré atomiquement.';
COMMENT ON COLUMN public.cashier_transactions.created_by IS 'Référence vers profiles.id — auteur de la transaction, utilisé par les policies RLS de mise à jour/suppression.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashier_transactions_piece_comptable ON public.cashier_transactions (piece_comptable) WHERE piece_comptable IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cashier_piece_comptable ON public.cashier_transactions (piece_comptable);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_date ON public.cashier_transactions (date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_category ON public.cashier_transactions (category);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_status ON public.cashier_transactions (status);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_service ON public.cashier_transactions (service);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_employee_id ON public.cashier_transactions (employee_id);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_dossier_id ON public.cashier_transactions (dossier_id);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_created_by ON public.cashier_transactions (created_by);

DROP TRIGGER IF EXISTS trg_assign_piece_comptable ON public.cashier_transactions;
CREATE TRIGGER trg_assign_piece_comptable
    BEFORE INSERT ON public.cashier_transactions
    FOR EACH ROW EXECUTE FUNCTION public.assign_piece_comptable();

DROP TRIGGER IF EXISTS trg_cashier_transactions_updated_at ON public.cashier_transactions;
CREATE TRIGGER trg_cashier_transactions_updated_at
    BEFORE UPDATE ON public.cashier_transactions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cashier_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cashier_transactions_select_by_role" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_select_by_role"
    ON public.cashier_transactions FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid())
              AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager', 'comptable', 'tresorier')
        )
    );

DROP POLICY IF EXISTS "cashier_transactions_insert_by_role" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_insert_by_role"
    ON public.cashier_transactions FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid())
              AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager')
        )
    );

DROP POLICY IF EXISTS "cashier_transactions_update_own_or_admin" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_update_own_or_admin"
    ON public.cashier_transactions FOR UPDATE
    TO authenticated
    USING (
        public.is_admin()
        OR created_by = (select auth.uid())
        OR employee_id = (select auth.uid())
    )
    WITH CHECK (
        public.is_admin()
        OR created_by = (select auth.uid())
        OR employee_id = (select auth.uid())
    );

DROP POLICY IF EXISTS "cashier_transactions_delete_own_or_admin" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_delete_own_or_admin"
    ON public.cashier_transactions FOR DELETE
    TO authenticated
    USING (
        public.is_admin()
        OR created_by = (select auth.uid())
        OR employee_id = (select auth.uid())
    );

-- 8. TABLE DES LOGS D'AUDIT
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action text NOT NULL,
    entity_id text,
    user_id uuid REFERENCES auth.users(id),
    user_email text,
    user_role text,
    details jsonb,
    ip_address text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON public.audit_logs (user_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_logs_service_role" ON public.audit_logs;
CREATE POLICY "audit_logs_service_role"
    ON public.audit_logs FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "audit_logs_admin_select" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_select"
    ON public.audit_logs FOR SELECT
    TO authenticated
    USING (public.is_admin());
