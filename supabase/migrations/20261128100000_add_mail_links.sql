-- =============================================================================
-- Migration : Module Messagerie Phase 3 — Table de liaison email <-> ERP
-- Date : 2026-11-28
-- Description :
--   1. Crée public.mail_links pour relier de façon idempotente un email IMAP
--      à une entité ERP (cotation sales_quotes) sans stocker le corps du mail.
--   2. Ajoute les index uniques anti-doublon (account_id + folder + imap_uid
--      et account_id + internet_message_id).
--   3. Active la RLS stricte service_role uniquement.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.mail_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.mail_inbox_accounts(id) ON DELETE CASCADE,
  internet_message_id text NULL CHECK (internet_message_id IS NULL OR char_length(internet_message_id) <= 255),
  folder text NOT NULL CHECK (char_length(folder) BETWEEN 1 AND 128),
  imap_uid bigint NOT NULL CHECK (imap_uid > 0),
  entity_type text NOT NULL CHECK (entity_type IN ('quote')),
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, folder, imap_uid, entity_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_links_account_msg_entity
  ON public.mail_links (account_id, internet_message_id, entity_type)
  WHERE internet_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mail_links_entity
  ON public.mail_links (entity_type, entity_id);

ALTER TABLE public.mail_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mail_links FROM PUBLIC, anon, authenticated;

COMMIT;
