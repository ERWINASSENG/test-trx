-- =============================================================================
-- Migration : Permissions granulaires Dossiers (lecture globale & attribution)
-- Date : 2026-11-19
-- Description :
--   1. Ajoute 2 permissions dans public.access_permissions :
--      - dossiers.read_all
--      - dossiers.assign
--   2. Attribue les droits par défaut au rôle admin.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

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
    'dossiers.read_all',
    'dossiers',
    'read_all',
    'Voir tous les dossiers de l’équipe',
    'Consulter l’ensemble des dossiers d’exploitation, y compris ceux créés ou attribués à d’autres collaborateurs.',
    true
  ),
  (
    'dossiers.assign',
    'dossiers',
    'assign',
    'Attribuer les dossiers à un responsable',
    'Lister les responsables actifs et attribuer ou réaffecter un dossier d’exploitation.',
    true
  )
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

WITH default_dossiers_grants (role_key, permission_key) AS (
  VALUES
    ('admin', 'dossiers.read_all'),
    ('admin', 'dossiers.assign')
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT r.id,
       g.permission_key,
       '{"type":"all","version":1}'::jsonb,
       CAST(NULL AS uuid)
FROM default_dossiers_grants g
JOIN public.access_roles r ON r.role_key = g.role_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;
