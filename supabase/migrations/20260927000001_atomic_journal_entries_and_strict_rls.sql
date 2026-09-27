-- ==============================================================================
-- Migration: 20260927000001_atomic_journal_entries_and_strict_rls.sql
-- Description:
--   1. Création de la table 'journal_piece_counters' pour le séquençage atomique des écritures
--   2. Trigger et fonction PL/pgSQL 'assign_journal_entry_piece_comptable' pour verrouillage de séquence
--   3. Durcissement RLS des tables 'dossiers' et 'profiles' (moindre privilège)
--   4. RLS pour 'journal_piece_counters'
-- ==============================================================================

BEGIN;

-- 1. Table de compteurs atomiques pour les journaux
CREATE TABLE IF NOT EXISTS public.journal_piece_counters (
  journal_id uuid NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
  annee integer NOT NULL,
  dernier_numero integer NOT NULL DEFAULT 0,
  PRIMARY KEY (journal_id, annee)
);

-- RLS sur journal_piece_counters
ALTER TABLE public.journal_piece_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.journal_piece_counters FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.journal_piece_counters TO service_role;

-- 2. Procédure stockée d'attribution atomique de pièces comptables
CREATE OR REPLACE FUNCTION public.assign_journal_entry_piece_comptable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  prefix text;
  annee_piece integer;
  prochain_num integer;
  candidat text;
  existe boolean;
BEGIN
  -- Si une pièce est déjà fournie avec un numéro de séquence valide, la conserver
  IF NEW.piece_comptable IS NOT NULL AND btrim(NEW.piece_comptable) <> '' AND NEW.sequence_number IS NOT NULL AND NEW.sequence_number > 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sequence_prefix, 'JRNL') INTO prefix
  FROM public.journals WHERE id = NEW.journal_id;

  IF prefix IS NULL THEN
    prefix := 'JRNL';
  END IF;

  annee_piece := COALESCE(
    NULLIF(substring(NEW.date::text from '^\d{4}'), '')::int,
    NULLIF(substring(NEW.date::text from '\d{4}$'), '')::int,
    EXTRACT(YEAR FROM now())::int
  );

  INSERT INTO public.journal_piece_counters (journal_id, annee, dernier_numero)
  VALUES (NEW.journal_id, annee_piece, 0)
  ON CONFLICT (journal_id, annee) DO NOTHING;

  LOOP
    UPDATE public.journal_piece_counters
    SET dernier_numero = public.journal_piece_counters.dernier_numero + 1
    WHERE journal_id = NEW.journal_id AND annee = annee_piece
    RETURNING dernier_numero INTO prochain_num;

    candidat := prefix || '/' || annee_piece || '/' || lpad(prochain_num::text, 5, '0');

    SELECT EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE journal_id = NEW.journal_id AND piece_comptable = candidat
    ) INTO existe;

    IF NOT existe THEN
      NEW.sequence_number := prochain_num;
      NEW.piece_comptable := candidat;
      EXIT;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

-- Création ou remplacement du trigger
DROP TRIGGER IF EXISTS trg_assign_journal_entry_piece_comptable ON public.journal_entries;
CREATE TRIGGER trg_assign_journal_entry_piece_comptable
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.assign_journal_entry_piece_comptable();

-- 3. Durcissement des politiques RLS sur dossiers
DROP POLICY IF EXISTS dossiers_select_authenticated ON public.dossiers;
DROP POLICY IF EXISTS dossiers_select_by_role ON public.dossiers;

CREATE POLICY dossiers_select_by_role ON public.dossiers
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.role IN ('admin', 'caissier', 'caissiere', 'manager', 'tresorier', 'comptable', 'rh')
    )
    OR created_by = (SELECT auth.uid())
  );

COMMIT;
