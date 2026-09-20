-- ==============================================================================
-- SCHEMA SUPABASE : GESTION DE CAISSE & UTILISATEURS (TRANSIMEX / DIGITALTRX)
-- Régénéré le 2026-09-18 pour refléter l'état RÉEL du projet Supabase
-- `Digitaltrx` (acpnphsvdcvagljlcrvl), vérifié colonne par colonne, policy par
-- policy et fonction par fonction contre la base de production.
--
-- Corrige les dérives suivantes trouvées entre l'ancien schema.sql et la prod :
--   1. Colonne `cashier_transactions.created_by` (uuid, défaut auth.uid())
--      manquante dans le CREATE TABLE alors que policies/index la référençaient
--      → aurait fait échouer ce script sur une base neuve.
--   2. Fonction `handle_updated_at()` et son trigger `set_profiles_updated_at`
--      sur `profiles` existent en prod mais étaient absents du fichier.
--   3. `profiles.role` a pour défaut réel `'agent'`, pas `'employe'`.
--   4. `profiles.first_name` / `last_name` sont NOT NULL en prod, pas nullable.
--   5. Policies RLS optimisées : `auth.uid()` remplacé par `(select auth.uid())`
--      partout pour éviter une ré-évaluation par ligne (perf à l'échelle).
--   6. Toutes les fonctions ont `SET search_path TO 'public'` (sécurité).
--   7. Table `audit_logs` ajoutée (journal d'audit dédié).
--   8. Index supplémentaires trouvés en prod : idx_cashier_piece_comptable,
--      idx_profiles_department, idx_profiles_email, idx_profiles_role,
--      idx_dossiers_created_by.
--
-- Tables couvertes : profiles, dossiers, cashier_transactions, audit_logs.
-- Toutes les autres tables (RH, CRM, Inventaire, Achats, Ventes, Comptabilité)
-- ont été supprimées de l'environnement de production le 06/09/2026 et ne sont
-- PAS recréées par ce script.
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
    CREATE TYPE public.cashier_transaction_status AS ENUM ('draft', 'posted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. FONCTIONS UTILITAIRES
-- Toutes fixent search_path pour éviter le hijacking de schéma (advisory sécurité).

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

-- Rôle de l'utilisateur courant (auth.uid()), utilisé par is_admin() et les policies
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

-- Met à jour updated_at automatiquement (utilisé par dossiers/cashier_transactions)
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

-- Équivalent utilisé par le trigger sur profiles (trouvé en prod, absent de
-- l'ancien fichier) — même logique que set_updated_at(), nom historique différent.
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

-- Crée automatiquement une ligne public.profiles à la création d'un auth.users
-- SÉCURITÉ : le rôle est dérivé de app_metadata en priorité (scellé serveur),
-- jamais fait confiance aveuglément à un rôle arbitraire fourni par le client.
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
        -- Le rôle ne peut venir que de app_metadata, écrit par le serveur admin.
        -- user_metadata est contrôlable par l'utilisateur et ne doit jamais accorder de droits.
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

-- Accès complet pour le rôle service_role (utilisé par le serveur Express avec la clé service_role)
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
            -- Empêche l'escalade de privilège : un utilisateur ne peut pas modifier son propre rôle ni se réactiver
            AND role = (SELECT p.role FROM public.profiles p WHERE p.id = (select auth.uid()))
            AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = (select auth.uid()))
        )
    );

-- 5. TABLE DES DOSSIERS OPÉRATIONNELS
-- Référencée par les transactions de caisse dont service = 'Opérations'.
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

-- 6. TABLE DES TRANSACTIONS DE CAISSE
CREATE TABLE IF NOT EXISTS public.cashier_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    piece_comptable text UNIQUE,                                -- Numéro de pièce comptable unique (ex: CSH1/2026/00001)
    date text NOT NULL,                                        -- Format standard ISO YYYY-MM-DD (tri chronologique strict, voir NOTES)
    libelle text NOT NULL,
    service text,                                              -- "Opérations", "Administration", etc.
    type_description text,
    category public.transaction_type_category NOT NULL,       -- entree (+) / sortie (-)
    status public.cashier_transaction_status NOT NULL DEFAULT 'draft',
    no_dossier text,                                            -- texte libre, conservé pour rétrocompatibilité
    dossier_id uuid REFERENCES public.dossiers(id),             -- référence forte, alimentation encore à faire côté API
    first_name text,
    partenaire text,
    employee text,                                              -- texte libre, conservé pour rétrocompatibilité
    employee_id uuid REFERENCES public.profiles(id),            -- référence forte, alimentation encore à faire côté API
    quantity numeric,                                            -- requis si service = 'Opérations'
    montant numeric NOT NULL,                                    -- valeur signée
    solde_apres numeric,
    selected boolean DEFAULT false,
    -- Colonne manquante dans l'ancien fichier : existe réellement en prod avec
    -- ce défaut. src/server.ts insère created_by explicitement depuis le
    -- service_role ; le défaut ne joue que si un insert passe directement par
    -- le client Supabase (RLS) sans transiter par l'API Express.
    created_by uuid REFERENCES public.profiles(id) DEFAULT auth.uid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_operations_requires_dossier
        CHECK (service <> 'Opérations' OR no_dossier IS NOT NULL OR dossier_id IS NOT NULL),
    CONSTRAINT chk_operations_requires_quantity
        CHECK (service <> 'Opérations' OR quantity IS NOT NULL)
);

