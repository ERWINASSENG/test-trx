-- ====================================================================
-- Migration: Autorisation de suppression réservée à l'administrateur
-- et recompactage automatique des numéros de pièce sans trou.
-- ====================================================================

-- 1. Durcissement RLS : suppression réservée exclusivement à l'administrateur actif
DROP POLICY IF EXISTS cashier_transactions_delete_own_or_admin ON public.cashier_transactions;
DROP POLICY IF EXISTS cashier_transactions_delete_admin_only ON public.cashier_transactions;

CREATE POLICY cashier_transactions_delete_admin_only ON public.cashier_transactions
  FOR DELETE
  USING (private.is_active_user() AND private.is_admin());

-- 2. Fonction de recompactage des pièces de caisse après suppression
CREATE OR REPLACE FUNCTION public.recompact_cashier_pieces_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r_year RECORD;
  v_counter INT;
BEGIN
  -- Parcourir chaque année présente dans les pièces de caisse CSH1
  FOR r_year IN (
    SELECT DISTINCT (substring(piece_comptable from '^CSH1/(\d{4})/'))::int AS annee
    FROM public.cashier_transactions
    WHERE piece_comptable LIKE 'CSH1/%'
  ) LOOP
    IF r_year.annee IS NOT NULL THEN
      -- Étape 1 : renommage temporaire pour éviter toute violation d'unicité pendant le reclassement
      WITH ordered AS (
        SELECT
          id,
          row_number() OVER (
            ORDER BY
              COALESCE(NULLIF(substring(piece_comptable from '/(\d+)$'), '')::bigint, 0) ASC,
              date ASC,
              created_at ASC,
              id ASC
          ) AS rn
        FROM public.cashier_transactions
        WHERE piece_comptable LIKE 'CSH1/' || r_year.annee || '/%'
      )
      UPDATE public.cashier_transactions t
      SET piece_comptable = 'TMP_' || r_year.annee || '_' || ordered.rn || '_' || t.id
      FROM ordered
      WHERE t.id = ordered.id;

      -- Étape 2 : assignation définitive des numéros continus sans trou (CSH1/AAAA/00001, etc.)
      UPDATE public.cashier_transactions
      SET piece_comptable = 'CSH1/' || r_year.annee || '/' || lpad(substring(piece_comptable from '^TMP_' || r_year.annee || '_(\d+)'), 5, '0')
      WHERE piece_comptable LIKE 'TMP_' || r_year.annee || '_%';

      -- Étape 3 : recaler le compteur officiel de caisse sur le dernier numéro attribué
      SELECT COALESCE(MAX(NULLIF(substring(piece_comptable from '/(\d+)$'), '')::int), 0)
      INTO v_counter
      FROM public.cashier_transactions
      WHERE piece_comptable LIKE 'CSH1/' || r_year.annee || '/%';

      INSERT INTO public.cashier_piece_counters (annee, dernier_numero)
      VALUES (r_year.annee, v_counter)
      ON CONFLICT (annee) DO UPDATE
      SET dernier_numero = EXCLUDED.dernier_numero;
    END IF;
  END LOOP;

  -- Réinitialiser les compteurs des années n'ayant plus aucune transaction avec pièce
  UPDATE public.cashier_piece_counters
  SET dernier_numero = 0
  WHERE annee NOT IN (
    SELECT DISTINCT (substring(piece_comptable from '^CSH1/(\d{4})/'))::int
    FROM public.cashier_transactions
    WHERE piece_comptable LIKE 'CSH1/%'
  );

  RETURN NULL;
END;
$$;

-- Révocation de l'accès public/RPC pour la fonction interne de déclencheur
REVOKE EXECUTE ON FUNCTION public.recompact_cashier_pieces_after_delete() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompact_cashier_pieces_after_delete() TO service_role;

-- 3. Déclencheur après suppression (par instruction)
DROP TRIGGER IF EXISTS trg_recompact_cashier_pieces_after_delete ON public.cashier_transactions;

CREATE TRIGGER trg_recompact_cashier_pieces_after_delete
AFTER DELETE ON public.cashier_transactions
FOR EACH STATEMENT
EXECUTE FUNCTION public.recompact_cashier_pieces_after_delete();
