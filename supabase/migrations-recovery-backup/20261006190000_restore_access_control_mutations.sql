BEGIN;

SET LOCAL lock_timeout = '5s';

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
  required_permission text;
  actor_is_active boolean;
  actor_is_authorized boolean;
  target_role_id uuid;
  target_role_key text;
  target_role_is_system boolean;
  target_user_id uuid;
  target_permission_key text;
  target_scope jsonb;
  target_effect text;
  target_reason text;
  previous_state jsonb;
  next_state jsonb;
  audit_subject uuid;
  admin_count integer;
BEGIN
  SELECT p.is_active INTO actor_is_active
  FROM public.profiles p WHERE p.id = p_actor_user_id;

  IF actor_is_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  required_permission := CASE p_operation
    WHEN 'role.create' THEN 'access.roles.manage'
    WHEN 'role.update' THEN 'access.roles.manage'
    WHEN 'role.delete' THEN 'access.roles.manage'
    WHEN 'role.permissions.replace' THEN 'access.permissions.assign'
    WHEN 'user.role.assign' THEN 'access.users.assign_roles'
    WHEN 'user.role.revoke' THEN 'access.users.assign_roles'
    WHEN 'user.permission.override' THEN 'access.users.override'
    WHEN 'user.permission.override.revoke' THEN 'access.users.override'
    ELSE NULL
  END;

  IF required_permission IS NULL THEN
    RAISE EXCEPTION 'Unsupported access-control operation' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.access_user_roles ur
    JOIN public.access_roles r ON r.id = ur.role_id AND r.is_active IS TRUE
    JOIN public.access_role_permissions rp ON rp.role_id = r.id
    WHERE ur.user_id = p_actor_user_id
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND rp.permission_key = required_permission
      AND rp.scope->>'type' = 'all'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.access_user_overrides uo
    WHERE uo.user_id = p_actor_user_id
      AND uo.permission_key = required_permission
      AND uo.effect = 'deny'
      AND uo.scope->>'type' = 'all'
      AND (uo.expires_at IS NULL OR uo.expires_at > now())
  )
  INTO actor_is_authorized;

  IF actor_is_authorized IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Insufficient access-control permission' USING ERRCODE = '42501';
  END IF;

  target_user_id := NULLIF(payload->>'userId', '')::uuid;
  target_permission_key := NULLIF(payload->>'permissionKey', '');
  target_scope := COALESCE(payload->'scope', '{"type":"all","version":1}'::jsonb);
  target_effect := COALESCE(payload->>'effect', 'allow');
  target_reason := NULLIF(btrim(payload->>'reason'), '');

  IF jsonb_typeof(target_scope) <> 'object'
     OR COALESCE(target_scope->>'type', '') NOT IN ('all', 'self', 'owner', 'department')
     OR target_scope->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Unsupported permission scope document' USING ERRCODE = '22023';
  END IF;

  CASE p_operation
    WHEN 'role.create' THEN
      target_role_key := lower(btrim(payload->>'roleKey'));
      IF target_role_key IS NULL OR target_role_key !~ '^[a-z][a-z0-9_]{1,63}$' THEN
        RAISE EXCEPTION 'Invalid role key' USING ERRCODE = '22023';
      END IF;
      IF COALESCE(length(btrim(payload->>'label')), 0) < 2 THEN
        RAISE EXCEPTION 'Role label must contain at least two characters' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.access_roles (role_key, label, description, created_by)
      VALUES (target_role_key, btrim(payload->>'label'), COALESCE(payload->>'description', ''), p_actor_user_id)
      RETURNING id, role_key INTO target_role_id, target_role_key;
      next_state := jsonb_build_object('id', target_role_id, 'roleKey', target_role_key);
      audit_subject := NULL;

    WHEN 'role.update' THEN
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key, r.is_system INTO target_role_key, target_role_is_system
      FROM public.access_roles r WHERE r.id = target_role_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_is_system THEN
        RAISE EXCEPTION 'System role identity cannot be changed' USING ERRCODE = '42501';
      END IF;
      IF COALESCE(length(btrim(payload->>'label')), 0) < 2 THEN
        RAISE EXCEPTION 'Role label must contain at least two characters' USING ERRCODE = '22023';
      END IF;
      SELECT to_jsonb(r) INTO previous_state FROM public.access_roles r WHERE r.id = target_role_id;
      UPDATE public.access_roles
      SET label = btrim(payload->>'label'),
          description = COALESCE(payload->>'description', ''),
          is_active = COALESCE((payload->>'isActive')::boolean, is_active),
          updated_at = now()
      WHERE id = target_role_id
      RETURNING to_jsonb(access_roles) INTO next_state;
      audit_subject := NULL;

    WHEN 'role.delete' THEN
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key, r.is_system, to_jsonb(r)
      INTO target_role_key, target_role_is_system, previous_state
      FROM public.access_roles r WHERE r.id = target_role_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_is_system THEN
        RAISE EXCEPTION 'System roles cannot be deleted' USING ERRCODE = '42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.access_user_roles ur WHERE ur.role_id = target_role_id) THEN
        RAISE EXCEPTION 'Role still has user assignments' USING ERRCODE = '23503';
      END IF;
      DELETE FROM public.access_roles WHERE id = target_role_id;
      next_state := jsonb_build_object('deleted', true, 'roleKey', target_role_key);
      audit_subject := NULL;

    WHEN 'role.permissions.replace' THEN
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r
      WHERE r.id = target_role_id AND r.is_active IS TRUE
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Active role not found' USING ERRCODE = 'P0002';
      END IF;
      IF COALESCE(jsonb_typeof(payload->'grants'), '') <> 'array' THEN
        RAISE EXCEPTION 'Permission grants must be an array' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(payload->'grants') AS item
        WHERE NOT EXISTS (
          SELECT 1 FROM public.access_permissions p
          WHERE p.permission_key = item->>'permissionKey'
        )
        OR jsonb_typeof(item->'scope') <> 'object'
        OR COALESCE(item->'scope'->>'type', '') NOT IN ('all', 'self', 'owner', 'department')
        OR item->'scope'->>'version' IS DISTINCT FROM '1'
      ) THEN
        RAISE EXCEPTION 'Unknown permission or invalid scope' USING ERRCODE = '22023';
      END IF;
      IF target_role_key = 'admin' AND EXISTS (
        SELECT required_key.permission_key
        FROM (VALUES
          ('access.roles.manage'),
          ('access.permissions.assign'),
          ('access.users.assign_roles'),
          ('access.users.override'),
          ('access.audit.read')
        ) AS required_key(permission_key)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(payload->'grants') AS item
          WHERE item->>'permissionKey' = required_key.permission_key
            AND item->'scope'->>'type' = 'all'
        )
      ) THEN
        RAISE EXCEPTION 'The administrator role must retain access-management permissions'
          USING ERRCODE = '42501';
      END IF;
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope)),
        '[]'::jsonb
      )
      INTO previous_state
      FROM public.access_role_permissions rp
      WHERE rp.role_id = target_role_id;
      DELETE FROM public.access_role_permissions WHERE role_id = target_role_id;
      INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
      SELECT target_role_id, item->>'permissionKey', item->'scope', p_actor_user_id
      FROM jsonb_array_elements(payload->'grants') AS item;
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('permissionKey', rp.permission_key, 'scope', rp.scope)),
        '[]'::jsonb
      )
      INTO next_state
      FROM public.access_role_permissions rp
      WHERE rp.role_id = target_role_id;
      audit_subject := NULL;

    WHEN 'user.role.assign' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r
      WHERE r.id = target_role_id AND r.is_active IS TRUE;
      IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM public.profiles p WHERE p.id = target_user_id
      ) THEN
        RAISE EXCEPTION 'Active role or user profile not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_key <> 'admin' THEN
        SELECT count(DISTINCT ur.user_id) INTO admin_count
        FROM public.access_user_roles ur
        JOIN public.access_roles r ON r.id = ur.role_id
        WHERE r.role_key = 'admin'
          AND (ur.expires_at IS NULL OR ur.expires_at > now());
        IF admin_count <= 1 AND EXISTS (
          SELECT 1
          FROM public.access_user_roles ur
          JOIN public.access_roles r ON r.id = ur.role_id
          WHERE ur.user_id = target_user_id AND r.role_key = 'admin'
        ) THEN
          RAISE EXCEPTION 'Cannot replace the last administrator assignment'
            USING ERRCODE = '42501';
        END IF;
      END IF;
      DELETE FROM public.access_user_roles
      WHERE user_id = target_user_id AND role_id <> target_role_id;
      INSERT INTO public.access_user_roles (
        user_id, role_id, assigned_by, assignment_source, expires_at
      )
      VALUES (
        target_user_id,
        target_role_id,
        p_actor_user_id,
        'admin',
        NULLIF(payload->>'expiresAt', '')::timestamptz
      )
      ON CONFLICT (user_id, role_id) DO UPDATE
      SET assigned_by = EXCLUDED.assigned_by,
          assignment_source = 'admin',
          expires_at = EXCLUDED.expires_at;
      next_state := jsonb_build_object(
        'userId', target_user_id,
        'roleKey', target_role_key,
        'expiresAt', payload->'expiresAt'
      );
      audit_subject := target_user_id;

    WHEN 'user.role.revoke' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'roleId', '')::uuid;
      SELECT r.role_key INTO target_role_key
      FROM public.access_roles r WHERE r.id = target_role_id;
      IF target_role_key IS NULL THEN
        RAISE EXCEPTION 'Role not found' USING ERRCODE = 'P0002';
      END IF;
      IF target_role_key = 'admin' THEN
        SELECT count(DISTINCT ur.user_id) INTO admin_count
        FROM public.access_user_roles ur
        JOIN public.access_roles r ON r.id = ur.role_id
        WHERE r.role_key = 'admin'
          AND (ur.expires_at IS NULL OR ur.expires_at > now());
        IF admin_count <= 1 THEN
          RAISE EXCEPTION 'Cannot revoke the last administrator assignment'
            USING ERRCODE = '42501';
        END IF;
      END IF;
      DELETE FROM public.access_user_roles
      WHERE user_id = target_user_id AND role_id = target_role_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'User role assignment not found' USING ERRCODE = 'P0002';
      END IF;
      next_state := jsonb_build_object('revoked', true, 'roleKey', target_role_key);
      audit_subject := target_user_id;

    WHEN 'user.permission.override' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_permission_key := NULLIF(payload->>'permissionKey', '');
      target_effect := payload->>'effect';
      IF target_permission_key LIKE 'access.%' THEN
        RAISE EXCEPTION 'Access-management permissions cannot be overridden per user'
          USING ERRCODE = '42501';
      END IF;
      IF target_effect NOT IN ('allow', 'deny') OR target_reason IS NULL THEN
        RAISE EXCEPTION 'Override effect and reason are required' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = target_user_id)
         OR NOT EXISTS (
           SELECT 1 FROM public.access_permissions p
           WHERE p.permission_key = target_permission_key
         ) THEN
        RAISE EXCEPTION 'User or permission not found' USING ERRCODE = 'P0002';
      END IF;
      SELECT to_jsonb(uo) INTO previous_state
      FROM public.access_user_overrides uo
      WHERE uo.user_id = target_user_id
        AND uo.permission_key = target_permission_key
        AND uo.scope = target_scope
      FOR UPDATE;
      INSERT INTO public.access_user_overrides (
        user_id, permission_key, effect, scope, reason, granted_by, expires_at
      )
      VALUES (
        target_user_id,
        target_permission_key,
        target_effect,
        target_scope,
        target_reason,
        p_actor_user_id,
        NULLIF(payload->>'expiresAt', '')::timestamptz
      )
      ON CONFLICT (user_id, permission_key, scope) DO UPDATE
      SET effect = EXCLUDED.effect,
          reason = EXCLUDED.reason,
          granted_by = EXCLUDED.granted_by,
          created_at = now(),
          expires_at = EXCLUDED.expires_at
      RETURNING to_jsonb(access_user_overrides) INTO next_state;
      audit_subject := target_user_id;

    WHEN 'user.permission.override.revoke' THEN
      target_user_id := NULLIF(payload->>'userId', '')::uuid;
      target_role_id := NULLIF(payload->>'overrideId', '')::uuid;
      SELECT to_jsonb(uo), uo.permission_key
      INTO previous_state, target_permission_key
      FROM public.access_user_overrides uo
      WHERE uo.id = target_role_id AND uo.user_id = target_user_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'User permission override not found' USING ERRCODE = 'P0002';
      END IF;
      DELETE FROM public.access_user_overrides WHERE id = target_role_id;
      next_state := jsonb_build_object('revoked', true, 'permissionKey', target_permission_key);
      audit_subject := target_user_id;
  END CASE;

  INSERT INTO public.access_audit_log (
    actor_user_id,
    subject_user_id,
    action_key,
    role_key,
    permission_key,
    reason,
    before_state,
    after_state
  )
  VALUES (
    p_actor_user_id,
    audit_subject,
    p_operation,
    target_role_key,
    target_permission_key,
    target_reason,
    previous_state,
    next_state
  );

  RETURN COALESCE(next_state, '{}'::jsonb);
END;
$function$;

COMMIT;
