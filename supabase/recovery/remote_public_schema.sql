


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."cashier_transaction_status" AS ENUM (
    'draft',
    'posted',
    'cancelled'
);


ALTER TYPE "public"."cashier_transaction_status" OWNER TO "postgres";


CREATE TYPE "public"."transaction_type_category" AS ENUM (
    'entree',
    'sortie'
);


ALTER TYPE "public"."transaction_type_category" OWNER TO "postgres";


CREATE TYPE "public"."user_role_enum" AS ENUM (
    'admin',
    'rh',
    'manager_stock',
    'caissier',
    'agent',
    'manager',
    'caissiere',
    'employe',
    'tresorier',
    'comptable'
);


ALTER TYPE "public"."user_role_enum" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."access_control_mutate"("p_actor_user_id" "uuid", "p_operation" "text", "p_payload" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  required_permission text;
  actor_is_active boolean;
  actor_is_admin boolean;
  target_role_id uuid;
  target_role_key text;
  target_user_id uuid;
  next_state jsonb;
  audit_subject uuid;
  admin_count integer;
BEGIN
  -- Vérification de l'administrateur appelant
  SELECT (p.is_active IS TRUE AND p.role = 'admin') INTO actor_is_admin
  FROM public.profiles p WHERE p.id = p_actor_user_id;

  IF actor_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'Active administrator required' USING ERRCODE = '42501';
  END IF;

  CASE p_operation
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

      -- RÈGLE D'UNICITÉ : purge des anciens rôles de cet utilisateur
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
$$;


ALTER FUNCTION "public"."access_control_mutate"("p_actor_user_id" "uuid", "p_operation" "text", "p_payload" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_cashier_journal_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NEW.journal_id IS NULL THEN
    SELECT j.id
      INTO NEW.journal_id
      FROM public.journals AS j
     WHERE j.sequence_prefix = 'CSH1'
       AND j.is_active;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assign_cashier_journal_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_piece_comptable_on_post"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  annee_piece integer;
  prochain_numero integer;
  candidat_piece text;
  existe boolean;
begin
  if NEW.piece_comptable is not null and btrim(NEW.piece_comptable) <> '' then
    return NEW;
  end if;

  if NEW.status <> 'posted' then
    return NEW;
  end if;

  annee_piece := coalesce(
    nullif(substring(NEW.date::text from '^(\d{4})-'), '')::int,
    nullif(substring(NEW.date::text from '(\d{4})$'), '')::int,
    extract(year from now())::int
  );

  insert into public.cashier_piece_counters (annee, dernier_numero)
  values (annee_piece, 0)
  on conflict (annee) do nothing;

  loop
    update public.cashier_piece_counters
    set dernier_numero = dernier_numero + 1
    where annee = annee_piece
    returning dernier_numero into prochain_numero;

    if prochain_numero is null then
      raise exception 'Impossible d''obtenir le compteur de caisse pour l''année %', annee_piece;
    end if;

    candidat_piece := 'CSH1/' || annee_piece || '/' || lpad(prochain_numero::text, 5, '0');

    select exists (
      select 1 from public.cashier_transactions where piece_comptable = candidat_piece
    ) into existe;

    if not existe then
      NEW.piece_comptable := candidat_piece;
      exit;
    end if;
  end loop;

  return NEW;
end;
$_$;


ALTER FUNCTION "public"."assign_piece_comptable_on_post"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_short_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
DECLARE
  chars text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..8 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$;


ALTER FUNCTION "public"."generate_short_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_cashier_summary"("p_journal_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
declare
  v_csh1 uuid;
  v_result jsonb;
begin
  select j.id into v_csh1 from public.journals j where j.sequence_prefix = 'CSH1';

  -- Journal autre que la caisse principale : solde calculé sur ses écritures
  if p_journal_id is not null and p_journal_id is distinct from v_csh1 then
    return public.get_journal_summary(p_journal_id);
  end if;

  -- Caisse principale (CSH1) : opérations de caisse comptabilisées uniquement
  select jsonb_build_object(
    'journal_id',    v_csh1,
    'solde_global',  coalesce(sum(t.montant) filter (where t.status = 'posted'), 0),
    'total_entrees', coalesce(sum(t.montant) filter (where t.status = 'posted' and t.montant > 0), 0),
    'total_sorties', coalesce(-sum(t.montant) filter (where t.status = 'posted' and t.montant < 0), 0),
    'total_count',   count(*) filter (where t.status = 'posted'),
    'nb_brouillons', count(*) filter (where t.status = 'draft'),
    'nb_annulees',   count(*) filter (where t.status = 'cancelled')
  )
  into v_result
  from public.cashier_transactions t
  where t.journal_id is not distinct from v_csh1 or t.journal_id is null;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."get_cashier_summary"("p_journal_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_cashier_summary"("p_journal_id" "uuid") IS 'Solde et totaux calculés en base. Seules les opérations posted comptent (brouillons et annulées exclus). p_journal_id NULL ou CSH1 = caisse principale.';



CREATE OR REPLACE FUNCTION "public"."get_journal_summary"("p_journal_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select jsonb_build_object(
    'journal_id',    p_journal_id,
    'solde_global',  coalesce(sum(e.montant) filter (where e.status = 'posted'), 0),
    'total_entrees', coalesce(sum(e.montant) filter (where e.status = 'posted' and e.montant > 0), 0),
    'total_sorties', coalesce(-sum(e.montant) filter (where e.status = 'posted' and e.montant < 0), 0),
    'total_count',   count(*) filter (where e.status = 'posted'),
    'nb_brouillons', count(*) filter (where e.status = 'draft'),
    'nb_annulees',   count(*) filter (where e.status = 'cancelled')
  )
  from public.journal_entries e
  where e.journal_id = p_journal_id;
$$;


ALTER FUNCTION "public"."get_journal_summary"("p_journal_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_journal_summary"("p_journal_id" "uuid") IS 'Solde et totaux d''un journal calculés en base sur les écritures posted uniquement.';



CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."provision_collaborator"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_email" "text", "p_first_name" "text", "p_last_name" "text", "p_role_key" "text", "p_department" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_must_change_password" boolean DEFAULT true, "p_is_active" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'Auth user not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.profiles (id, email, first_name, last_name, role, department, phone, is_active, must_change_password)
  VALUES (p_user_id, p_email, COALESCE(p_first_name, ''), COALESCE(p_last_name, ''),
          'employe'::public.user_role_enum,
          COALESCE(p_department, 'Services Généraux'), COALESCE(p_phone, ''),
          COALESCE(p_is_active, true), COALESCE(p_must_change_password, true))
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      department = COALESCE(p_department, public.profiles.department),
      phone = COALESCE(p_phone, public.profiles.phone),
      is_active = EXCLUDED.is_active,
      must_change_password = EXCLUDED.must_change_password;

  v_result := public.sync_user_primary_role(p_actor_user_id, p_user_id, p_role_key, true);

  INSERT INTO public.access_audit_log (actor_user_id, subject_user_id, action_key, role_key, after_state)
  VALUES (p_actor_user_id, p_user_id, 'collaborator.provision', p_role_key,
          jsonb_build_object('email', p_email, 'isActive', p_is_active));

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."provision_collaborator"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_email" "text", "p_first_name" "text", "p_last_name" "text", "p_role_key" "text", "p_department" "text", "p_phone" "text", "p_must_change_password" boolean, "p_is_active" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_user_primary_role"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_role_key" "text", "p_exclusive" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_role_id uuid;
  v_admin_count integer;
  v_is_current_admin boolean;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF p_role_key IS NULL OR p_role_key NOT IN ('admin','manager','tresorier','caissiere','comptable','employe') THEN
    RAISE EXCEPTION 'Role cannot be synchronized with the legacy profile' USING ERRCODE = '22023';
  END IF;

  SELECT r.id INTO v_role_id
  FROM public.access_roles r WHERE r.role_key = p_role_key AND r.is_active IS TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active role not found' USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1 FROM public.profiles p WHERE p.id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_role_key <> 'admin' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.access_user_roles ur
      JOIN public.access_roles r ON r.id = ur.role_id
      WHERE ur.user_id = p_user_id AND r.role_key = 'admin'
        AND (ur.expires_at IS NULL OR ur.expires_at > now())
    ) INTO v_is_current_admin;

    IF v_is_current_admin THEN
      SELECT count(DISTINCT ur.user_id) INTO v_admin_count
      FROM public.access_user_roles ur
      JOIN public.access_roles r ON r.id = ur.role_id
      WHERE r.role_key = 'admin' AND (ur.expires_at IS NULL OR ur.expires_at > now());
      IF v_admin_count <= 1 THEN
        RAISE EXCEPTION 'Cannot replace the last administrator assignment' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(r.role_key ORDER BY r.role_key), '[]'::jsonb) INTO v_before
  FROM public.access_user_roles ur JOIN public.access_roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id;

  -- 1) assurer le nouveau rôle  2) retirer les anciens : jamais d'utilisateur sans rôle
  INSERT INTO public.access_user_roles (user_id, role_id, assigned_by, assignment_source, expires_at)
  VALUES (p_user_id, v_role_id, p_actor_user_id, 'legacy_profile', NULL)
  ON CONFLICT (user_id, role_id) DO UPDATE
  SET assigned_by = EXCLUDED.assigned_by, expires_at = NULL;

  DELETE FROM public.access_user_roles
  WHERE user_id = p_user_id
    AND role_id <> v_role_id
    AND (p_exclusive OR assignment_source = 'legacy_profile');

  UPDATE public.profiles
  SET role = p_role_key::public.user_role_enum
  WHERE id = p_user_id AND role IS DISTINCT FROM p_role_key::public.user_role_enum;

  SELECT COALESCE(jsonb_agg(r.role_key ORDER BY r.role_key), '[]'::jsonb) INTO v_after
  FROM public.access_user_roles ur JOIN public.access_roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id;

  INSERT INTO public.access_audit_log (actor_user_id, subject_user_id, action_key, role_key, before_state, after_state)
  VALUES (p_actor_user_id, p_user_id, 'user.role.sync', p_role_key,
          jsonb_build_object('roles', v_before), jsonb_build_object('roles', v_after, 'exclusive', p_exclusive));

  RETURN jsonb_build_object('userId', p_user_id, 'roleKey', p_role_key, 'roles', v_after);
END;
$$;


ALTER FUNCTION "public"."sync_user_primary_role"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_role_key" "text", "p_exclusive" boolean) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."access_audit_log" (
    "id" bigint NOT NULL,
    "actor_user_id" "uuid",
    "subject_user_id" "uuid",
    "action_key" "text" NOT NULL,
    "role_key" "text",
    "permission_key" "text",
    "reason" "text",
    "before_state" "jsonb",
    "after_state" "jsonb",
    "request_id" "text",
    "ip_address" "inet",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."access_audit_log" OWNER TO "postgres";


ALTER TABLE "public"."access_audit_log" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."access_audit_log_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."access_permissions" (
    "permission_key" "text" NOT NULL,
    "resource_key" "text" NOT NULL,
    "action_key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "is_sensitive" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "access_permissions_key_parts_match" CHECK (("permission_key" = (("resource_key" || '.'::"text") || "action_key"))),
    CONSTRAINT "access_permissions_permission_key_check" CHECK (("permission_key" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'::"text"))
);


ALTER TABLE "public"."access_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."access_role_permissions" (
    "role_id" "uuid" NOT NULL,
    "permission_key" "text" NOT NULL,
    "scope" "jsonb" DEFAULT '{"type": "all", "version": 1}'::"jsonb" NOT NULL,
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "access_role_permissions_scope_check" CHECK ((("jsonb_typeof"("scope") = 'object'::"text") AND ("jsonb_typeof"(("scope" -> 'type'::"text")) = 'string'::"text") AND (NULLIF("btrim"(("scope" ->> 'type'::"text")), ''::"text") IS NOT NULL) AND ("jsonb_typeof"(("scope" -> 'version'::"text")) = 'number'::"text") AND ((("scope" ->> 'version'::"text"))::integer >= 1)))
);


ALTER TABLE "public"."access_role_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."access_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role_key" "text" NOT NULL,
    "label" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "access_roles_role_key_check" CHECK (("role_key" ~ '^[a-z][a-z0-9_]{1,63}$'::"text"))
);


