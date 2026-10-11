BEGIN;

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
    'dossiers.read',
    'dossiers',
    'read',
    'Consulter les dossiers',
    'Consulter les dossiers et leurs synthèses de dépenses.',
    true
  ),
  (
    'dossiers.create',
    'dossiers',
    'create',
    'Créer un dossier',
    'Créer un dossier directement ou depuis une opportunité commerciale.',
    true
  )
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT DISTINCT grants.role_id, 'dossiers.read', grants.scope, NULL::uuid
FROM public.access_role_permissions grants
WHERE grants.permission_key = 'cashier.read'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT DISTINCT grants.role_id, 'dossiers.create', grants.scope, NULL::uuid
FROM public.access_role_permissions grants
WHERE grants.permission_key IN ('cashier.create', 'crm.create')
UNION
SELECT roles.id, 'dossiers.create', '{"type":"all","version":1}'::jsonb, NULL::uuid
FROM public.access_roles roles
WHERE roles.role_key = 'manager'
  AND roles.is_active IS TRUE
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;
