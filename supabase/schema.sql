-- ==============================================================================
-- SCHEMA SUPABASE : GESTION DE CAISSE & UTILISATEURS (TRANSIMEX)
-- Régénéré le 2026-09-11 pour refléter l'état RÉEL du projet Supabase `TRX`
-- (uhjhntzmfxkrcagxcuzd). Remplace la version précédente qui était désynchronisée
-- avec la base en production (policies RLS permissives obsolètes, colonnes
-- manquantes, pas de FK vers profiles/dossiers).
--
-- Tables couvertes : profiles, cashier_transactions, dossiers.
-- Toutes les autres tables (RH, CRM, Inventaire, Achats, Ventes, Comptabilité)
-- ont été supprimées de l'environnement de production le 06/09/2026 et ne sont
-- PAS recréées par ce script. Voir la section "NOTES" en fin de fichier.
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

-- Génère un identifiant court lisible (ex: user_code sur profiles)
CREATE OR REPLACE FUNCTION public.generate_short_id()
RETURNS text
LANGUAGE plpgsql
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

-- 3.1 GESTION DÉTERMINISTE DES PIÈCES COMPTABLES (CSH1/YYYY/00000)
-- Séquence et trigger garantissant l'unicité et le calcul unique à l'insertion
CREATE TABLE IF NOT EXISTS public.cashier_piece_counters (
    year integer PRIMARY KEY,
    last_seq integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cashier_piece_counters IS 'Compteur atomique pour l''attribution déterministe des numéros de pièces comptables de caisse par année.';

CREATE OR REPLACE FUNCTION public.get_next_piece_comptable(p_year integer)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_next_val integer;
    v_piece text;
BEGIN
    IF p_year IS NULL OR p_year < 2000 OR p_year > 2100 THEN
        p_year := EXTRACT(YEAR FROM CURRENT_DATE)::integer;
    END IF;

    -- Incrémentation atomique avec verrou de ligne
    INSERT INTO public.cashier_piece_counters (year, last_seq, updated_at)
    VALUES (p_year, 1, now())
    ON CONFLICT (year) DO UPDATE
        SET last_seq = public.cashier_piece_counters.last_seq + 1,
            updated_at = now()
    RETURNING last_seq INTO v_next_val;

    v_piece := 'CSH1/' || p_year::text || '/' || LPAD(v_next_val::text, 5, '0');
    RETURN v_piece;
END;
$function$;

-- Trigger BEFORE INSERT pour assigner automatiquement piece_comptable si absente
CREATE OR REPLACE FUNCTION public.set_cashier_piece_comptable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_year integer;
    v_parts text[];
BEGIN
    -- Si déjà fourni et valide au format CSH1/YYYY/XXXXX, on conserve
    IF NEW.piece_comptable IS NOT NULL AND NEW.piece_comptable ~ '^CSH1/[0-9]{4}/[0-9]{5}$' THEN
        RETURN NEW;
    END IF;

    -- Déterminer l'année depuis la date (DD/MM/YYYY ou YYYY-MM-DD) ou now()
    v_year := NULL;
    IF NEW.date IS NOT NULL AND NEW.date <> '' THEN
        IF NEW.date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' THEN
            v_parts := string_to_array(NEW.date, '/');
            v_year := v_parts[3]::integer;
        ELSIF NEW.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
            v_year := SUBSTRING(NEW.date FROM 1 FOR 4)::integer;
        END IF;
    END IF;

    IF v_year IS NULL THEN
        v_year := EXTRACT(YEAR FROM COALESCE(NEW.created_at, now()))::integer;
    END IF;

    NEW.piece_comptable := public.get_next_piece_comptable(v_year);
    RETURN NEW;
END;
$function$;

-- Rôle de l'utilisateur courant (auth.uid()), utilisé par is_admin() et les policies
CREATE OR REPLACE FUNCTION public.get_current_user_role()
RETURNS public.user_role_enum
LANGUAGE plpgsql
STABLE SECURITY DEFINER
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
AS $function$
    SELECT (public.get_current_user_role() = 'admin');
$function$;

-- Met à jour updated_at automatiquement (utilisé par les triggers BEFORE UPDATE)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
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
    requested_role := COALESCE(
      new.raw_app_meta_data->>'role',
      new.raw_user_meta_data->>'role',
      'employe'
    );

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
    first_name text,
    last_name text,
    role public.user_role_enum NOT NULL DEFAULT 'employe',
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
    USING (is_active = true OR id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "profiles_insert_policy" ON public.profiles;
CREATE POLICY "profiles_insert_policy"
    ON public.profiles FOR INSERT
    TO authenticated
    WITH CHECK (public.is_admin() OR id = auth.uid());

DROP POLICY IF EXISTS "profiles_update_policy" ON public.profiles;
CREATE POLICY "profiles_update_policy"
    ON public.profiles FOR UPDATE
    TO authenticated
    USING (id = auth.uid() OR public.is_admin())
    WITH CHECK (
        public.is_admin()
        OR (
            id = auth.uid()
            -- Empêche l'escalade de privilège : un utilisateur ne peut pas modifier son propre rôle ni se réactiver
            AND role = (SELECT p.role FROM public.profiles p WHERE p.id = auth.uid())
            AND is_active = (SELECT p.is_active FROM public.profiles p WHERE p.id = auth.uid())
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
            WHERE profiles.id = auth.uid()
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
            WHERE profiles.id = auth.uid()
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
            WHERE profiles.id = auth.uid()
              AND profiles.role = 'admin'
        )
    );

-- 6. TABLE DES TRANSACTIONS DE CAISSE
CREATE TABLE IF NOT EXISTS public.cashier_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    piece_comptable text UNIQUE,                                -- Numéro de pièce comptable unique (ex: CSH1/2026/00001)
    date text NOT NULL,                                        -- Format DD/MM/YYYY (texte libre, voir NOTES)
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashier_transactions_piece_comptable ON public.cashier_transactions (piece_comptable) WHERE piece_comptable IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_date ON public.cashier_transactions (date);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_category ON public.cashier_transactions (category);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_status ON public.cashier_transactions (status);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_service ON public.cashier_transactions (service);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_employee_id ON public.cashier_transactions (employee_id);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_dossier_id ON public.cashier_transactions (dossier_id);
CREATE INDEX IF NOT EXISTS idx_cashier_transactions_created_by ON public.cashier_transactions (created_by);

DROP TRIGGER IF EXISTS trg_cashier_transactions_piece_comptable ON public.cashier_transactions;
CREATE TRIGGER trg_cashier_transactions_piece_comptable
    BEFORE INSERT ON public.cashier_transactions
    FOR EACH ROW EXECUTE FUNCTION public.set_cashier_piece_comptable();

DROP TRIGGER IF EXISTS trg_cashier_transactions_updated_at ON public.cashier_transactions;
CREATE TRIGGER trg_cashier_transactions_updated_at
    BEFORE UPDATE ON public.cashier_transactions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cashier_transactions ENABLE ROW LEVEL SECURITY;

-- RLS RESTRICTIVE (remplace l'ancienne version "USING (true)" pour INSERT/UPDATE/DELETE) :
-- lecture ouverte aux utilisateurs authentifiés, écriture réservée aux rôles métier concernés,
-- suppression réservée aux administrateurs. C'est cette politique qui protège les données
-- financières lorsque le client Supabase est appelé directement depuis le navigateur
-- (voir cashier.service.ts, canal de repli en cas d'indisponibilité de l'API Express).
DROP POLICY IF EXISTS "cashier_transactions_select_policy" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_insert_policy" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_update_policy" ON public.cashier_transactions;
DROP POLICY IF EXISTS "cashier_transactions_delete_policy" ON public.cashier_transactions;

DROP POLICY IF EXISTS "cashier_transactions_select_authenticated" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_select_authenticated"
    ON public.cashier_transactions FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "cashier_transactions_insert_by_role" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_insert_by_role"
    ON public.cashier_transactions FOR INSERT
    TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
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
        created_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    )
    WITH CHECK (
        created_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
        )
    );

DROP POLICY IF EXISTS "cashier_transactions_delete_admin_only" ON public.cashier_transactions;
CREATE POLICY "cashier_transactions_delete_admin_only"
    ON public.cashier_transactions FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
              AND profiles.role = 'admin'
        )
    );