ALTER TABLE "public"."access_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."access_user_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "permission_key" "text" NOT NULL,
    "effect" "text" NOT NULL,
    "scope" "jsonb" DEFAULT '{"type": "all", "version": 1}'::"jsonb" NOT NULL,
    "reason" "text" NOT NULL,
    "granted_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    CONSTRAINT "access_user_overrides_check" CHECK ((("expires_at" IS NULL) OR ("expires_at" > "created_at"))),
    CONSTRAINT "access_user_overrides_effect_check" CHECK (("effect" = ANY (ARRAY['allow'::"text", 'deny'::"text"]))),
    CONSTRAINT "access_user_overrides_reason_check" CHECK (("length"(TRIM(BOTH FROM "reason")) > 0)),
    CONSTRAINT "access_user_overrides_scope_check" CHECK ((("jsonb_typeof"("scope") = 'object'::"text") AND ("jsonb_typeof"(("scope" -> 'type'::"text")) = 'string'::"text") AND (NULLIF("btrim"(("scope" ->> 'type'::"text")), ''::"text") IS NOT NULL) AND ("jsonb_typeof"(("scope" -> 'version'::"text")) = 'number'::"text") AND ((("scope" ->> 'version'::"text"))::integer >= 1)))
);


ALTER TABLE "public"."access_user_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."access_user_roles" (
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "assigned_by" "uuid",
    "assignment_source" "text" DEFAULT 'admin'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone,
    CONSTRAINT "access_user_roles_assignment_source_check" CHECK (("assignment_source" = ANY (ARRAY['admin'::"text", 'legacy_profile'::"text"]))),
    CONSTRAINT "access_user_roles_check" CHECK ((("expires_at" IS NULL) OR ("expires_at" > "created_at")))
);


