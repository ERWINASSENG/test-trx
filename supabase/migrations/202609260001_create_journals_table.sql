-- =============================================================================
-- Migration: Création de la table des journaux comptables (Journals)
-- Version: 202609260001
-- Description: Table de gestion multi-journaux Odoo avec RLS durcie et index.
-- =============================================================================

BEGIN;

-- 1. Création de la table `journals`
CREATE TABLE IF NOT EXISTS public.journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'sale', 'purchase', 'general', 'divers')),
  ledger_type TEXT DEFAULT '',
  sequence_prefix VARCHAR(10) NOT NULL UNIQUE,
  default_account TEXT NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'XAF',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Index d'optimisation des requêtes
CREATE INDEX IF NOT EXISTS idx_journals_is_active ON public.journals(is_active);
CREATE INDEX IF NOT EXISTS idx_journals_type ON public.journals(type);
CREATE INDEX IF NOT EXISTS idx_journals_sequence_prefix ON public.journals(sequence_prefix);

-- 3. Activation stricte du Row Level Security (RLS)
ALTER TABLE public.journals ENABLE ROW LEVEL SECURITY;

-- 4. Politiques de sécurité RLS

-- Politique de lecture : accessible à tous les utilisateurs authentifiés
DROP POLICY IF EXISTS "journals_select_authenticated" ON public.journals;
CREATE POLICY "journals_select_authenticated"
  ON public.journals
  FOR SELECT
  TO authenticated
  USING (true);

-- Politique d'insertion : autorisée pour admin, manager, comptable, trésorier
DROP POLICY IF EXISTS "journals_insert_management" ON public.journals;
CREATE POLICY "journals_insert_management"
  ON public.journals
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      EXISTS (
        SELECT 1 FROM public.profiles
        WHERE public.profiles.id = (SELECT auth.uid())
          AND public.profiles.role IN ('manager', 'tresorier', 'comptable')
      )
    )
  );

-- Politique de mise à jour : autorisée pour admin, manager, comptable, trésorier
DROP POLICY IF EXISTS "journals_update_management" ON public.journals;
CREATE POLICY "journals_update_management"
  ON public.journals
  FOR UPDATE
  TO authenticated
  USING (
    public.is_admin()
    OR (
      EXISTS (
        SELECT 1 FROM public.profiles
        WHERE public.profiles.id = (SELECT auth.uid())
          AND public.profiles.role IN ('manager', 'tresorier', 'comptable')
      )
    )
  )
  WITH CHECK (
    public.is_admin()
    OR (
      EXISTS (
        SELECT 1 FROM public.profiles
        WHERE public.profiles.id = (SELECT auth.uid())
          AND public.profiles.role IN ('manager', 'tresorier', 'comptable')
      )
    )
  );

-- Politique de suppression : autorisée pour admin uniquement (protection d'intégrité comptable)
DROP POLICY IF EXISTS "journals_delete_admin" ON public.journals;
CREATE POLICY "journals_delete_admin"
  ON public.journals
  FOR DELETE
  TO authenticated
  USING (
    public.is_admin()
    AND sequence_prefix <> 'CSH1' -- Interdiction de supprimer le journal natif Caisse
  );

-- 5. Insertion initiale du journal système de Caisse Principale (s'il n'existe pas)
INSERT INTO public.journals (
  name,
  type,
  ledger_type,
  sequence_prefix,
  default_account,
  currency,
  is_active
)
VALUES (
  'Caisse Principale',
  'cash',
  'Journal des opérations de caisse',
  'CSH1',
  '510000 Valeurs à encaisser',
  'XAF',
  true
)
ON CONFLICT (sequence_prefix) DO NOTHING;

COMMIT;
