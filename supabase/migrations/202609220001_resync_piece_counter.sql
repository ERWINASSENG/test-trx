-- Migration de resynchronisation et fiabilisation de l'attribution des pièces comptables.
-- 1. Resynchronise immédiatement le compteur sur le MAX réel présent dans cashier_transactions.
-- 2. Rend le trigger résilient : boucle de rattrapage automatique si un numéro a été inséré manuellement.

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
  candidat_piece text;
  existe boolean;
BEGIN
  -- Si une pièce est fournie manuellement (non vide), on la conserve telle quelle
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' THEN
    RETURN NEW;
  END IF;

  -- Détermination de l'année (depuis new.date ou année courante)
  annee_piece := COALESCE(
    NULLIF(substring(NEW.date from '^\d{4}'), '')::int,
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

DROP TRIGGER IF EXISTS trg_assign_piece_comptable ON public.cashier_transactions;
CREATE TRIGGER trg_assign_piece_comptable
  BEFORE INSERT ON public.cashier_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_piece_comptable();

-- Recalage immédiat des compteurs d'années sur les numéros les plus élevés actuellement en base
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
