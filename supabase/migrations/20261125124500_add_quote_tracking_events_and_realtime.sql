-- =============================================================================
-- Migration : Suivi temps réel des cotations, ouverture, timeline & blocages
-- Date : 2026-11-25
-- Description :
--   1. Ajoute les colonnes de canal source, ouverture (Outlook & plateforme)
--      et blocage sur public.sales_quotes avec contraintes CHECK strictes.
--   2. Crée public.sales_quote_events pour la timeline complète de chaque cotation.
--   3. Active la RLS stricte (lecture filtrée par appartenance ou quotes.timing.read,
--      mutations réservées à service_role).
--   4. Inscrit sales_quotes et sales_quote_events à la publication supabase_realtime.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Enrichissement de public.sales_quotes
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS outlook_read_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS first_opened_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS blocked_category text NULL,
  ADD COLUMN IF NOT EXISTS blocked_reason text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_quotes_source_channel_check'
  ) THEN
    ALTER TABLE public.sales_quotes
      ADD CONSTRAINT sales_quotes_source_channel_check
      CHECK (source_channel IN ('manual', 'outlook_imap'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_quotes_blocked_category_check'
  ) THEN
    ALTER TABLE public.sales_quotes
      ADD CONSTRAINT sales_quotes_blocked_category_check
      CHECK (
        blocked_category IS NULL OR blocked_category IN (
          'waiting_carrier',
          'missing_client_info',
          'pricing_approval',
          'technical_issue',
          'other'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_quotes_blocked_reason_length_check'
  ) THEN
    ALTER TABLE public.sales_quotes
      ADD CONSTRAINT sales_quotes_blocked_reason_length_check
      CHECK (blocked_reason IS NULL OR char_length(blocked_reason) <= 500);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Table d'événements chronologiques public.sales_quote_events
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_quote_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.sales_quotes(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN (
      'created',
      'email_received',
      'assigned',
      'email_seen_in_outlook',
      'opened_by_rep',
      'status_changed',
      'blocked',
      'unblocked',
      'sent_to_client',
      'client_replied'
    )
  ),
  actor_user_id uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_quote_events_quote_created
  ON public.sales_quote_events (quote_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3. Row Level Security (S1 & S9)
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales_quote_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_quote_events_service_role_all ON public.sales_quote_events;
CREATE POLICY sales_quote_events_service_role_all ON public.sales_quote_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS sales_quote_events_select_authorized ON public.sales_quote_events;
CREATE POLICY sales_quote_events_select_authorized ON public.sales_quote_events
  FOR SELECT
  TO authenticated
  USING (
    private.is_active_user()
    AND (
      private.is_admin()
      OR private.has_permission('quotes.timing.read')
      OR EXISTS (
        SELECT 1
        FROM public.sales_quotes q
        WHERE q.id = sales_quote_events.quote_id
          AND (
            q.assigned_to = (SELECT auth.uid())
            OR q.created_by = (SELECT auth.uid())
          )
      )
    )
  );

DROP POLICY IF EXISTS sales_quotes_select_realtime_authorized ON public.sales_quotes;
CREATE POLICY sales_quotes_select_realtime_authorized ON public.sales_quotes
  FOR SELECT
  TO authenticated
  USING (
    private.is_active_user()
    AND (
      private.is_admin()
      OR private.has_permission('quotes.timing.read')
      OR assigned_to = (SELECT auth.uid())
      OR created_by = (SELECT auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Publication Supabase Realtime (soumise à la RLS ci-dessus)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'sales_quotes'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sales_quotes;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'sales_quote_events'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.sales_quote_events;
    END IF;
  END IF;
END $$;

COMMIT;