COMMENT ON TABLE public.cashier_transactions IS 'Transactions de caisse (entrées/sorties) — correspond à l''interface CashierTransaction côté app.';
COMMENT ON COLUMN public.cashier_transactions.piece_comptable IS 'Numéro de pièce comptable unique (ex: CSH1/2026/00001) garantissant l''absence de doublon.';
COMMENT ON COLUMN public.cashier_transactions.employee_id IS 'Référence forte vers profiles.id — employee/firstName restent en texte libre pour rétrocompatibilité.';
COMMENT ON COLUMN public.cashier_transactions.dossier_id IS 'Référence forte vers dossiers.id — no_dossier reste en texte libre pour rétrocompatibilité.';
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

DROP TRIGGER IF EXISTS trg_cashier_transactions_updated_at ON public.cashier_transactions;
CREATE TRIGGER trg_cashier_transactions_updated_at
    BEFORE UPDATE ON public.cashier_transactions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cashier_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cashier_transactions_select_policy" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_insert_policy" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_update_policy" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_delete_policy" ON public.cashier_transactions;

DROP POLICY IF EXISTS "cashier_transactions_select_authenticated" ON public.cashier_transactions;
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
              AND profiles.role IN ('admin', 'caissier', 'caissiere', 'manager', 'comptable', 'tresorier')
        )
    );

-- RÈGLE MÉTIER : chacun ne modifie que ce qu'il a lui-même enregistré (created_by = auth.uid()).
-- Un manager ne peut pas modifier une saisie de caissier, et un caissier ne peut pas modifier
-- celle d'un collègue, même s'ils travaillent tous sur le même tableau. Seul un admin déroge.
DROP POLICY IF EXISTS "cashier_transactions_update_by_role" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_update_own_or_admin" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_update_own_or_admin"
    ON public.cashier_transactions FOR UPDATE
    TO authenticated
    USING (
        created_by = (select auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid()) AND profiles.role = 'admin'
        )
    )
    WITH CHECK (
        created_by = (select auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid()) AND profiles.role = 'admin'
        )
    );

DROP POLICY IF EXISTS "cashier_transactions_delete_admin_only" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_delete_own_or_admin" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_delete_own_or_admin"
    ON public.cashier_transactions FOR DELETE
    TO authenticated
    USING (
        created_by = (select auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = (select auth.uid())
              AND profiles.role = 'admin'
        )
    );

