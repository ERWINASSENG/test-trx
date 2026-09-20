-- Sécurise les rôles à la création et synchronise l'enum des statuts.
-- À appliquer avec Supabase CLI ou dans l'éditeur SQL de Supabase.

BEGIN;

ALTER TYPE public.cashier_transaction_status
  ADD VALUE IF NOT EXISTS 'cancelled';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  requested_role TEXT;
  safe_role public.user_role_enum;
BEGIN
  -- Seul app_metadata, écrit par le serveur, peut proposer un rôle privilégié.
  requested_role := COALESCE(new.raw_app_meta_data->>'role', 'employe');

  BEGIN
    safe_role := requested_role::public.user_role_enum;
  EXCEPTION WHEN invalid_text_representation THEN
    safe_role := 'employe'::public.user_role_enum;
  END;

  INSERT INTO public.profiles (
    id, email, first_name, last_name, role, department, phone, is_active, created_at, updated_at
  )
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'first_name', new.raw_user_meta_data->>'firstName', ''),
    COALESCE(new.raw_user_meta_data->>'last_name', new.raw_user_meta_data->>'lastName', ''),
    safe_role,
    COALESCE(new.raw_user_meta_data->>'department', 'Services Généraux'),
    COALESCE(new.raw_user_meta_data->>'phone', ''),
    true,
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    first_name = CASE WHEN EXCLUDED.first_name <> '' THEN EXCLUDED.first_name ELSE public.profiles.first_name END,
    last_name = CASE WHEN EXCLUDED.last_name <> '' THEN EXCLUDED.last_name ELSE public.profiles.last_name END,
    role = EXCLUDED.role,
    department = CASE WHEN EXCLUDED.department <> '' THEN EXCLUDED.department ELSE public.profiles.department END,
    updated_at = now();

  RETURN new;
END;
$function$;

DROP POLICY IF EXISTS "profiles_insert_policy" ON public.profiles;
CREATE POLICY "profiles_insert_policy"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin()
    OR (
      id = (select auth.uid())
      AND role = 'employe'
    )
  );

COMMIT;
