-- ==============================================================================
-- Migration : Correctif de durcissement de sécurité (20261022130000)
-- 1. Révocation des privilèges publics sur la fonction trigger SECURITY DEFINER
-- 2. Sécurisation de l'attribution séquentielle des pièces comptables
-- 3. Protection de l'intégrité et de l'immuabilité des opérations de caisse
-- 4. Protection de l'identité des profils utilisateurs
-- ==============================================================================

-- 1. Révocation de l'accès public/anonyme sur validate_sales_quote_contact
REVOKE ALL ON FUNCTION public.validate_sales_quote_contact() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_sales_quote_contact() TO service_role;

-- 2. Durcissement de l'attribution des pièces comptables (interdit l'injection manuelle)
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
  -- Si l'appelant est un utilisateur connecté non-administrateur,
  -- toute tentative de forcer manuellement une pièce comptable est neutralisée.
  IF (SELECT auth.uid()) IS NOT NULL AND NOT public.is_admin() THEN
    NEW.piece_comptable := NULL;
  END IF;

  -- Si un administrateur ou un script interne a déjà fourni une pièce comptable valide, on la conserve.
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' THEN
    RETURN NEW;
  END IF;

  annee_piece := COALESCE(
    NULLIF(substring(NEW.date from '^\d{4}'), '')::int,
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

    candidat_piece := 'CSH1/' || annee_piece::text || '/' || lpad(prochain_numero::text, 5, '0');

    SELECT EXISTS (
      SELECT 1 FROM public.cashier_transactions
      WHERE piece_comptable = candidat_piece
    ) INTO existe;

    IF NOT existe THEN
      NEW.piece_comptable := candidat_piece;
      EXIT;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_piece_comptable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_piece_comptable() TO service_role;

-- 3. Protection de l'intégrité et immuabilité des pièces comptables sur UPDATE
CREATE OR REPLACE FUNCTION public.protect_cashier_transaction_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL AND NOT public.is_admin() THEN
    -- Immuabilité de la pièce comptable une fois attribuée
    IF OLD.piece_comptable IS NOT NULL AND NEW.piece_comptable IS DISTINCT FROM OLD.piece_comptable THEN
      RAISE EXCEPTION 'Le numéro de pièce comptable est immuable.'
        USING ERRCODE = '42501';
    END IF;

    -- Interdiction de valider directement le statut 'posted' sans passer par les contrôles serveur
    IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
      RAISE EXCEPTION 'La comptabilisation directe par PostgREST est refusée. Veuillez passer par le circuit de caisse applicatif.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.protect_cashier_transaction_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_cashier_transaction_integrity() TO service_role;

DROP TRIGGER IF EXISTS trg_protect_cashier_transaction_integrity ON public.cashier_transactions;
CREATE TRIGGER trg_protect_cashier_transaction_integrity
  BEFORE UPDATE ON public.cashier_transactions
  FOR EACH ROW EXECUTE FUNCTION public.protect_cashier_transaction_integrity();

-- 4. Protection des colonnes d'identité du profil utilisateur
CREATE OR REPLACE FUNCTION public.protect_profile_identity_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF (SELECT auth.uid()) IS NOT NULL AND NOT public.is_admin() THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.user_code IS DISTINCT FROM OLD.user_code THEN
      RAISE EXCEPTION 'Les colonnes d’identité d’un profil ne peuvent pas être modifiées par l’utilisateur.'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.protect_profile_identity_columns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_profile_identity_columns() TO service_role;

DROP TRIGGER IF EXISTS trg_protect_profile_identity ON public.profiles;
CREATE TRIGGER trg_protect_profile_identity
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_identity_columns();

