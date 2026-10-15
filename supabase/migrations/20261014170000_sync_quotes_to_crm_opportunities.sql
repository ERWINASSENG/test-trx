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
      ELSE 'quote_preparation'
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
      'sea',
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
        transport_mode = 'sea',
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
END
$function$;

DROP TRIGGER IF EXISTS trg_link_sales_quote_to_crm_opportunity ON public.sales_quotes;
CREATE TRIGGER trg_link_sales_quote_to_crm_opportunity
  BEFORE INSERT OR UPDATE OF opportunity_id, prospect_id, assigned_to, title, sea_freight, total_amount, currency
  FOR EACH ROW EXECUTE FUNCTION public.link_sales_quote_to_crm_opportunity();

CREATE OR REPLACE FUNCTION public.sync_accepted_quote_to_sales_crm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  next_stage text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'accepted' AND NEW.status <> 'accepted' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Une cotation acceptée ne peut pas revenir à un autre statut.';
  END IF;

  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.opportunity_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.sales_opportunities
        WHERE id = NEW.opportunity_id AND prospect_id = NEW.prospect_id
      ) THEN
        RAISE EXCEPTION 'La cotation et l’opportunité associée doivent appartenir à la même société.';
      END IF;

      next_stage := CASE NEW.status
        WHEN 'sent' THEN 'quote_sent'
        WHEN 'accepted' THEN 'won'
        WHEN 'rejected' THEN 'lost'
        WHEN 'expired' THEN 'lost'
        ELSE 'quote_preparation'
      END;

      UPDATE public.sales_opportunities
      SET stage = CASE WHEN stage = 'won' THEN stage ELSE next_stage END,
          won_reason = CASE
            WHEN stage = 'won' THEN won_reason
            WHEN NEW.status = 'accepted' THEN 'accepted_quote'
            ELSE NULL
          END,
          contract_reference = CASE WHEN stage = 'won' THEN contract_reference ELSE NULL END
      WHERE id = NEW.opportunity_id;
    END IF;

    IF NEW.status = 'accepted' THEN
      UPDATE public.prospects
      SET status = 'converted'
      WHERE id = NEW.prospect_id AND status <> 'converted';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

WITH ranked_quotes AS (
  SELECT id,
         row_number() OVER (PARTITION BY opportunity_id ORDER BY created_at DESC, id DESC) AS row_number
  FROM public.sales_quotes
  WHERE opportunity_id IS NOT NULL
)
UPDATE public.sales_quotes AS quote
SET opportunity_id = NULL
FROM ranked_quotes
WHERE quote.id = ranked_quotes.id
  AND ranked_quotes.row_number > 1;

UPDATE public.sales_quotes
SET opportunity_id = NULL
WHERE opportunity_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_quotes_unique_opportunity
  ON public.sales_quotes (opportunity_id)
  WHERE opportunity_id IS NOT NULL;

UPDATE public.prospects AS prospect
SET status = 'converted'
WHERE prospect.status <> 'converted'
  AND EXISTS (
    SELECT 1
    FROM public.sales_quotes AS quote
    WHERE quote.prospect_id = prospect.id
      AND quote.status = 'accepted'
  );

COMMIT;
