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
  ('module.dashboard.view', 'module.dashboard', 'view', 'Voir le tableau de bord', 'Afficher la tuile et ouvrir le module Tableau de bord. Ne donne aucun droit de lecture sur les données métier.', false),
  ('module.accounting.view', 'module.accounting', 'view', 'Voir la comptabilité', 'Afficher la tuile et ouvrir le module Comptabilité. Ne donne aucun droit de lecture ou de modification des opérations.', false),
  ('module.hr.view', 'module.hr', 'view', 'Voir le module RH', 'Afficher la tuile et ouvrir le module RH. Ne donne pas accès à l’annuaire des collaborateurs.', false),
  ('module.prospects.view', 'module.prospects', 'view', 'Voir les contacts', 'Afficher la tuile et ouvrir le module Contacts. Ne donne aucun droit sur les données des prospects.', false),
  ('module.quotes.view', 'module.quotes', 'view', 'Voir les cotations', 'Afficher la tuile et ouvrir le module Cotations. Ne donne aucun droit sur les données des cotations.', false),
  ('module.crm.view', 'module.crm', 'view', 'Voir le CRM commercial', 'Afficher la tuile et ouvrir le module CRM Commercial. Ne donne aucun droit sur les données du CRM.', false),
  ('module.dossiers.view', 'module.dossiers', 'view', 'Voir les dossiers', 'Afficher la tuile et ouvrir le module Dossiers. Ne donne aucun droit sur les données des dossiers.', false),
  ('module.configuration.view', 'module.configuration', 'view', 'Voir les paramètres', 'Afficher la tuile et ouvrir le module Paramètres. Ne donne aucun droit sur les paramètres ou les journaux.', false),
  ('module.access_control.view', 'module.access_control', 'view', 'Voir la gestion des accès', 'Afficher la tuile et ouvrir la gestion des accès. Ne donne aucun droit de lecture ou de gestion des rôles.', false)
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

-- Dashboard access was universal before module visibility became configurable.
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT roles.id, 'module.dashboard.view', '{"type":"all","version":1}'::jsonb, CAST(NULL AS uuid)
FROM public.access_roles roles
WHERE roles.is_active IS TRUE
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

WITH legacy_module_permissions (source_permission_key, module_permission_key) AS (
  VALUES
    ('dashboard.view', 'module.dashboard.view'),
    ('cashier.read', 'module.accounting.view'),
    ('hr.read', 'module.hr.view'),
    ('prospects.read', 'module.prospects.view'),
    ('quotes.read', 'module.quotes.view'),
    ('crm.read', 'module.crm.view'),
    ('dossiers.read', 'module.dossiers.view'),
    ('configuration.read', 'module.configuration.view'),
    ('journals.read', 'module.configuration.view'),
    ('access.roles.read', 'module.access_control.view'),
    ('access.users.read', 'module.access_control.view')
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT DISTINCT grants.role_id,
       legacy_module_permissions.module_permission_key,
       '{"type":"all","version":1}'::jsonb,
       CAST(NULL AS uuid)
FROM public.access_role_permissions grants
JOIN legacy_module_permissions
  ON legacy_module_permissions.source_permission_key = grants.permission_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

WITH legacy_module_permissions (source_permission_key, module_permission_key) AS (
  VALUES
    ('dashboard.view', 'module.dashboard.view'),
    ('cashier.read', 'module.accounting.view'),
    ('hr.read', 'module.hr.view'),
    ('prospects.read', 'module.prospects.view'),
    ('quotes.read', 'module.quotes.view'),
    ('crm.read', 'module.crm.view'),
    ('dossiers.read', 'module.dossiers.view'),
    ('configuration.read', 'module.configuration.view'),
    ('journals.read', 'module.configuration.view'),
    ('access.roles.read', 'module.access_control.view'),
    ('access.users.read', 'module.access_control.view')
),
legacy_visibility_overrides AS (
  SELECT DISTINCT ON (overrides.user_id, legacy_module_permissions.module_permission_key)
         overrides.user_id,
         legacy_module_permissions.module_permission_key,
         overrides.reason,
         overrides.granted_by,
         overrides.expires_at
  FROM public.access_user_overrides overrides
  JOIN legacy_module_permissions
    ON legacy_module_permissions.source_permission_key = overrides.permission_key
  WHERE overrides.effect = 'allow'
    AND (overrides.expires_at IS NULL OR overrides.expires_at > now())
  ORDER BY overrides.user_id,
           legacy_module_permissions.module_permission_key,
           overrides.expires_at DESC NULLS FIRST
)
INSERT INTO public.access_user_overrides (
  user_id,
  permission_key,
  effect,
  scope,
  reason,
  granted_by,
  expires_at
)
SELECT user_id,
       module_permission_key,
       'allow',
       '{"type":"all","version":1}'::jsonb,
       reason,
       granted_by,
       expires_at
FROM legacy_visibility_overrides
ON CONFLICT (user_id, permission_key, scope) DO NOTHING;

COMMIT;
