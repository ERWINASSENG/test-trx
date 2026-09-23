-- Génère le numéro de pièce comptable de façon atomique côté serveur (PostgreSQL),
-- pour éliminer le risque de trou/désordre lié au calcul actuel côté client
-- (max des pièces déjà chargées + 1, sans verrouillage).
-- À appliquer avec Supabase CLI ou dans l'éditeur SQL de Supabase.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cashier_piece_counters (
  annee integer PRIMARY KEY,
  dernier_numero integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.assign_piece_comptable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  annee_piece integer;
  prochain_numero integer;
BEGIN
  -- Si une pièce est déjà fournie (import historique, saisie manuelle), on la respecte
  -- telle quelle ; l'unicité reste garantie par la contrainte UNIQUE existante.
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' THEN
    RETURN NEW;
  END IF;

  -- new.date est au format texte 'YYYY-MM-DD' ; repli sur l'année courante si absent/invalide.
  annee_piece := COALESCE(
    NULLIF(substring(NEW.date from '^\d{4}'), '')::int,
    EXTRACT(YEAR FROM now())::int
  );

  -- INSERT ... ON CONFLICT DO UPDATE verrouille la ligne du compteur de l'année :
  -- deux transactions concurrentes sont sérialisées, aucun trou ni doublon possible.
  INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
  VALUES (annee_piece, 1)
  ON CONFLICT (annee) DO UPDATE
    SET dernier_numero = public.cashier_piece_counters.dernier_numero + 1
  RETURNING dernier_numero INTO prochain_numero;

  NEW.piece_comptable := 'CSH1/' || annee_piece || '/' || lpad(prochain_numero::text, 5, '0');

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_assign_piece_comptable ON public.cashier_transactions;
CREATE TRIGGER trg_assign_piece_comptable
  BEFORE INSERT ON public.cashier_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_piece_comptable();

-- Amorce chaque compteur d'année sur le numéro déjà atteint par les pièces existantes,
-- pour ne jamais reproduire un numéro déjà attribué manuellement.
INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
SELECT
  (regexp_match(piece_comptable, '^CSH1/(\d{4})/(\d+)$'))[1]::int AS annee,
  MAX((regexp_match(piece_comptable, '^CSH1/(\d{4})/(\d+)$'))[2]::int) AS dernier_numero
FROM public.cashier_transactions
WHERE piece_comptable ~ '^CSH1/\d{4}/\d+$'
GROUP BY 1
ON CONFLICT (annee) DO UPDATE
  SET dernier_numero = GREATEST(public.cashier_piece_counters.dernier_numero, EXCLUDED.dernier_numero);

COMMIT;
