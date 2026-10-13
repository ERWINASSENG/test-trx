BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS sea_freight jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.sales_quotes'::regclass
      AND conname = 'sales_quotes_sea_freight_object_check'
  ) THEN
    ALTER TABLE public.sales_quotes
      ADD CONSTRAINT sales_quotes_sea_freight_object_check
      CHECK (jsonb_typeof(sea_freight) = 'object');
  END IF;
END;
$$;

COMMIT;
