-- =============================================================================
-- Migration: Correction de la synchronisation Opportunités CRM -> Cotations
-- Date: 2026-10-24
-- Description:
--   Permet la mise à jour bidirectionnelle automatique du statut de la cotation
--   lors du déplacement de cartes dans le Kanban CRM :
--     - quote_preparation : permet de repasser une cotation 'sent' à 'draft'
--     - quote_sent : passe la cotation à 'sent' avec horodatage sent_at
--     - negotiation : s'assure que la cotation liée est au moins 'sent'
--     - won : passe la cotation à 'accepted' avec horodatage responded_at
--     - lost : passe la cotation à 'rejected' avec horodatage responded_at
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

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

  -- 1. Étape Préparation cotation : statut draft (autorise la rétrogradation depuis sent)
  IF NEW.stage = 'quote_preparation' THEN
    UPDATE public.sales_quotes
    SET status = 'draft'
    WHERE opportunity_id = NEW.id
      AND status IN ('draft', 'sent');

  -- 2. Étape Cotation envoyée : statut sent + horodatage d'envoi
  ELSIF NEW.stage = 'quote_sent' THEN
    UPDATE public.sales_quotes
    SET status = 'sent',
        sent_at = COALESCE(sent_at, now())
    WHERE opportunity_id = NEW.id
      AND status NOT IN ('sent', 'accepted');

  -- 3. Étape Négociation : si la cotation était encore en brouillon, elle passe à sent
  ELSIF NEW.stage = 'negotiation' THEN
    UPDATE public.sales_quotes
    SET status = 'sent',
        sent_at = COALESCE(sent_at, now())
    WHERE opportunity_id = NEW.id
      AND status = 'draft';

  -- 4. Étape Gagné : statut accepted + horodatage de réponse client
  ELSIF NEW.stage = 'won' THEN
    UPDATE public.sales_quotes
    SET status = 'accepted',
        responded_at = COALESCE(responded_at, now())
    WHERE opportunity_id = NEW.id
      AND status <> 'accepted';

  -- 5. Étape Perdu : statut rejected + horodatage de réponse
  ELSIF NEW.stage = 'lost' THEN
    UPDATE public.sales_quotes
    SET status = 'rejected',
        responded_at = COALESCE(responded_at, now())
    WHERE opportunity_id = NEW.id
      AND status NOT IN ('accepted', 'rejected');
  END IF;

  RETURN NEW;
END;
$function$;

-- Remplacement du trigger sur sales_opportunities
DROP TRIGGER IF EXISTS trg_sync_opportunity_stage_to_sales_quote ON public.sales_opportunities;
CREATE TRIGGER trg_sync_opportunity_stage_to_sales_quote
  AFTER UPDATE OF stage
  ON public.sales_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_opportunity_stage_to_sales_quote();

COMMIT;