ALTER TABLE "public"."access_user_roles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "user_email" "text",
    "user_role" "text",
    "action" "text" NOT NULL,
    "entity_type" "text" DEFAULT 'cashier_transaction'::"text" NOT NULL,
    "entity_id" "text",
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "ip_address" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";


COMMENT ON TABLE "public"."audit_logs" IS 'Journaux d''audit et de traçabilité des opérations de caisse et de sécurité.';



COMMENT ON COLUMN "public"."audit_logs"."action" IS 'Type d''action tracée (ex: CREATE_OPERATION, UPDATE_OPERATION, DELETE_OPERATION).';



COMMENT ON COLUMN "public"."audit_logs"."details" IS 'Contenu JSON des modifications ou métadonnées contextuelles de l''action.';



CREATE TABLE IF NOT EXISTS "public"."cashier_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "date" "date" NOT NULL,
    "libelle" "text" NOT NULL,
    "service" "text",
    "type_description" "text",
    "category" "public"."transaction_type_category" NOT NULL,
    "status" "public"."cashier_transaction_status" DEFAULT 'draft'::"public"."cashier_transaction_status" NOT NULL,
    "no_dossier" "text",
    "dossier_id" "uuid",
    "first_name" "text",
    "partenaire" "text",
    "employee" "text",
    "employee_id" "uuid",
    "quantity" numeric,
    "montant" numeric NOT NULL,
    "solde_apres" numeric,
    "selected" boolean DEFAULT false,
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "piece_comptable" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "journal_id" "uuid",
    CONSTRAINT "chk_cashier_montant_nonzero" CHECK (("montant" <> (0)::numeric)),
    CONSTRAINT "chk_cashier_montant_sign" CHECK ((((("category")::"text" = 'entree'::"text") AND ("montant" > (0)::numeric)) OR ((("category")::"text" = 'sortie'::"text") AND ("montant" < (0)::numeric)))),
    CONSTRAINT "chk_operations_requires_dossier" CHECK ((("service" <> 'Opérations'::"text") OR ("no_dossier" IS NOT NULL) OR ("dossier_id" IS NOT NULL))),
    CONSTRAINT "chk_operations_requires_quantity" CHECK ((("service" <> 'Opérations'::"text") OR ("quantity" IS NOT NULL)))
);


ALTER TABLE "public"."cashier_transactions" OWNER TO "postgres";


COMMENT ON TABLE "public"."cashier_transactions" IS 'Transactions de caisse (entrées/sorties) — correspond à l''interface CashierTransaction côté app.';



COMMENT ON COLUMN "public"."cashier_transactions"."dossier_id" IS 'Référence forte vers dossiers.id — no_dossier reste en texte libre pour rétrocompatibilité.';



COMMENT ON COLUMN "public"."cashier_transactions"."employee_id" IS 'Référence forte vers profiles.id — employee/firstName restent en texte libre pour rétrocompatibilité.';



COMMENT ON COLUMN "public"."cashier_transactions"."solde_apres" IS 'OBSOLÈTE / non fiable : utiliser cashier_transactions_with_balance.solde_progressif.';



COMMENT ON COLUMN "public"."cashier_transactions"."created_by" IS 'Utilisateur ayant créé la ligne. Base de la règle : chacun ne modifie que ce qu''il a créé (admin excepté).';



COMMENT ON COLUMN "public"."cashier_transactions"."piece_comptable" IS 'Numéro de pièce comptable unique (ex: CSH1/2026/00001) garantissant l''absence de doublon.';



