-- =============================================================================
-- Migration: Grant CRM Permissions to Manager Role
-- Date: 2026-10-21
-- Description:
--   1. Attribue les permissions du nouveau module 'CRM • Délais des Cotations'
--      (quotes.timing.read et module.crm_performance.view) au rôle manager.
--   2. Attribue la permission d'accès au module CRM Commercial (module.crm.view)
--      au rôle manager pour supprimer l'erreur 403 lors de l'accès aux opportunités.
--   3. Attribue également les permissions au rôle admin par complétude.
-- Sources:
--   - https://supabase.com/docs/guides/auth
--   - https://supabase.com/docs/guides/database/postgres/row-level-security
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Attribution des permissions CRM au rôle 'manager'
-- -----------------------------------------------------------------------------
INSERT INTO public.access_role_permissions (role_id, permission_key, scope)
SELECT
  r.id AS role_id,
  p.permission_key,
  '{"type": "all", "version": 1}'::jsonb AS scope
FROM public.access_roles r
CROSS JOIN (
  VALUES
    ('quotes.timing.read'),
    ('module.crm_performance.view'),
    ('module.crm.view')
) AS p(permission_key)
WHERE r.role_key = 'manager'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Attribution des permissions CRM au rôle 'admin'
-- -----------------------------------------------------------------------------
INSERT INTO public.access_role_permissions (role_id, permission_key, scope)
SELECT
  r.id AS role_id,
  p.permission_key,
  '{"type": "all", "version": 1}'::jsonb AS scope
FROM public.access_roles r
CROSS JOIN (
  VALUES
    ('quotes.timing.read'),
    ('module.crm_performance.view')
) AS p(permission_key)
WHERE r.role_key = 'admin'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;

