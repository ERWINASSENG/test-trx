-- =============================================================================
-- Migration: Add Quote Timing Columns and Access Permissions
-- Date: 2026-10-20
-- Description:
--   1. Ajoute les colonnes sent_at et responded_at sur sales_quotes pour le suivi précis
--      des délais de chiffrage commercial et de réponse client.
--   2. Rétro-remplit les délais sur les cotations existantes selon leur statut.
--   3. Enregistre les permissions 'quotes.timing.read' et 'module.crm_performance.view'
--      dans le catalogue access_permissions (AUCUNE attribution automatique par défaut,
--      conformément au principe de moindre privilège et gestion exclusive via RBAC).
-- Sources:
--   - https://supabase.com/docs/guides/database/postgres/row-level-security
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Colonnes d'horodatage des délais sur la table sales_quotes
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS responded_at timestamptz;

COMMENT ON COLUMN public.sales_quotes.sent_at IS
  'Horodatage précis auquel la cotation a été finalisée par le commercial et transmise au client.';

COMMENT ON COLUMN public.sales_quotes.responded_at IS
  'Horodatage précis de la décision du client (acceptation ou refus de la cotation).';

-- -----------------------------------------------------------------------------
-- 2. Rétro-remplissage des cotations historiques
-- -----------------------------------------------------------------------------
UPDATE public.sales_quotes
SET sent_at = updated_at
WHERE sent_at IS NULL
  AND status IN ('sent', 'accepted', 'rejected', 'expired');

UPDATE public.sales_quotes
SET responded_at = updated_at
WHERE responded_at IS NULL
  AND status IN ('accepted', 'rejected');

-- -----------------------------------------------------------------------------
-- 3. Index d'optimisation pour les calculs de délais et métriques SLA
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sales_quotes_timing_analytics
  ON public.sales_quotes (created_at DESC, sent_at, status, assigned_to);

CREATE INDEX IF NOT EXISTS idx_sales_quotes_sent_at
  ON public.sales_quotes (sent_at)
  WHERE sent_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Déclaration des permissions dans le catalogue access_permissions
-- NOTE : Aucun rôle ni utilisateur ne reçoit ces permissions par défaut.
-- L'attribution se fait exclusivement via le module « Gestion des accès ».
-- -----------------------------------------------------------------------------
INSERT INTO public.access_permissions (
  permission_key,
  resource_key,
  action_key,
  label,
  description,
  is_sensitive
)
VALUES
  (
    'quotes.timing.read',
    'quotes.timing',
    'read',
    'Consulter les délais et performances des cotations',
    'Permet de visualiser les délais de traitement des cotations, le respect des SLA et la synthèse de performance de l’équipe commerciale.',
    true
  ),
  (
    'module.crm_performance.view',
    'module.crm_performance',
    'view',
    'Voir l’onglet CRM Délais & Cotations',
    'Affiche l’onglet CRM dans la barre supérieure de navigation du manager. Ne dispense pas du droit de lecture quotes.timing.read.',
    false
  )
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

COMMIT;