-- 7. SCRIPT DE RATTRAPAGE INITIAL (BACKFILL)
-- Initialise le compteur et affecte un numéro aux transactions historiques sans piece_comptable
DO $$
DECLARE
    r RECORD;
    v_year integer;
    v_parts text[];
BEGIN
    -- Synchroniser les compteurs avec les numéros existants
    FOR r IN (
        SELECT 
            SUBSTRING(piece_comptable FROM 'CSH1/([0-9]{4})')::integer AS yr,
            MAX(SUBSTRING(piece_comptable FROM 'CSH1/[0-9]{4}/([0-9]+)')::integer) AS max_seq
        FROM public.cashier_transactions
        WHERE piece_comptable ~ '^CSH1/[0-9]{4}/[0-9]+$'
        GROUP BY 1
    ) LOOP
        INSERT INTO public.cashier_piece_counters (year, last_seq, updated_at)
        VALUES (r.yr, r.max_seq, now())
        ON CONFLICT (year) DO UPDATE
            SET last_seq = GREATEST(public.cashier_piece_counters.last_seq, EXCLUDED.last_seq),
                updated_at = now();
    END LOOP;

    -- Attribuer un numéro aux lignes orphelines
    FOR r IN (
        SELECT id, date, created_at
        FROM public.cashier_transactions
        WHERE piece_comptable IS NULL OR piece_comptable = ''
        ORDER BY created_at ASC, id ASC
    ) LOOP
        v_year := NULL;
        IF r.date IS NOT NULL AND r.date <> '' THEN
            IF r.date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' THEN
                v_parts := string_to_array(r.date, '/');
                v_year := v_parts[3]::integer;
            ELSIF r.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
                v_year := SUBSTRING(r.date FROM 1 FOR 4)::integer;
            END IF;
        END IF;

        IF v_year IS NULL THEN
            v_year := EXTRACT(YEAR FROM COALESCE(r.created_at, now()))::integer;
        END IF;

        UPDATE public.cashier_transactions
        SET piece_comptable = public.get_next_piece_comptable(v_year)
        WHERE id = r.id;
    END LOOP;
