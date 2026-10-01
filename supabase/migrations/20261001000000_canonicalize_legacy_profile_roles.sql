-- Canonicalise les rôles legacy vers les six rôles utilisés par l'application.
-- Les anciennes valeurs de l'ENUM restent conservées pour compatibilité historique.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- 1. Convertir les profils vers le vocabulaire canonique.
UPDATE public.profiles
SET role = CASE role::text
  WHEN 'manager_stock' THEN 'manager'::public.user_role_enum
  WHEN 'caissier' THEN 'caissiere'::public.user_role_enum
  WHEN 'agent' THEN 'employe'::public.user_role_enum
  WHEN 'rh' THEN 'employe'::public.user_role_enum
  ELSE role
END,
updated_at = now()
WHERE role::text IN ('manager_stock', 'caissier', 'agent', 'rh');

-- 2. Aligner le rôle scellé côté Auth avec le profil canonique.
UPDATE auth.users u
SET raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('role', p.role::text)
FROM public.profiles p
WHERE p.id = u.id;

-- 3. Une seule affectation dynamique canonique par utilisateur.
DELETE FROM public.access_user_roles;

INSERT INTO public.access_user_roles (user_id, role_id, assignment_source)
SELECT p.id, r.id, 'legacy_profile'
FROM public.profiles p
JOIN public.access_roles r ON r.role_key = p.role::text
WHERE p.is_active IS TRUE
  AND r.is_active IS TRUE;

COMMIT;