-- 7. TABLE DES JOURNAUX D'AUDIT (AUDIT LOGS)
-- Trace les actions critiques (création, mise à jour, suppression) sur la caisse et la sécurité.
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    user_email text,
    user_role text,
    action text NOT NULL,                                       -- 'CREATE_OPERATION', 'UPDATE_OPERATION', 'DELETE_OPERATION', 'LOGIN_SUCCESS', etc.
    entity_type text NOT NULL DEFAULT 'cashier_transaction',   -- 'cashier_transaction', 'profile', 'auth', etc.
    entity_id text,                                            -- ID de la ressource concernée
    details jsonb DEFAULT '{}'::jsonb,                         -- Données contextuelles (champs modifiés, IP, etc.)
    ip_address text,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_logs IS 'Journaux d''audit et de traçabilité des opérations de caisse et de sécurité.';
COMMENT ON COLUMN public.audit_logs.action IS 'Type d''action tracée (ex: CREATE_OPERATION, UPDATE_OPERATION, DELETE_OPERATION).';
COMMENT ON COLUMN public.audit_logs.details IS 'Contenu JSON des modifications ou métadonnées contextuelles de l''action.';

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON public.audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_logs_service_role_all" ON public.audit_logs;
CREATE POLICY "audit_logs_service_role_all"
    ON public.audit_logs FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "audit_logs_admin_select" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_select"
    ON public.audit_logs FOR SELECT
    TO authenticated
    USING (public.is_admin());

DROP POLICY IF EXISTS "audit_logs_insert_authenticated" ON public.audit_logs;
CREATE POLICY "audit_logs_insert_authenticated"
    ON public.audit_logs FOR INSERT
    TO authenticated
    WITH CHECK (
        (select auth.uid()) IS NOT NULL
        AND (user_id IS NULL OR user_id = (select auth.uid()))
    );

-- ==============================================================================
-- NOTES (à lire avant toute modification de ce fichier)
-- ==============================================================================
-- 1. `date` est stockée en TEXT au format standard ISO YYYY-MM-DD.
--    Ce format garantit que l'ordre lexicographique PostgreSQL (.order('date', { ascending: false }))
--    est strictement identique à l'ordre chronologique temporel, sans inversion lors
--    de la pagination serveur ou des changements de mois/années. Côté UI client,
--    l'affichage en JJ/MM/AAAA est assuré de manière transparente par formatIsoToDisplayDate().
--
-- 2. `no_dossier` (text) et `employee` (text) restent en plus de `dossier_id`
--    et `employee_id` (uuid, FK) pour la rétrocompatibilité avec l'app existante.
--
-- 3. Ce projet contient aussi de nombreux types ENUM orphelins issus des
--    tables HR/CRM/Inventaire/Achats/Ventes/Comptabilité supprimées le
--    06/09/2026 (account_class_enum, attendance_status_enum, etc.). DROP
--    TABLE ne supprime pas les types associés : ils sont restés en base sans
--    table qui les utilise. Ce script ne les recrée pas et ne les supprime pas.
--
-- 4. Ce fichier a été régénéré à la main colonne par colonne / policy par
--    policy contre `information_schema` et `pg_policies` de la base réelle.
--    Pour toute future dérive, préférer `supabase db dump --schema public`
--    directement depuis la CLI pour garder ce fichier synchronisé automatiquement.
-- ==============================================================================

-- ==============================================================================
-- SCRIPT DE MIGRATION MANUELLE (Optionnel - le serveur auto-migre au démarrage)
-- ==============================================================================
-- UPDATE public.cashier_transactions
-- SET date = substring(date from 7 for 4) || '-' || substring(date from 4 for 2) || '-' || substring(date from 1 for 2)
-- WHERE date LIKE '__/__/____';
--
-- CREATE INDEX IF NOT EXISTS idx_cashier_transactions_date
-- ON public.cashier_transactions (date DESC, created_at DESC);
-- ==============================================================================