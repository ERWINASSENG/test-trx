-- ==============================================================================
-- Migration : Réalignement de la séquence de pièces comptables de caisse (CSH1)
-- Date      : 2026-09-26
-- Contexte  : Correction de la rupture de séquence (00017 -> 00011) et sécurisation
--             du compteur d'incrémentation pour éviter tout trou orphelin.
-- ==============================================================================

-- 1. Réalignement de la dernière transaction vers 00011 si nécessaire
UPDATE public.cashier_transactions
SET piece_comptable = 'CSH1/2026/00011'
WHERE piece_comptable IN ('CSH1/2026/00016', 'CSH1/2026/00017');

-- 2. Recalage strict du compteur sur le MAX réel des transactions existantes
WITH max_piece AS (
  SELECT
    COALESCE(
      MAX(
        CASE
          WHEN piece_comptable ~ '^CSH1\/2026\/\d{5}$'
          THEN (substring(piece_comptable from 'CSH1\/2026\/(\d{5})'))::integer
          ELSE 0
        END
      ),
      0
    ) AS val
  FROM public.cashier_transactions
)
INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
SELECT 2026, max_piece.val
FROM max_piece
ON CONFLICT (annee) DO UPDATE
SET dernier_numero = EXCLUDED.dernier_numero;

-- 3. Amélioration de la fonction de génération automatique pour garantir
--    une continuité séquentielle sans trou même après suppressions ou tests
CREATE OR REPLACE FUNCTION public.assign_cashier_piece_comptable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_annee INTEGER;
  v_nouveau_numero INTEGER;
  v_max_existant INTEGER;
  v_candidat_piece TEXT;
BEGIN
  -- Si une pièce valide et explicite est déjà fournie, on la conserve
  IF NEW.piece_comptable IS NOT NULL AND BTRIM(NEW.piece_comptable) <> '' THEN
    RETURN NEW;
  END IF;

  -- Détermination de l'année comptable
  IF NEW.date IS NOT NULL AND NEW.date <> '' THEN
    BEGIN
      v_annee := EXTRACT(YEAR FROM (NEW.date)::timestamptz)::INTEGER;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        v_annee := EXTRACT(YEAR FROM (NEW.date)::date)::INTEGER;
      EXCEPTION WHEN OTHERS THEN
        v_annee := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
      END;
    END;
  ELSE
    v_annee := EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER;
  END IF;

  -- Vérifier le MAX réel présent en base pour cette année
  SELECT COALESCE(
    MAX(
      CASE
        WHEN piece_comptable ~ ('^CSH1\/' || v_annee || '\/\d{5}$')
        THEN (substring(piece_comptable from ('CSH1\/' || v_annee || '\/(\d{5})')))::integer
        ELSE 0
      END
    ),
    0
  )
  INTO v_max_existant
  FROM public.cashier_transactions;

  -- Verrouillage de la ligne compteur pour l'année afin d'éviter toute concurrence
  INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
  VALUES (v_annee, v_max_existant)
  ON CONFLICT (annee) DO NOTHING;

  SELECT dernier_numero INTO v_nouveau_numero
  FROM public.cashier_piece_counters
  WHERE annee = v_annee
  FOR UPDATE;

  -- Si le compteur en table s'est désynchronisé au-dessus du MAX réel existant, on le recolle
  IF v_nouveau_numero < v_max_existant OR v_nouveau_numero > v_max_existant THEN
    v_nouveau_numero := v_max_existant;
  END IF;

  -- Recherche de la première référence libre
  LOOP
    v_nouveau_numero := v_nouveau_numero + 1;
    v_candidat_piece := 'CSH1/' || v_annee || '/' || LPAD(v_nouveau_numero::TEXT, 5, '0');

    IF NOT EXISTS (
      SELECT 1 FROM public.cashier_transactions WHERE piece_comptable = v_candidat_piece
    ) THEN
      EXIT;
    END IF;
  END LOOP;

  -- Mise à jour du compteur
  UPDATE public.cashier_piece_counters
  SET dernier_numero = v_nouveau_numero
  WHERE annee = v_annee;

  NEW.piece_comptable := v_candidat_piece;
  RETURN NEW;
END;
$$;
