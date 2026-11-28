-- =============================================================================
-- Migration : Module Messagerie intégré — Permissions RBAC & colonnes boîte mail
-- Date : 2026-11-27
-- Description :
--   1. Ajoute les permissions RBAC module.mail.view, mail.read et mail.send,
--      attribuées UNIQUEMENT au rôle admin par défaut (refus par défaut).
--   2. Étend public.mail_inbox_accounts avec provider, display_name,
--      signature_text, sent_folder, drafts_folder et trash_folder.
--   3. Confirme le maintien de la RLS stricte (service_role uniquement) sur
--      public.mail_inbox_accounts.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Permissions RBAC Messagerie (accordées UNIQUEMENT à admin par défaut)
-- -----------------------------------------------------------------------------
INSERT INTO public.access_permissions (
  permission_key,
  resource_key,
  action_key,
  label,
  description,
  is_sensitive
)
VALUES
  (
    'module.mail.view',
    'module.mail',
    'view',
    'Accéder au module Messagerie',
    'Affiche la tuile Messagerie dans le lanceur d’applications et autorise l’accès à la page /mail.',
    false
  ),
  (
    'mail.read',
    'mail',
    'read',
    'Consulter sa boîte mail intégrée',
    'Autorise la lecture en direct (IMAP) des dossiers et messages de sa propre boîte mail connectée.',
    true
  ),
  (
    'mail.send',
    'mail',
    'send',
    'Envoyer des emails depuis la messagerie',
    'Autorise l’envoi et la réponse aux emails via SMTP depuis sa propre boîte mail connectée.',
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
       p.permission_key,
       '{"type":"all","version":1}'::jsonb,
       CAST(NULL AS uuid)
FROM public.access_roles r
CROSS JOIN (
  VALUES
    ('module.mail.view'),
    ('mail.read'),
    ('mail.send')
) AS p(permission_key)
WHERE r.role_key = 'admin'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Colonnes webmail sur public.mail_inbox_accounts
-- -----------------------------------------------------------------------------
ALTER TABLE public.mail_inbox_accounts
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'imap',
  ADD COLUMN IF NOT EXISTS display_name text NULL,
  ADD COLUMN IF NOT EXISTS signature_text text NULL,
  ADD COLUMN IF NOT EXISTS sent_folder text NULL,
  ADD COLUMN IF NOT EXISTS drafts_folder text NULL,
  ADD COLUMN IF NOT EXISTS trash_folder text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_accounts_provider_check'
  ) THEN
    ALTER TABLE public.mail_inbox_accounts
      ADD CONSTRAINT mail_inbox_accounts_provider_check
      CHECK (provider IN ('imap'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_accounts_display_name_len_check'
  ) THEN
    ALTER TABLE public.mail_inbox_accounts
      ADD CONSTRAINT mail_inbox_accounts_display_name_len_check
      CHECK (display_name IS NULL OR char_length(display_name) <= 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_accounts_signature_text_len_check'
  ) THEN
    ALTER TABLE public.mail_inbox_accounts
      ADD CONSTRAINT mail_inbox_accounts_signature_text_len_check
      CHECK (signature_text IS NULL OR char_length(signature_text) <= 2000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mail_inbox_accounts_folder_names_len_check'
  ) THEN
    ALTER TABLE public.mail_inbox_accounts
      ADD CONSTRAINT mail_inbox_accounts_folder_names_len_check
      CHECK (
        (sent_folder IS NULL OR char_length(sent_folder) BETWEEN 1 AND 128)
        AND (drafts_folder IS NULL OR char_length(drafts_folder) BETWEEN 1 AND 128)
        AND (trash_folder IS NULL OR char_length(trash_folder) BETWEEN 1 AND 128)
      );
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Sécurité RLS (défense en profondeur : accès service_role uniquement)
-- -----------------------------------------------------------------------------
ALTER TABLE public.mail_inbox_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mail_inbox_accounts FROM PUBLIC, anon, authenticated;

COMMIT;