CREATE OR REPLACE VIEW "public"."cashier_balance_summary" WITH ("security_invoker"='true') AS
 SELECT COALESCE("sum"("montant") FILTER (WHERE ("status" = 'posted'::"public"."cashier_transaction_status")), (0)::numeric) AS "solde_total",
    COALESCE("sum"("montant") FILTER (WHERE (("status" = 'posted'::"public"."cashier_transaction_status") AND ("montant" > (0)::numeric))), (0)::numeric) AS "total_entrees",
    COALESCE((- "sum"("montant") FILTER (WHERE (("status" = 'posted'::"public"."cashier_transaction_status") AND ("montant" < (0)::numeric)))), (0)::numeric) AS "total_sorties",
    "count"(*) FILTER (WHERE ("status" = 'posted'::"public"."cashier_transaction_status")) AS "nb_operations"
   FROM "public"."cashier_transactions";


ALTER VIEW "public"."cashier_balance_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cashier_piece_counters" (
    "annee" integer NOT NULL,
    "dernier_numero" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."cashier_piece_counters" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."cashier_transactions_with_balance" WITH ("security_invoker"='true') AS
 SELECT "id",
    "date",
    "libelle",
    "service",
    "type_description",
    "category",
    "status",
    "no_dossier",
    "dossier_id",
    "first_name",
    "partenaire",
    "employee",
    "employee_id",
    "quantity",
    "montant",
    "solde_apres",
    "selected",
    "created_by",
    "piece_comptable",
    "created_at",
    "updated_at",
    "journal_id",
    "sum"(
        CASE
            WHEN ("status" = 'posted'::"public"."cashier_transaction_status") THEN "montant"
            ELSE (0)::numeric
        END) OVER (ORDER BY "date", "created_at", "id" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "solde_progressif"
   FROM "public"."cashier_transactions" "t";


ALTER VIEW "public"."cashier_transactions_with_balance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dossiers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "no_dossier" "text" NOT NULL,
    "client" "text",
    "statut" "text" DEFAULT 'ouvert'::"text" NOT NULL,
    "description" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "prospect_id" "uuid" NOT NULL
);


ALTER TABLE "public"."dossiers" OWNER TO "postgres";


COMMENT ON TABLE "public"."dossiers" IS 'Dossiers opérationnels référencés par les transactions de caisse de service "Opérations".';



CREATE TABLE IF NOT EXISTS "public"."journal_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "journal_id" "uuid" NOT NULL,
    "sequence_number" integer NOT NULL,
    "piece_comptable" character varying(50) NOT NULL,
    "date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "libelle" "text" NOT NULL,
    "service" character varying(100),
    "type_description" character varying(150),
    "category" character varying(20) NOT NULL,
    "status" character varying(20) DEFAULT 'draft'::character varying NOT NULL,
    "no_dossier" character varying(100),
    "partenaire" character varying(200),
    "employee" character varying(200),
    "quantity" numeric(10,2) DEFAULT 1,
    "montant" numeric(15,2) NOT NULL,
    "solde_apres" numeric(15,2),
    "created_by" "uuid",
    "employee_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "chk_je_montant_nonzero" CHECK (("montant" <> (0)::numeric)),
    CONSTRAINT "chk_je_montant_sign" CHECK ((((("category")::"text" = 'entree'::"text") AND ("montant" > (0)::numeric)) OR ((("category")::"text" = 'sortie'::"text") AND ("montant" < (0)::numeric)))),
    CONSTRAINT "journal_entries_category_check" CHECK ((("category")::"text" = ANY ((ARRAY['entree'::character varying, 'sortie'::character varying])::"text"[]))),
    CONSTRAINT "journal_entries_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['draft'::character varying, 'posted'::character varying, 'cancelled'::character varying])::"text"[])))
);


ALTER TABLE "public"."journal_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."journal_piece_counters" (
    "journal_id" "uuid" NOT NULL,
    "annee" integer NOT NULL,
    "dernier_numero" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."journal_piece_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."journals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "ledger_type" "text" DEFAULT ''::"text",
    "sequence_prefix" character varying(10) NOT NULL,
    "default_account" "text" NOT NULL,
    "currency" character varying(10) DEFAULT 'XAF'::character varying NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    CONSTRAINT "journals_type_check" CHECK (("type" = ANY (ARRAY['cash'::"text", 'bank'::"text", 'sale'::"text", 'purchase'::"text", 'general'::"text", 'divers'::"text"])))
);


ALTER TABLE "public"."journals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "first_name" "text" NOT NULL,
    "last_name" "text" NOT NULL,
    "role" "public"."user_role_enum" DEFAULT 'agent'::"public"."user_role_enum" NOT NULL,
    "department" "text" DEFAULT 'Services Généraux'::"text",
    "phone" "text",
    "avatar_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "must_change_password" boolean DEFAULT false NOT NULL,
    "user_code" "text" DEFAULT "public"."generate_short_id"() NOT NULL,
    "last_login_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."prospects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "company_name" "text",
    "contact_name" "text",
    "email" "text",
    "phone" "text",
    "source" "text",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "assigned_to" "uuid",
    "estimated_value" numeric(14,2),
    "currency" character varying(3) DEFAULT 'XAF'::character varying NOT NULL,
    "next_follow_up" "date",
    "notes" "text" DEFAULT ''::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "prospects_company_name_check" CHECK ((("company_name" IS NULL) OR ("length"("btrim"("company_name")) <= 200))),
    CONSTRAINT "prospects_contact_name_check" CHECK ((("contact_name" IS NULL) OR ("length"("btrim"("contact_name")) <= 200))),
    CONSTRAINT "prospects_currency_check" CHECK ((("currency")::"text" ~ '^[A-Z]{3}$'::"text")),
    CONSTRAINT "prospects_email_check" CHECK ((("email" IS NULL) OR ("length"("btrim"("email")) <= 320))),
    CONSTRAINT "prospects_estimated_value_check" CHECK ((("estimated_value" IS NULL) OR ("estimated_value" >= (0)::numeric))),
    CONSTRAINT "prospects_name_check" CHECK ((("length"("btrim"("name")) >= 2) AND ("length"("btrim"("name")) <= 200))),
    CONSTRAINT "prospects_notes_check" CHECK (("length"("notes") <= 10000)),
    CONSTRAINT "prospects_phone_check" CHECK ((("phone" IS NULL) OR ("length"("btrim"("phone")) <= 40))),
    CONSTRAINT "prospects_source_check" CHECK ((("source" IS NULL) OR ("length"("btrim"("source")) <= 100))),
    CONSTRAINT "prospects_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'contacted'::"text", 'qualified'::"text", 'converted'::"text", 'lost'::"text"])))
);


ALTER TABLE "public"."prospects" OWNER TO "postgres";


ALTER TABLE ONLY "public"."access_audit_log"
    ADD CONSTRAINT "access_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."access_permissions"
    ADD CONSTRAINT "access_permissions_pkey" PRIMARY KEY ("permission_key");



ALTER TABLE ONLY "public"."access_role_permissions"
    ADD CONSTRAINT "access_role_permissions_pkey" PRIMARY KEY ("role_id", "permission_key", "scope");



ALTER TABLE ONLY "public"."access_roles"
    ADD CONSTRAINT "access_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."access_roles"
    ADD CONSTRAINT "access_roles_role_key_key" UNIQUE ("role_key");



ALTER TABLE ONLY "public"."access_user_overrides"
    ADD CONSTRAINT "access_user_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."access_user_overrides"
    ADD CONSTRAINT "access_user_overrides_unique_scope" UNIQUE ("user_id", "permission_key", "scope");



ALTER TABLE ONLY "public"."access_user_roles"
    ADD CONSTRAINT "access_user_roles_pkey" PRIMARY KEY ("user_id", "role_id");



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cashier_piece_counters"
    ADD CONSTRAINT "cashier_piece_counters_pkey" PRIMARY KEY ("annee");



ALTER TABLE ONLY "public"."cashier_transactions"
    ADD CONSTRAINT "cashier_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dossiers"
    ADD CONSTRAINT "dossiers_no_dossier_key" UNIQUE ("no_dossier");



ALTER TABLE ONLY "public"."dossiers"
    ADD CONSTRAINT "dossiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journal_piece_counters"
    ADD CONSTRAINT "journal_piece_counters_pkey" PRIMARY KEY ("journal_id", "annee");



ALTER TABLE ONLY "public"."journals"
    ADD CONSTRAINT "journals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journals"
    ADD CONSTRAINT "journals_sequence_prefix_key" UNIQUE ("sequence_prefix");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_code_key" UNIQUE ("user_code");



ALTER TABLE ONLY "public"."prospects"
    ADD CONSTRAINT "prospects_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "uq_journal_entries_piece" UNIQUE ("journal_id", "piece_comptable");



ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "uq_journal_entries_seq" UNIQUE ("journal_id", "sequence_number");



CREATE INDEX "idx_access_audit_log_actor_created" ON "public"."access_audit_log" USING "btree" ("actor_user_id", "created_at" DESC);



CREATE INDEX "idx_access_audit_log_subject_created" ON "public"."access_audit_log" USING "btree" ("subject_user_id", "created_at" DESC);



CREATE INDEX "idx_access_role_permissions_granted_by" ON "public"."access_role_permissions" USING "btree" ("granted_by");



CREATE INDEX "idx_access_role_permissions_permission" ON "public"."access_role_permissions" USING "btree" ("permission_key", "role_id");



CREATE INDEX "idx_access_roles_created_by" ON "public"."access_roles" USING "btree" ("created_by");



CREATE INDEX "idx_access_user_overrides_granted_by" ON "public"."access_user_overrides" USING "btree" ("granted_by");



CREATE INDEX "idx_access_user_overrides_lookup" ON "public"."access_user_overrides" USING "btree" ("user_id", "permission_key", "expires_at");



CREATE INDEX "idx_access_user_overrides_permission_key" ON "public"."access_user_overrides" USING "btree" ("permission_key");



CREATE INDEX "idx_access_user_roles_assigned_by" ON "public"."access_user_roles" USING "btree" ("assigned_by");



CREATE INDEX "idx_access_user_roles_expiration" ON "public"."access_user_roles" USING "btree" ("expires_at") WHERE ("expires_at" IS NOT NULL);



CREATE INDEX "idx_access_user_roles_role" ON "public"."access_user_roles" USING "btree" ("role_id", "user_id");



CREATE INDEX "idx_audit_logs_action" ON "public"."audit_logs" USING "btree" ("action");



CREATE INDEX "idx_audit_logs_created_at" ON "public"."audit_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_logs_entity" ON "public"."audit_logs" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_audit_logs_user_id" ON "public"."audit_logs" USING "btree" ("user_id");



CREATE INDEX "idx_cashier_piece_comptable" ON "public"."cashier_transactions" USING "btree" ("piece_comptable");



CREATE INDEX "idx_cashier_transactions_category" ON "public"."cashier_transactions" USING "btree" ("category");



CREATE INDEX "idx_cashier_transactions_created_by" ON "public"."cashier_transactions" USING "btree" ("created_by");



CREATE INDEX "idx_cashier_transactions_date" ON "public"."cashier_transactions" USING "btree" ("date");



CREATE INDEX "idx_cashier_transactions_dossier_id" ON "public"."cashier_transactions" USING "btree" ("dossier_id");



CREATE INDEX "idx_cashier_transactions_employee_id" ON "public"."cashier_transactions" USING "btree" ("employee_id");



CREATE INDEX "idx_cashier_transactions_journal_id" ON "public"."cashier_transactions" USING "btree" ("journal_id");



CREATE INDEX "idx_cashier_transactions_keyset" ON "public"."cashier_transactions" USING "btree" ("date", "created_at", "id");



CREATE INDEX "idx_cashier_transactions_service" ON "public"."cashier_transactions" USING "btree" ("service");



CREATE INDEX "idx_cashier_transactions_status" ON "public"."cashier_transactions" USING "btree" ("status");



CREATE INDEX "idx_dossiers_created_by" ON "public"."dossiers" USING "btree" ("created_by");



CREATE INDEX "idx_dossiers_prospect_id" ON "public"."dossiers" USING "btree" ("prospect_id") WHERE ("prospect_id" IS NOT NULL);



CREATE INDEX "idx_journal_entries_created_by" ON "public"."journal_entries" USING "btree" ("created_by");



CREATE INDEX "idx_journal_entries_date" ON "public"."journal_entries" USING "btree" ("journal_id", "date", "sequence_number");



CREATE INDEX "idx_journal_entries_journal_id" ON "public"."journal_entries" USING "btree" ("journal_id");



CREATE INDEX "idx_journal_entries_seq" ON "public"."journal_entries" USING "btree" ("journal_id", "sequence_number");



CREATE INDEX "idx_journals_created_by" ON "public"."journals" USING "btree" ("created_by");



CREATE INDEX "idx_journals_is_active" ON "public"."journals" USING "btree" ("is_active");



CREATE INDEX "idx_journals_type" ON "public"."journals" USING "btree" ("type");



CREATE INDEX "idx_profiles_department" ON "public"."profiles" USING "btree" ("department");



CREATE INDEX "idx_profiles_email" ON "public"."profiles" USING "btree" ("email");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_prospects_assigned_to" ON "public"."prospects" USING "btree" ("assigned_to");



CREATE INDEX "idx_prospects_created_by" ON "public"."prospects" USING "btree" ("created_by");



CREATE INDEX "idx_prospects_email_lower" ON "public"."prospects" USING "btree" ("lower"("email")) WHERE ("email" IS NOT NULL);



CREATE INDEX "idx_prospects_follow_up" ON "public"."prospects" USING "btree" ("next_follow_up") WHERE ("next_follow_up" IS NOT NULL);



CREATE INDEX "idx_prospects_status_created" ON "public"."prospects" USING "btree" ("status", "created_at" DESC);



CREATE UNIQUE INDEX "uq_cashier_transactions_business_fingerprint" ON "public"."cashier_transactions" USING "btree" ("date", "abs"("montant"), "regexp_replace"("lower"("btrim"("libelle")), '\s+'::"text", ' '::"text", 'g'::"text"), "regexp_replace"("lower"("btrim"(COALESCE("no_dossier", ''::"text"))), '\s+'::"text", ' '::"text", 'g'::"text"), "regexp_replace"("lower"("btrim"(COALESCE("service", ''::"text"))), '\s+'::"text", ' '::"text", 'g'::"text")) WHERE ("status" <> 'cancelled'::"public"."cashier_transaction_status");



CREATE UNIQUE INDEX "uq_cashier_transactions_piece_comptable" ON "public"."cashier_transactions" USING "btree" ("piece_comptable") WHERE ("piece_comptable" IS NOT NULL);



CREATE OR REPLACE TRIGGER "set_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "trg_assign_cashier_journal_id" BEFORE INSERT ON "public"."cashier_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."assign_cashier_journal_id"();



CREATE OR REPLACE TRIGGER "trg_assign_journal_entry_piece_comptable" BEFORE INSERT ON "public"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "private"."assign_journal_entry_piece_comptable"();



CREATE OR REPLACE TRIGGER "trg_assign_piece_comptable_on_post_insert" BEFORE INSERT ON "public"."cashier_transactions" FOR EACH ROW WHEN (("new"."status" = 'posted'::"public"."cashier_transaction_status")) EXECUTE FUNCTION "public"."assign_piece_comptable_on_post"();



CREATE OR REPLACE TRIGGER "trg_assign_piece_comptable_on_post_update" BEFORE UPDATE OF "status" ON "public"."cashier_transactions" FOR EACH ROW WHEN ((("old"."status" IS DISTINCT FROM "new"."status") AND ("new"."status" = 'posted'::"public"."cashier_transaction_status"))) EXECUTE FUNCTION "public"."assign_piece_comptable_on_post"();



CREATE OR REPLACE TRIGGER "trg_audit_cashier_transactions" AFTER INSERT OR DELETE OR UPDATE ON "public"."cashier_transactions" FOR EACH ROW EXECUTE FUNCTION "private"."audit_row_change"();



CREATE OR REPLACE TRIGGER "trg_audit_journal_entries" AFTER INSERT OR DELETE OR UPDATE ON "public"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "private"."audit_row_change"();



CREATE OR REPLACE TRIGGER "trg_cashier_balance_broadcast_invalidation" AFTER INSERT OR DELETE OR UPDATE ON "public"."cashier_transactions" FOR EACH STATEMENT EXECUTE FUNCTION "private"."broadcast_balance_invalidation"();



CREATE OR REPLACE TRIGGER "trg_cashier_transactions_updated_at" BEFORE UPDATE ON "public"."cashier_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_dossiers_updated_at" BEFORE UPDATE ON "public"."dossiers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_journal_balance_broadcast_invalidation" AFTER INSERT OR DELETE OR UPDATE ON "public"."journal_entries" FOR EACH STATEMENT EXECUTE FUNCTION "private"."broadcast_balance_invalidation"();



CREATE OR REPLACE TRIGGER "trg_normalize_montant_sign" BEFORE INSERT OR UPDATE OF "montant", "category" ON "public"."cashier_transactions" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_montant_sign"();



CREATE OR REPLACE TRIGGER "trg_normalize_montant_sign" BEFORE INSERT OR UPDATE OF "montant", "category" ON "public"."journal_entries" FOR EACH ROW EXECUTE FUNCTION "private"."normalize_montant_sign"();



CREATE OR REPLACE TRIGGER "trg_prospects_updated_at" BEFORE UPDATE ON "public"."prospects" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."access_audit_log"
    ADD CONSTRAINT "access_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_audit_log"
    ADD CONSTRAINT "access_audit_log_subject_user_id_fkey" FOREIGN KEY ("subject_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_role_permissions"
    ADD CONSTRAINT "access_role_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_role_permissions"
    ADD CONSTRAINT "access_role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."access_permissions"("permission_key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."access_role_permissions"
    ADD CONSTRAINT "access_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."access_roles"
    ADD CONSTRAINT "access_roles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_user_overrides"
    ADD CONSTRAINT "access_user_overrides_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."access_user_overrides"
    ADD CONSTRAINT "access_user_overrides_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "public"."access_permissions"("permission_key") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."access_user_overrides"
    ADD CONSTRAINT "access_user_overrides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."access_user_roles"
    ADD CONSTRAINT "access_user_roles_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."access_user_roles"
    ADD CONSTRAINT "access_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."access_roles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."access_user_roles"
    ADD CONSTRAINT "access_user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cashier_transactions"
    ADD CONSTRAINT "cashier_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."cashier_transactions"
    ADD CONSTRAINT "cashier_transactions_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id");



ALTER TABLE ONLY "public"."cashier_transactions"
    ADD CONSTRAINT "cashier_transactions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."cashier_transactions"
    ADD CONSTRAINT "cashier_transactions_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."dossiers"
    ADD CONSTRAINT "dossiers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."dossiers"
    ADD CONSTRAINT "dossiers_prospect_id_fkey" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."journal_entries"
    ADD CONSTRAINT "journal_entries_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."journal_piece_counters"
    ADD CONSTRAINT "journal_piece_counters_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."journals"
    ADD CONSTRAINT "journals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."prospects"
    ADD CONSTRAINT "prospects_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."prospects"
    ADD CONSTRAINT "prospects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



CREATE POLICY "Acces complet admin service_role" ON "public"."profiles" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."access_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "access_audit_log_service_role_all" ON "public"."access_audit_log" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."access_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "access_permissions_service_role_all" ON "public"."access_permissions" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."access_role_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "access_role_permissions_service_role_all" ON "public"."access_role_permissions" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."access_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "access_roles_service_role_all" ON "public"."access_roles" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."access_user_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "access_user_overrides_service_role_all" ON "public"."access_user_overrides" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."access_user_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "access_user_roles_service_role_all" ON "public"."access_user_roles" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_logs_admin_select" ON "public"."audit_logs" FOR SELECT TO "authenticated" USING ("private"."is_admin"());



CREATE POLICY "audit_logs_service_role_all" ON "public"."audit_logs" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."cashier_piece_counters" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cashier_piece_counters_service_role" ON "public"."cashier_piece_counters" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."cashier_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cashier_transactions_delete_own_or_admin" ON "public"."cashier_transactions" FOR DELETE TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR ((COALESCE("created_by", "employee_id") = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum"])))))))));



CREATE POLICY "cashier_transactions_insert_by_role" ON "public"."cashier_transactions" FOR INSERT TO "authenticated" WITH CHECK (("private"."is_active_user"() AND ("private"."is_admin"() OR (("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (("employee_id" IS NULL) OR ("employee_id" = ( SELECT "auth"."uid"() AS "uid"))) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum"])))))))));



CREATE POLICY "cashier_transactions_select_by_role" ON "public"."cashier_transactions" FOR SELECT TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum", 'manager'::"public"."user_role_enum", 'comptable'::"public"."user_role_enum", 'tresorier'::"public"."user_role_enum"]))))))));



CREATE POLICY "cashier_transactions_update_own_or_admin" ON "public"."cashier_transactions" FOR UPDATE TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR ((COALESCE("created_by", "employee_id") = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum"]))))))))) WITH CHECK (("private"."is_active_user"() AND ("private"."is_admin"() OR (("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (("employee_id" IS NULL) OR ("employee_id" = ( SELECT "auth"."uid"() AS "uid"))) AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum"])))))))));



ALTER TABLE "public"."dossiers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dossiers_delete_admin_only" ON "public"."dossiers" FOR DELETE TO "authenticated" USING (("private"."is_active_user"() AND "private"."is_admin"()));



CREATE POLICY "dossiers_insert_by_role" ON "public"."dossiers" FOR INSERT TO "authenticated" WITH CHECK (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum", 'manager'::"public"."user_role_enum"]))))))));



CREATE POLICY "dossiers_select_by_role" ON "public"."dossiers" FOR SELECT TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum", 'manager'::"public"."user_role_enum", 'tresorier'::"public"."user_role_enum", 'comptable'::"public"."user_role_enum", 'rh'::"public"."user_role_enum"]))))) OR ("created_by" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "dossiers_update_by_role" ON "public"."dossiers" FOR UPDATE TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum", 'manager'::"public"."user_role_enum"])))))))) WITH CHECK (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['caissier'::"public"."user_role_enum", 'caissiere'::"public"."user_role_enum", 'manager'::"public"."user_role_enum"]))))))));



