-- =============================================================================
-- Migration : Module Messagerie Phase 2 — Journal d'audit des envois SMTP
-- Date : 2026-11-28
-- Description :
--   1. Crée public.mail_send_log (métadonnées d'envoi uniquement : aucun corps
--      d'email ni liste brute de destinataires stockés).
--   2. Ajoute les contraintes CHECK (recipient_count 1..50, longueurs bornées,
--      statut sent/failed) et un index (user_id, created_at DESC).
--   3. Active la RLS stricte service_role uniquement (aucun accès client direct).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.mail_send_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  account_id uuid NULL REFERENCES public.mail_inbox_accounts(id) ON DELETE SET NULL,
  recipient_count integer NOT NULL CHECK (recipient_count BETWEEN 1 AND 50),
  subject_preview text NOT NULL DEFAULT '' CHECK (char_length(subject_preview) <= 160),
  smtp_message_id text NULL CHECK (smtp_message_id IS NULL OR char_length(smtp_message_id) <= 255),
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  sent_folder_appended boolean NOT NULL DEFAULT false,
  error_code text NULL CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mail_send_log_user_created
  ON public.mail_send_log (user_id, created_at DESC);

ALTER TABLE public.mail_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mail_send_log FROM PUBLIC, anon, authenticated;

COMMIT;
