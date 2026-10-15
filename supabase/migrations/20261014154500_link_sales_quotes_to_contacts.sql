BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS contact_id uuid
  REFERENCES public.prospect_contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_quotes_contact
  ON public.sales_quotes (contact_id)
  WHERE contact_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_sales_quote_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.prospect_contacts
    WHERE id = NEW.contact_id AND prospect_id = NEW.prospect_id
  ) THEN
    RAISE EXCEPTION 'Le contact d’une cotation doit appartenir à la société associée.';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_validate_sales_quote_contact ON public.sales_quotes;
CREATE TRIGGER trg_validate_sales_quote_contact
  BEFORE INSERT OR UPDATE OF contact_id, prospect_id ON public.sales_quotes
  FOR EACH ROW EXECUTE FUNCTION public.validate_sales_quote_contact();

COMMIT;
