BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS prospect_id uuid;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.dossiers'::regclass
      AND conname = 'dossiers_prospect_id_fkey'
  ) THEN
    ALTER TABLE public.dossiers
      ADD CONSTRAINT dossiers_prospect_id_fkey
      FOREIGN KEY (prospect_id)
      REFERENCES public.prospects (id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE public.dossiers
  VALIDATE CONSTRAINT dossiers_prospect_id_fkey;

CREATE INDEX IF NOT EXISTS idx_dossiers_prospect_id
  ON public.dossiers (prospect_id)
  WHERE prospect_id IS NOT NULL;

COMMIT;