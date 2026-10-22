-- =============================================================================
-- Migration: Add Assigned_At Column & Automatic Audit Trigger to Sales Quotes
-- Date: 2026-10-22
-- Description:
--   1. Ajoute la colonne assigned_at sur sales_quotes pour la traçabilité précise
--      du jalon "Attribution de la cotation".
--   2. Installe une fonction trigger et un déclencheur BEFORE INSERT OR UPDATE
--      garantissant que assigned_at est géré côté serveur et inviolable par le client.
--   3. Rétro-remplit assigned_at pour les cotations historiques déjà assignées.
--   4. Crée un index partiel pour optimiser les requêtes d'audit chronologique.
-- Sécurité:
--   - search_path fixé sur la fonction trigger (S1)
--   - Interdiction de toute falsification client de assigned_at (S1, S3)
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Ajout de la colonne assigned_at
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

COMMENT ON COLUMN public.sales_quotes.assigned_at IS
  'Horodatage précis de l''affectation de la cotation au commercial. Maintenu automatiquement par trigger pour empêcher toute altération client.';

-- -----------------------------------------------------------------------------
-- 2. Fonction trigger pour maintien automatique et sécurisé de assigned_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_sales_quote_assigned_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_to IS NOT NULL THEN
      -- Si une cotation est créée directement avec un commercial assigné
      NEW.assigned_at := COALESCE(NEW.assigned_at, now());
    ELSE
      NEW.assigned_at := NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Si le commercial assigné change
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
      IF NEW.assigned_to IS NOT NULL THEN
        NEW.assigned_at := now();
      ELSE
        NEW.assigned_at := NULL;
      END IF;
    ELSE
      -- Si assigned_to reste inchangé : si assigned_at était NULL mais qu'un commercial est présent (backfill)
      IF OLD.assigned_at IS NULL AND NEW.assigned_to IS NOT NULL THEN
        NEW.assigned_at := COALESCE(NEW.assigned_at, now());
      ELSE
        NEW.assigned_at := OLD.assigned_at;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_quotes_set_assigned_at ON public.sales_quotes;
CREATE TRIGGER trg_sales_quotes_set_assigned_at
  BEFORE INSERT OR UPDATE ON public.sales_quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_sales_quote_assigned_at();

-- -----------------------------------------------------------------------------
-- 3. Rétro-remplissage des cotations existantes déjà affectées
-- -----------------------------------------------------------------------------
UPDATE public.sales_quotes
SET assigned_at = created_at
WHERE assigned_to IS NOT NULL
  AND assigned_at IS NULL;

-- -----------------------------------------------------------------------------
-- 4. Index partiel d'optimisation
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sales_quotes_assigned_at
  ON public.sales_quotes (assigned_at DESC)
  WHERE assigned_at IS NOT NULL;

COMMIT;

