-- =============================================================================
-- Migration : Connecteur Outlook IMAP/SMTP en libre-service (Lot 2)
-- Date : 2026-11-25
-- Description :
--   1. Ajoute la permission mail.self.connect attribuée UNIQUEMENT à admin.
--   2. Crée public.mail_global_settings (serveur IMAP/SMTP global + filtres).
--   3. Crée public.mail_inbox_accounts (1 boîte chiffrée AES-256-GCM par user).
--   4. Crée public.mail_ingested_messages (déduplication UID + suivi \Seen).
--   5. Ajoute les colonnes de référence email sur public.sales_quotes.
--   6. Active la RLS stricte service_role uniquement sur toutes les tables mail_*.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Permission RBAC mail.self.connect (accordée UNIQUEMENT à admin par défaut)
-- -----------------------------------------------------------------------------
INSERT INTO public.access_permissions (
  permission_key,
  resource_key,
  action_key,
  label,
  description,
  is_sensitive
)
VALUES (
  'mail.self.connect',
  'mail.self',
  'connect',
  'Connecter sa boîte mail Outlook (Cotations)',
  'Connecter sa boîte mail professionnelle IMAP dans Mon Profil pour synchroniser les demandes de cotation.',
  true
)
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT r.id,
       'mail.self.connect',
       '{"type":"all","version":1}'::jsonb,
       CAST(NULL AS uuid)
FROM public.access_roles r
WHERE r.role_key = 'admin'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Paramètres globaux IMAP/SMTP de l'entreprise
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mail_global_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  imap_host text NOT NULL DEFAULT '',
  imap_port integer NOT NULL DEFAULT 993 CHECK (imap_port BETWEEN 1 AND 65535),
  imap_tls boolean NOT NULL DEFAULT true,
  smtp_host text NOT NULL DEFAULT '',
  smtp_port integer NOT NULL DEFAULT 465 CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_tls boolean NOT NULL DEFAULT true,
  watched_folder text NOT NULL DEFAULT 'INBOX' CHECK (char_length(watched_folder) BETWEEN 1 AND 128),
  subject_keywords text[] NOT NULL DEFAULT ARRAY[
    'cotation',
    'devis',
    'rfq',
    'tarif',
    'fret',
    'quotation',
    'quote',
    'conteneur',
    'fcl',
    'lcl',
    'dédouanement',
    'transit'
  ]::text[],
  excluded_senders text[] NOT NULL DEFAULT ARRAY[
    'noreply@',
    'no-reply@',
    'newsletter@'
  ]::text[],
  is_enabled boolean NOT NULL DEFAULT true,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.mail_global_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Boîtes mail connectées en libre-service (1 max par utilisateur)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mail_inbox_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  email_address text NOT NULL CHECK (char_length(email_address) BETWEEN 3 AND 254),
  account_role text NOT NULL DEFAULT 'commercial' CHECK (account_role IN ('manager', 'commercial')),
  encrypted_password text NOT NULL,
  last_synced_uid bigint NOT NULL DEFAULT 0 CHECK (last_synced_uid >= 0),
  last_synced_at timestamptz NULL,
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_inbox_accounts_email_lower
  ON public.mail_inbox_accounts (lower(email_address));

-- -----------------------------------------------------------------------------
-- 4. Journal de déduplication IMAP & détection du flag \Seen
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mail_ingested_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.mail_inbox_accounts(id) ON DELETE CASCADE,
  imap_uid bigint NOT NULL CHECK (imap_uid >= 0),
  internet_message_id text NULL,
  in_reply_to text NULL,
  quote_id uuid NULL REFERENCES public.sales_quotes(id) ON DELETE SET NULL,
  sender_email text NULL,
  subject text NULL,
  status text NOT NULL DEFAULT 'ingested' CHECK (status IN ('ingested', 'reply_linked', 'ignored')),
  is_seen_in_outlook boolean NOT NULL DEFAULT false,
  seen_detected_at timestamptz NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, imap_uid)
);

CREATE INDEX IF NOT EXISTS idx_mail_ingested_messages_msg_id
  ON public.mail_ingested_messages (internet_message_id)
  WHERE internet_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mail_ingested_messages_unseen
  ON public.mail_ingested_messages (account_id, is_seen_in_outlook)
  WHERE status = 'ingested' AND is_seen_in_outlook IS FALSE;

-- -----------------------------------------------------------------------------
-- 5. Colonnes de référence email sur public.sales_quotes
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS source_mailbox_account_id uuid NULL REFERENCES public.mail_inbox_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_email_sender text NULL,
  ADD COLUMN IF NOT EXISTS source_email_subject text NULL,
  ADD COLUMN IF NOT EXISTS source_email_body_text text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_quotes_source_email_sender_len_check'
  ) THEN
    ALTER TABLE public.sales_quotes
      ADD CONSTRAINT sales_quotes_source_email_sender_len_check
      CHECK (source_email_sender IS NULL OR char_length(source_email_sender) <= 320);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_quotes_source_email_subject_len_check'
  ) THEN
    ALTER TABLE public.sales_quotes
      ADD CONSTRAINT sales_quotes_source_email_subject_len_check
      CHECK (source_email_subject IS NULL OR char_length(source_email_subject) <= 500);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_quotes_source_email_body_len_check'
  ) THEN
    ALTER TABLE public.sales_quotes
      ADD CONSTRAINT sales_quotes_source_email_body_len_check
      CHECK (source_email_body_text IS NULL OR char_length(source_email_body_text) <= 10000);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 6. Row Level Security stricte (service_role uniquement — S1 & S2)
-- -----------------------------------------------------------------------------
ALTER TABLE public.mail_global_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_inbox_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mail_ingested_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mail_global_settings_service_role_all ON public.mail_global_settings;
CREATE POLICY mail_global_settings_service_role_all ON public.mail_global_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS mail_inbox_accounts_service_role_all ON public.mail_inbox_accounts;
CREATE POLICY mail_inbox_accounts_service_role_all ON public.mail_inbox_accounts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS mail_ingested_messages_service_role_all ON public.mail_ingested_messages;
CREATE POLICY mail_ingested_messages_service_role_all ON public.mail_ingested_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
