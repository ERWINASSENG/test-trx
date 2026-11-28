-- =============================================================================
-- Migration : Suivi des mails clients transférés Manager -> Commercial
-- Date : 2026-11-28
-- Description :
--   1. Crée public.mail_assignments pour tracer un mail transféré par un manager
--      à un commercial (sans créer ni prospect ni cotation automatiquement).
--   2. Stocke uniquement les métadonnées (jamais le corps complet du mail).
--   3. Active la RLS stricte service_role uniquement (accès backend RBAC).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.mail_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_to uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES public.mail_inbox_accounts(id) ON DELETE CASCADE,
  assigned_mailbox_account_id uuid NULL REFERENCES public.mail_inbox_accounts(id) ON DELETE SET NULL,
  source_internet_message_id text NULL CHECK (
    source_internet_message_id IS NULL OR char_length(source_internet_message_id) <= 255
  ),
  forwarded_message_id text NOT NULL CHECK (char_length(forwarded_message_id) BETWEEN 3 AND 255),
  assigned_imap_uid bigint NULL CHECK (assigned_imap_uid IS NULL OR assigned_imap_uid > 0),
  client_email text NOT NULL CHECK (char_length(client_email) BETWEEN 3 AND 254),
  client_name text NULL CHECK (client_name IS NULL OR char_length(client_name) <= 160),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  manager_note text NULL CHECK (manager_note IS NULL OR char_length(manager_note) <= 1000),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'opened', 'quote_created')),
  forwarded_at timestamptz NOT NULL DEFAULT now(),
  opened_at timestamptz NULL,
  opened_channel text NULL CHECK (opened_channel IS NULL OR opened_channel IN ('webmail', 'imap_seen')),
  quote_id uuid NULL REFERENCES public.sales_quotes(id) ON DELETE SET NULL,
  quote_created_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assigned_to, forwarded_message_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_assignments_forwarded_at
  ON public.mail_assignments (forwarded_at DESC);

CREATE INDEX IF NOT EXISTS idx_mail_assignments_assigned_unopened
  ON public.mail_assignments (assigned_to, forwarded_at DESC)
  WHERE opened_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mail_assignments_manager
  ON public.mail_assignments (manager_user_id, forwarded_at DESC);

CREATE INDEX IF NOT EXISTS idx_mail_assignments_quote_id
  ON public.mail_assignments (quote_id)
  WHERE quote_id IS NOT NULL;

ALTER TABLE public.mail_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mail_assignments FROM PUBLIC, anon, authenticated;

COMMIT;
