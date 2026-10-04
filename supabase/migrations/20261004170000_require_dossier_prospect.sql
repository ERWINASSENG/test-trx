BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  unlinked_count bigint;
BEGIN
  SELECT count(*)
  INTO unlinked_count
  FROM public.dossiers
  WHERE prospect_id IS NULL;

  IF unlinked_count > 0 THEN
    RAISE EXCEPTION
      'Migration annulée : % dossier(s) ne sont pas liés à un prospect.',
      unlinked_count
      USING HINT = 'Rattache chaque dossier à un prospect, puis relance cette migration.';
  END IF;
END
$migration$;

ALTER TABLE public.dossiers
  ADD CONSTRAINT dossiers_prospect_id_required_check
  CHECK (prospect_id IS NOT NULL)
  NOT VALID;

ALTER TABLE public.dossiers
  VALIDATE CONSTRAINT dossiers_prospect_id_required_check;

ALTER TABLE public.dossiers
  ALTER COLUMN prospect_id SET NOT NULL;

ALTER TABLE public.dossiers
  DROP CONSTRAINT dossiers_prospect_id_required_check;

ALTER TABLE public.dossiers
  DROP CONSTRAINT IF EXISTS dossiers_prospect_id_fkey;

ALTER TABLE public.dossiers
  ADD CONSTRAINT dossiers_prospect_id_fkey
  FOREIGN KEY (prospect_id)
  REFERENCES public.prospects (id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE public.dossiers
  VALIDATE CONSTRAINT dossiers_prospect_id_fkey;

COMMIT;