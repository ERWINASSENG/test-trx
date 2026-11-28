-- =============================================================================
-- Migration : Arrêt du pré-remplissage automatique stage='quote_preparation' et
--             transport_mode='sea' lors de la création/mise à jour d'un devis draft
-- Date : 2026-11-28
-- Description :
--   1. link_sales_quote_to_crm_opportunity() : crée l'opportunité liée au stade
--      'new' (au lieu de 'quote_preparation') et laisse transport_mode à NULL
--      (au lieu de forcer 'sea') ; ne réécrase jamais transport_mode sur UPDATE.
--   2. sync_quote_lifecycle_to_sales_crm() : ne pousse plus une opportunité 'new'
--      ou 'qualified' vers 'quote_preparation' tant que le devis est 'draft'.
--      Conserve la synchronisation réelle : sent -> quote_sent, accepted -> won
--      + prospects.status = 'converted', rejected/expired -> lost.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.link_sales_quote_to_crm_opportunity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  freight jsonb;
  initial_stage text;
BEGIN
  IF NEW.opportunity_id IS NULL THEN
    freight := coalesce(NEW.sea_freight, '{}'::jsonb);
    initial_stage := CASE NEW.status
      WHEN 'sent' THEN 'quote_sent'
      WHEN 'accepted' THEN 'won'
      WHEN 'rejected' THEN 'lost'
      WHEN 'expired' THEN 'lost'
      ELSE 'new'
    END;

    INSERT INTO public.sales_opportunities (
      prospect_id,
      assigned_to,
      created_by,
      title,
      stage,
      transport_mode,
      origin,
      destination,
      goods_description,
      weight_kg,
      volume_m3,
      incoterm,
      estimated_value,
      currency,
      won_reason
    )
    VALUES (
      NEW.prospect_id,
      NEW.assigned_to,
      NEW.created_by,
      NEW.title,
      initial_stage,
      NULL,
      nullif(freight ->> 'portOfLoading', ''),
      nullif(freight ->> 'portOfDischarge', ''),
      nullif(freight ->> 'goodsDescription', ''),
      nullif(freight ->> 'grossWeightKg', '')::numeric,
      nullif(freight ->> 'totalVolumeM3', '')::numeric,
      nullif(freight ->> 'incoterm', ''),
      NEW.total_amount,
      NEW.currency,
      CASE WHEN NEW.status = 'accepted' THEN 'accepted_quote' ELSE NULL END
    )
    RETURNING id INTO NEW.opportunity_id;
  ELSE
    UPDATE public.sales_opportunities
    SET assigned_to = NEW.assigned_to,
        title = NEW.title,
        origin = nullif(coalesce(NEW.sea_freight, '{}'::jsonb) ->> 'portOfLoading', ''),
        destination = nullif(coalesce(NEW.sea_freight, '{}'::jsonb) ->> 'portOfDischarge', ''),
        goods_description = nullif(coalesce(NEW.sea_freight, '{}'::jsonb) ->> 'goodsDescription', ''),
        weight_kg = nullif(coalesce(NEW.sea_freight, '{}'::jsonb) ->> 'grossWeightKg', '')::numeric,
        volume_m3 = nullif(coalesce(NEW.sea_freight, '{}'::jsonb) ->> 'totalVolumeM3', '')::numeric,
        incoterm = nullif(coalesce(NEW.sea_freight, '{}'::jsonb) ->> 'incoterm', ''),
        estimated_value = NEW.total_amount,
        currency = NEW.currency
    WHERE id = NEW.opportunity_id
      AND prospect_id = NEW.prospect_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'La cotation et son opportunité doivent appartenir à la même société.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_quote_lifecycle_to_sales_crm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
      RAISE EXCEPTION 'La cotation et l''opportunité associée doivent appartenir à la même société.';
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

COMMIT;
