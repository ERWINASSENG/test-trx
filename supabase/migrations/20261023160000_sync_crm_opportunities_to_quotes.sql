-- =============================================================================
-- Migration: Synchronisation bidirectionnelle Opportunités CRM et Cotations
-- Date: 2026-10-23
-- Description:
--   1. Met à jour sync_quote_lifecycle_to_sales_crm pour synchroniser les statuts
--      de refus (rejected) et expiration (expired) vers stage = 'lost'.
--   2. Crée la fonction trigger sync_opportunity_stage_to_sales_quote()
--      pour répercuter automatiquement le changement d'étape d'une opportunité
--      sur le statut de la cotation liée (quote_sent -> sent, won -> accepted,
--      lost -> rejected, quote_preparation -> draft) avec horodatages précis
--      (sent_at, responded_at) pour fiabiliser les métriques SLA du Manager.
--   3. Attache le trigger trg_sync_opportunity_stage_to_sales_quote sur
--      public.sales_opportunities.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. Mise à jour du trigger Cotation -> Opportunité CRM pour couvrir rejected et expired
CREATE OR REPLACE FUNCTION public.sync_quote_lifecycle_to_sales_crm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.opportunity_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.sales_opportunities
      WHERE id = NEW.opportunity_id AND prospect_id = NEW.prospect_id
    ) THEN
      RAISE EXCEPTION 'La cotation et l’opportunité associée doivent appartenir à la même société.';
    END IF;

    IF NEW.status = 'accepted' THEN
      UPDATE public.sales_opportunities
      SET stage = 'won', won_reason = 'accepted_quote', contract_reference = NULL
      WHERE id = NEW.opportunity_id AND stage <> 'won';
    ELSIF NEW.status = 'sent' THEN
      UPDATE public.sales_opportunities
      SET stage = 'quote_sent'
      WHERE id = NEW.opportunity_id
        AND stage IN ('new', 'qualified', 'quote_preparation', 'quote_sent');
    ELSIF NEW.status = 'draft' THEN
      UPDATE public.sales_opportunities
      SET stage = 'quote_preparation'
      WHERE id = NEW.opportunity_id
        AND stage IN ('new', 'qualified', 'quote_preparation');
    ELSIF NEW.status IN ('rejected', 'expired') THEN
      UPDATE public.sales_opportunities
      SET stage = 'lost'
      WHERE id = NEW.opportunity_id
        AND stage NOT IN ('won', 'lost');
    END IF;
  END IF;

  IF NEW.status = 'accepted' THEN
    UPDATE public.prospects
    SET status = 'converted'
    WHERE id = NEW.prospect_id AND status <> 'converted';
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. Création de la fonction trigger Opportunité CRM -> Cotation
CREATE OR REPLACE FUNCTION public.sync_opportunity_stage_to_sales_quote()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  -- Si l'étape n'a pas changé, rien à faire
  IF TG_OP = 'UPDATE' AND OLD.stage IS NOT DISTINCT FROM NEW.stage THEN
    RETURN NEW;
  END IF;

  -- Synchronisation vers la cotation liée
  IF NEW.stage = 'quote_sent' THEN
    UPDATE public.sales_quotes
    SET status = 'sent',
        sent_at = COALESCE(sent_at, now())
    WHERE opportunity_id = NEW.id
      AND status NOT IN ('sent', 'accepted');
  ELSIF NEW.stage = 'won' THEN
    UPDATE public.sales_quotes
    SET status = 'accepted',
        responded_at = COALESCE(responded_at, now())
    WHERE opportunity_id = NEW.id
      AND status <> 'accepted';
  ELSIF NEW.stage = 'lost' THEN
    UPDATE public.sales_quotes
    SET status = 'rejected',
        responded_at = COALESCE(responded_at, now())
    WHERE opportunity_id = NEW.id
      AND status NOT IN ('accepted', 'rejected');
  ELSIF NEW.stage = 'quote_preparation' THEN
    UPDATE public.sales_quotes
    SET status = 'draft'
    WHERE opportunity_id = NEW.id
      AND status = 'draft';
  END IF;

  RETURN NEW;
END;
$function$;

-- 3. Attachement du trigger sur sales_opportunities
DROP TRIGGER IF EXISTS trg_sync_opportunity_stage_to_sales_quote ON public.sales_opportunities;
CREATE TRIGGER trg_sync_opportunity_stage_to_sales_quote
  AFTER UPDATE OF stage
  ON public.sales_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_opportunity_stage_to_sales_quote();

-- 4. Sécurisation des permissions des fonctions trigger (Moindre privilège S1)
REVOKE ALL ON FUNCTION public.sync_opportunity_stage_to_sales_quote() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_opportunity_stage_to_sales_quote() TO service_role;

REVOKE ALL ON FUNCTION public.sync_quote_lifecycle_to_sales_crm() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_quote_lifecycle_to_sales_crm() TO service_role;

-- 5. Rétro-synchronisation des cotations existantes dont le statut divergeait
UPDATE public.sales_quotes q
SET status = 'sent',
    sent_at = COALESCE(q.sent_at, o.updated_at, now())
FROM public.sales_opportunities o
WHERE q.opportunity_id = o.id
  AND o.stage IN ('quote_sent', 'negotiation')
  AND q.status = 'draft';

UPDATE public.sales_quotes q
SET status = 'accepted',
    responded_at = COALESCE(q.responded_at, o.updated_at, now())
FROM public.sales_opportunities o
WHERE q.opportunity_id = o.id
  AND o.stage = 'won'
  AND q.status <> 'accepted';

COMMIT;
