-- ====================================================================
-- Migration Supabase: Enforce Unique Role Per User
-- Fichier: supabase/migrations/20261004170000_enforce_unique_user_role.sql
-- Description:
--   1. Dédoublonne les rôles multiples existants dans public.access_user_roles
--      pour ne conserver que le rôle le plus récent par utilisateur.
--   2. Met à jour la procédure stockée public.access_control_mutate pour garantir
--      l'unicité stricte lors de l'attribution ('user.role.assign') et protéger
--      le dernier administrateur actif.
--
-- Documentation officielle Supabase & PostgreSQL :
--   - https://supabase.com/docs/guides/database/postgres/row-level-security
--   - https://supabase.com/docs/guides/database/postgres/stored-procedures
-- ====================================================================

-- --------------------------------------------------------------------
-- Section 1 : Nettoyage préventif et dédoublonnage des rôles existants
-- --------------------------------------------------------------------
DELETE FROM public.access_user_roles a
WHERE a.created_at < (
  SELECT MAX(b.created_at)
  FROM public.access_user_roles b
  WHERE b.user_id = a.user_id
);

-- --------------------------------------------------------------------
-- Section 2 : Mise à jour de la fonction de mutation access_control_mutate
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.access_control_mutate(
  p_actor_user_id uuid,
  p_operation text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  actor_is_admin boolean;
  target_role_id uuid;
  target_role_key text;
  target_user_id uuid;
  next_state jsonb;
  audit_subject uuid;
  admin_count integer;
BEGIN
  -- 1. Contrôle strict de l'administrateur appelant
  SELECT (p.is_active IS TRUE AND p.role = 'admin') INTO actor_is_admin
  FROM public.profiles p WHERE p.id = p_actor_user_id;

  IF actor_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  CASE p_operation
    -- ----------------------------------------------------------------
    -- Attribution de rôle avec unicité garantie
    -- ----------------------------------------------------------------
    WHEN 'user.role.assign' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;

      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r WHERE r.id = target_role_id AND r.is_active IS TRUE;

      IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = target_user_id) THEN
        RAISE EXCEPTION 'Active role or user profile not found' USING ERRCODE = 'P0002';
      END IF;

      -- Protection du dernier administrateur actif
      IF target_role_key <> 'admin' THEN
        SELECT count(DISTINCT ur.user_id) INTO admin_count
        FROM public.access_user_roles ur
        JOIN public.access_roles r ON r.id = ur.role_id
        WHERE r.role_key = 'admin' AND (ur.expires_at IS NULL OR ur.expires_at > now());

        IF admin_count <= 1 AND EXISTS (
          SELECT 1 FROM public.access_user_roles ur
          JOIN public.access_roles r ON r.id = ur.role_id
          WHERE ur.user_id = target_user_id AND r.role_key = 'admin'
        ) THEN
          RAISE EXCEPTION 'Cannot replace the last administrator assignment' USING ERRCODE = '42501';
        END IF;
      END IF;

      -- RÈGLE D'UNICITÉ : purge atomique des anciens rôles de l'employé
      DELETE FROM public.access_user_roles
      WHERE user_id = target_user_id AND role_id <> target_role_id;

      -- Insertion / mise à jour du rôle unique
      INSERT INTO public.access_user_roles (user_id, role_id, assigned_by, assignment_source, expires_at)
      VALUES (target_user_id, target_role_id, p_actor_user_id, 'admin', NULLIF(payload->>'expiresAt', '')::timestamptz)
      ON CONFLICT (user_id, role_id) DO UPDATE
      SET assigned_by = EXCLUDED.assigned_by, assignment_source = 'admin', expires_at = EXCLUDED.expires_at;

      next_state := jsonb_build_object('userId', target_user_id, 'roleKey', target_role_key, 'expiresAt', payload->'expiresAt');
      audit_subject := target_user_id;

      -- Journalisation d'audit
      INSERT INTO public.access_audit_log (actor_user_id, subject_user_id, action_key, role_key, after_state)
      VALUES (p_actor_user_id, audit_subject, 'user.role.assign', target_role_key, next_state);

      RETURN next_state;

    -- ----------------------------------------------------------------
    -- Révocation de rôle avec protection du dernier admin
    -- ----------------------------------------------------------------
    WHEN 'user.role.revoke' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;

      SELECT r.role_key INTO target_role_key FROM public.access_roles r WHERE r.id = target_role_id;
      IF target_role_key IS NULL THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;

      IF target_role_key = 'admin' THEN
        SELECT count(DISTINCT ur.user_id) INTO admin_count
        FROM public.access_user_roles ur
        JOIN public.access_roles r ON r.id = ur.role_id
        WHERE r.role_key = 'admin' AND (ur.expires_at IS NULL OR ur.expires_at > now());

        IF admin_count <= 1 THEN
          RAISE EXCEPTION 'Cannot revoke the last administrator assignment' USING ERRCODE = '42501';
        END IF;
      END IF;

      DELETE FROM public.access_user_roles WHERE user_id = target_user_id AND role_id = target_role_id;
      next_state := jsonb_build_object('revoked', true, 'roleKey', target_role_key);
      audit_subject := target_user_id;

      INSERT INTO public.access_audit_log (actor_user_id, subject_user_id, action_key, role_key, after_state)
      VALUES (p_actor_user_id, audit_subject, 'user.role.revoke', target_role_key, next_state);

      RETURN next_state;

    ELSE
      RAISE EXCEPTION 'Unsupported access-control operation' USING ERRCODE = '22023';
  END CASE;
END;
$function$;