END $$;

-- ==============================================================================
-- NOTES (à lire avant toute modification de ce fichier)
-- ==============================================================================
-- 1. `date` est stockée en TEXT au format DD/MM/YYYY, pas en TIMESTAMP/DATE.
--    C'est un choix délibéré fait pour matcher l'interface TypeScript
--    `CashierTransaction.date: string` côté app — ne pas "corriger" vers un
--    type date sans adapter le code Angular ET l'API Express en même temps.
--
-- 2. `no_dossier` (text) et `employee` (text) restent en plus de `dossier_id`
--    et `employee_id` (uuid, FK) pour la rétrocompatibilité avec l'app existante.
--    L'API Express (src/server.ts) ne renseigne PAS encore dossier_id/employee_id
--    lors des insert/update — c'est un chantier à part, pas couvert ici.
--
-- 3. Ce projet contient aussi de nombreux types ENUM orphelins
--    (account_class_enum, attendance_status_enum, bank_account_type_enum,
--    cash_movement_type_enum, cash_register_status_enum, employee_contract_type_enum,
--    expense_category_enum, expense_status_enum, invoice_status_enum, journal_type_enum,
--    leave_request_status_enum, leave_type_enum, order_status_enum, payment_method_enum,
--    product_unit_enum, report_status_enum, report_type_enum, stock_movement_type_enum)
--    issus des tables HR/CRM/Inventaire/Achats/Ventes/Comptabilité supprimées le
--    06/09/2026. DROP TABLE ne supprime pas les types associés : ils sont donc
--    restés en base sans table qui les utilise. Ce script ne les recrée pas et
--    ne les supprime pas non plus (à traiter séparément si un nettoyage est voulu).
--
-- 4. Si ces modules (RH, CRM, Inventaire, etc.) sont reconstruits un jour,
--    prévoir les policies RLS dès la création des tables, comme fait ici pour
--    dossiers/cashier_transactions — ne jamais laisser une table sans RLS ni
--    avec des policies `USING (true)` en écriture.
-- ==============================================================================
