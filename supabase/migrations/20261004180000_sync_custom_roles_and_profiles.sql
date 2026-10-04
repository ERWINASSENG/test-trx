-- ====================================================================
-- Migration Supabase: Synchronisation complète des rôles dynamiques & profils RH
-- Fichier: supabase/migrations/20261004180000_sync_custom_roles_and_profiles.sql
-- Description:
--   1. Supprime toute contrainte de vérification restrictive historique (CHECK)
--      sur la colonne public.profiles.role pour accepter tous les rôles dynamiques créés.
--   2. Indexe les colonnes de recherche de rôles (role_key, is_active).
--   3. Crée / Met à jour la fonction stockée PostgreSQL atomique sync_user_primary_role
--      garantissant l'alignement strict entre access_user_roles et public.profiles.
--   4. Met à jour les politiques RLS pour sécuriser la consultation et l'attribution.
--
-- Documentation officielle Supabase & PostgreSQL :
--   - https://supabase.com/docs/guides/database/postgres/row-level-security
--   - https://supabase.com/docs/guides/database/postgres/stored-procedures
--   - https://supabase.com/docs/guides/database/tables
-- ====================================================================

-- --------------------------------------------------------------------
-- Section 1 : Assouplissement de la contrainte de rôle sur public.profiles
-- --------------------------------------------------------------------
DO $$
BEGIN
  -- Suppression de la contrainte CHECK historique si présente
  IF EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE table_schema = 'public' 
      AND table_name = 'profiles' 
      AND constraint_name = 'profiles_role_check'
  ) THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
  END IF;
END $$;

-- --------------------------------------------------------------------
-- Section 2 : Indexation pour les performances de synchronisation
-- --------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_access_roles_role_key_active 
  ON public.access_roles (role_key, is_active);

CREATE INDEX IF NOT EXISTS idx_access_user_roles_user_role 
  ON public.access_user_roles (user_id, role_id);

-- --------------------------------------------------------------------
-- Section 3 : Procédure stockée atomique de synchronisation de rôle
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_user_primary_role(
  p_actor_user_id uuid,
  p_user_id uuid,
  p_role_key text,
  p_exclusive boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role_id uuid;
  v_role_key text := lower(trim(p_role_key));
  v_actor_is_admin boolean;
  v_admin_count integer;
BEGIN
  -- 1. Validation de l'existence du profil cible
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Profil utilisateur introuvable pour %', p_user_id USING ERRCODE = 'P0002';
  END IF;

  -- 2. Recherche du rôle dans la table des rôles d'accès
  SELECT id INTO v_role_id
  FROM public.access_roles
  WHERE role_key = v_role_key AND is_active IS TRUE;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Le rôle d’accès « % » est introuvable ou inactif', v_role_key USING ERRCODE = 'P0002';
  END IF;

  -- 3. Protection contre la rétrogradation du dernier administrateur actif
  IF v_role_key <> 'admin' THEN
    SELECT count(DISTINCT ur.user_id) INTO v_admin_count
    FROM public.access_user_roles ur
    JOIN public.access_roles r ON r.id = ur.role_id
    WHERE r.role_key = 'admin' AND (ur.expires_at IS NULL OR ur.expires_at > now());

    IF v_admin_count <= 1 AND EXISTS (
      SELECT 1 FROM public.access_user_roles ur
      JOIN public.access_roles r ON r.id = ur.role_id
      WHERE ur.user_id = p_user_id AND r.role_key = 'admin'
    ) THEN
      RAISE EXCEPTION 'Action refusée : Impossible de rétrograder le dernier administrateur actif du système' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 4. Mode exclusif (mono-rôle primaire) : purge préalable des autres rôles
  IF p_exclusive IS TRUE THEN
    DELETE FROM public.access_user_roles
    WHERE user_id = p_user_id AND role_id <> v_role_id;
  END IF;

  -- 5. Attribution / Upsert du rôle dans access_user_roles
  INSERT INTO public.access_user_roles (
    user_id,
    role_id,
    assigned_by,
    assignment_source,
    expires_at
  )
  VALUES (
    p_user_id,
    v_role_id,
    p_actor_user_id,
    'admin',
    NULL
  )
  ON CONFLICT (user_id, role_id) DO UPDATE
  SET 
    assigned_by = EXCLUDED.assigned_by,
    assignment_source = EXCLUDED.assignment_source,
    expires_at = EXCLUDED.expires_at;

  -- 6. Synchronisation atomique du rôle dans le profil public
  UPDATE public.profiles
  SET 
    role = v_role_key,
    updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'userId', p_user_id,
    'roleKey', v_role_key,
    'roleId', v_role_id,
    'syncedAt', now()
  );
END;
$function$;

-- --------------------------------------------------------------------
-- Section 4 : Politiques RLS de sécurité (Row Level Security)
-- --------------------------------------------------------------------
ALTER TABLE public.access_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_user_roles ENABLE ROW LEVEL SECURITY;

-- Lecture autorisée pour tout utilisateur authentifié
DROP POLICY IF EXISTS "Allow authenticated read on access_roles" ON public.access_roles;
CREATE POLICY "Allow authenticated read on access_roles"
  ON public.access_roles
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Allow authenticated read on access_user_roles" ON public.access_user_roles;
CREATE POLICY "Allow authenticated read on access_user_roles"
  ON public.access_user_roles
  FOR SELECT
  TO authenticated
  USING (true);

-- Mutations réservées aux administrateurs
DROP POLICY IF EXISTS "Allow admin mutate on access_roles" ON public.access_roles;
CREATE POLICY "Allow admin mutate on access_roles"
  ON public.access_roles
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Allow admin mutate on access_user_roles" ON public.access_user_roles;
CREATE POLICY "Allow admin mutate on access_user_roles"
  ON public.access_user_roles
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );
