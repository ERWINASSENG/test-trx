BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dossiers_assigned_to
  ON public.dossiers (assigned_to)
  WHERE assigned_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notification_type text NOT NULL
    CHECK (notification_type IN ('assignment', 'reminder')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  message text NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 1000),
  href text NOT NULL CHECK (left(href, 1) = '/' AND left(href, 2) <> '//'),
  source_type text NOT NULL
    CHECK (source_type IN ('prospect', 'quote', 'dossier', 'sales_activity')),
  source_id uuid NOT NULL,
  dedupe_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_notifications_recipient_dedupe_unique
    UNIQUE (recipient_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_app_notifications_recipient_created
  ON public.app_notifications (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_notifications_unread
  ON public.app_notifications (recipient_id, created_at DESC)
  WHERE read_at IS NULL;

ALTER TABLE public.app_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.app_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.app_notifications TO service_role;

DROP POLICY IF EXISTS app_notifications_service_role_all ON public.app_notifications;
CREATE POLICY app_notifications_service_role_all ON public.app_notifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.enqueue_sales_activity_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  inserted_count integer;
BEGIN
  WITH due_reminders AS (
    SELECT
      a.assigned_to AS recipient_id,
      a.created_by AS actor_id,
      a.id AS source_id,
      'sales_activity'::text AS source_type,
      'reminder'::text AS notification_type,
      'Relance à venir'::text AS title,
      format('« %s » arrive à échéance dans 24 heures.', a.title) AS message,
      '/crm-commercial?view=activities&activityId=' || a.id::text AS href,
      'sales-activity:' || a.id::text || ':24h' AS dedupe_key
    FROM public.sales_activities AS a
    WHERE a.status = 'pending'
      AND a.assigned_to IS NOT NULL
      AND a.due_at > now() + interval '23 hours 30 minutes'
      AND a.due_at <= now() + interval '24 hours'

    UNION ALL

    SELECT
      a.assigned_to,
      a.created_by,
      a.id,
      'sales_activity'::text,
      'reminder'::text,
      'Relance à effectuer'::text,
      format('« %s » arrive à échéance.', a.title),
      '/crm-commercial?view=activities&activityId=' || a.id::text,
      'sales-activity:' || a.id::text || ':due'
    FROM public.sales_activities AS a
    WHERE a.status = 'pending'
      AND a.assigned_to IS NOT NULL
      AND a.due_at > now() - interval '30 minutes'
      AND a.due_at <= now()
  )
  INSERT INTO public.app_notifications (
    recipient_id, actor_id, notification_type, title, message, href,
    source_type, source_id, dedupe_key
  )
  SELECT
    recipient_id, actor_id, notification_type, title, message, href,
    source_type, source_id, dedupe_key
  FROM due_reminders
  ON CONFLICT (recipient_id, dedupe_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.enqueue_sales_activity_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_sales_activity_reminders() TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

DO $schedule$
BEGIN
  PERFORM cron.schedule(
    'enqueue-sales-activity-reminders',
    '*/15 * * * *',
    'SELECT public.enqueue_sales_activity_reminders();'
  );
END;
$schedule$;

COMMIT;