ALTER TABLE "public"."journal_entries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "journal_entries_delete_by_role" ON "public"."journal_entries" FOR DELETE TO "authenticated" USING (("private"."is_active_user"() AND (EXISTS ( SELECT 1
   FROM "public"."journals" "j"
  WHERE (("j"."id" = "journal_entries"."journal_id") AND (("j"."sequence_prefix")::"text" <> 'CSH1'::"text") AND ("private"."is_admin"() OR (("j"."created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = 'tresorier'::"public"."user_role_enum")))))))))));



CREATE POLICY "journal_entries_insert_by_role" ON "public"."journal_entries" FOR INSERT TO "authenticated" WITH CHECK (("private"."is_active_user"() AND ("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."journals" "j"
  WHERE (("j"."id" = "journal_entries"."journal_id") AND (("j"."sequence_prefix")::"text" <> 'CSH1'::"text") AND ("private"."is_admin"() OR (("j"."created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = 'tresorier'::"public"."user_role_enum")))))))))));



CREATE POLICY "journal_entries_select_by_role" ON "public"."journal_entries" FOR SELECT TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['tresorier'::"public"."user_role_enum", 'manager'::"public"."user_role_enum"]))))))));



CREATE POLICY "journal_entries_service_role_all" ON "public"."journal_entries" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "journal_entries_update_by_role" ON "public"."journal_entries" FOR UPDATE TO "authenticated" USING (("private"."is_active_user"() AND (EXISTS ( SELECT 1
   FROM "public"."journals" "j"
  WHERE (("j"."id" = "journal_entries"."journal_id") AND (("j"."sequence_prefix")::"text" <> 'CSH1'::"text") AND ("private"."is_admin"() OR (("j"."created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = 'tresorier'::"public"."user_role_enum"))))))))))) WITH CHECK (("private"."is_active_user"() AND (EXISTS ( SELECT 1
   FROM "public"."journals" "j"
  WHERE (("j"."id" = "journal_entries"."journal_id") AND (("j"."sequence_prefix")::"text" <> 'CSH1'::"text") AND ("private"."is_admin"() OR (("j"."created_by" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = 'tresorier'::"public"."user_role_enum")))))))))));



ALTER TABLE "public"."journal_piece_counters" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "journal_piece_counters_service_role" ON "public"."journal_piece_counters" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."journals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "journals_delete_admin" ON "public"."journals" FOR DELETE TO "authenticated" USING (("private"."is_active_user"() AND "private"."is_admin"() AND (("sequence_prefix")::"text" <> 'CSH1'::"text")));



CREATE POLICY "journals_insert_management" ON "public"."journals" FOR INSERT TO "authenticated" WITH CHECK (("private"."is_active_user"() AND ("created_by" = ( SELECT "auth"."uid"() AS "uid")) AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = 'tresorier'::"public"."user_role_enum")))))));



CREATE POLICY "journals_select_authenticated" ON "public"."journals" FOR SELECT TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = ANY (ARRAY['tresorier'::"public"."user_role_enum", 'manager'::"public"."user_role_enum"]))))))));



CREATE POLICY "journals_update_management" ON "public"."journals" FOR UPDATE TO "authenticated" USING (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = 'tresorier'::"public"."user_role_enum"))))))) WITH CHECK (("private"."is_active_user"() AND ("private"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."is_active" IS TRUE) AND ("p"."role" = 'tresorier'::"public"."user_role_enum")))))));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert_policy" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (("private"."is_admin"() OR (("id" = ( SELECT "auth"."uid"() AS "uid")) AND ("role" = 'employe'::"public"."user_role_enum"))));



CREATE POLICY "profiles_select_policy" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("private"."is_active_user"() AND (("id" = ( SELECT "auth"."uid"() AS "uid")) OR "private"."is_admin"())));



CREATE POLICY "profiles_update_policy" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("private"."is_active_user"() AND (("id" = ( SELECT "auth"."uid"() AS "uid")) OR "private"."is_admin"()))) WITH CHECK (("private"."is_active_user"() AND ("private"."is_admin"() OR (("id" = ( SELECT "auth"."uid"() AS "uid")) AND ("role" = ( SELECT "p"."role"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = ( SELECT "auth"."uid"() AS "uid")))) AND ("is_active" = ( SELECT "p"."is_active"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = ( SELECT "auth"."uid"() AS "uid"))))))));



ALTER TABLE "public"."prospects" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "prospects_service_role_all" ON "public"."prospects" TO "service_role" USING (true) WITH CHECK (true);



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."access_control_mutate"("p_actor_user_id" "uuid", "p_operation" "text", "p_payload" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."access_control_mutate"("p_actor_user_id" "uuid", "p_operation" "text", "p_payload" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."assign_cashier_journal_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."assign_piece_comptable_on_post"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assign_piece_comptable_on_post"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_short_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_short_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_short_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_cashier_summary"("p_journal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_cashier_summary"("p_journal_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_journal_summary"("p_journal_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_journal_summary"("p_journal_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."provision_collaborator"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_email" "text", "p_first_name" "text", "p_last_name" "text", "p_role_key" "text", "p_department" "text", "p_phone" "text", "p_must_change_password" boolean, "p_is_active" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."provision_collaborator"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_email" "text", "p_first_name" "text", "p_last_name" "text", "p_role_key" "text", "p_department" "text", "p_phone" "text", "p_must_change_password" boolean, "p_is_active" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_user_primary_role"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_role_key" "text", "p_exclusive" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_user_primary_role"("p_actor_user_id" "uuid", "p_user_id" "uuid", "p_role_key" "text", "p_exclusive" boolean) TO "service_role";



GRANT ALL ON TABLE "public"."access_audit_log" TO "service_role";



GRANT ALL ON SEQUENCE "public"."access_audit_log_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."access_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."access_role_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."access_roles" TO "service_role";



GRANT ALL ON TABLE "public"."access_user_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."access_user_roles" TO "service_role";



GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";
GRANT SELECT ON TABLE "public"."audit_logs" TO "authenticated";



GRANT ALL ON TABLE "public"."cashier_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."cashier_balance_summary" TO "service_role";
GRANT SELECT ON TABLE "public"."cashier_balance_summary" TO "authenticated";



GRANT ALL ON TABLE "public"."cashier_piece_counters" TO "service_role";



GRANT ALL ON TABLE "public"."cashier_transactions_with_balance" TO "service_role";
GRANT SELECT ON TABLE "public"."cashier_transactions_with_balance" TO "authenticated";



GRANT ALL ON TABLE "public"."dossiers" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."dossiers" TO "authenticated";



GRANT ALL ON TABLE "public"."journal_entries" TO "service_role";



GRANT ALL ON TABLE "public"."journal_piece_counters" TO "service_role";



GRANT ALL ON TABLE "public"."journals" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."journals" TO "authenticated";



GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."prospects" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







