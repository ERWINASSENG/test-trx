-- =============================================================================
-- Migration : Permissions granulaires de vues Tableau de bord
-- Date : 2026-11-19
-- Description :
--   1. Ajoute 3 permissions de vue dans public.access_permissions :
--      - dashboard.admin.view
--      - dashboard.manager.view
--      - dashboard.commercial.view
--   2. Attribue les droits par défaut aux rôles existants
--      (admin, manager, tresorier, commercial).
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
    'dashboard.admin.view',
    'dashboard.admin',
    'view',
    'Voir le tableau de bord Administrateur',
    'Afficher la vue globale Administrateur du tableau de bord (/dashboard).',
    true
  ),
  (
    'dashboard.manager.view',
    'dashboard.manager',
    'view',
    'Voir le tableau de bord Manager / Trésorier',
    'Afficher la vue pilotage Manager & Trésorier du tableau de bord (/dashboard).',
    false
  ),
  (
    'dashboard.commercial.view',
    'dashboard.commercial',
    'view',
    'Voir le tableau de bord Commercial',
    'Afficher la vue commerciale dédiée du tableau de bord (/dashboard).',
    false
  )
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

WITH default_dashboard_grants (role_key, permission_key) AS (
  VALUES
    ('admin', 'dashboard.admin.view'),
    ('manager', 'dashboard.manager.view'),
    ('tresorier', 'dashboard.manager.view'),
    ('commercial', 'dashboard.commercial.view')
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT r.id,
       g.permission_key,
       '{"type":"all","version":1}'::jsonb,
       CAST(NULL AS uuid)
FROM default_dashboard_grants g
JOIN public.access_roles r ON r.role_key = g.role_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;
