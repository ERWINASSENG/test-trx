-- =============================================================================
-- Migration : Permissions granulaires Comptabilité, Caisse & Édition
-- Date : 2026-11-17
-- Description :
--   1. Ajoute 8 nouvelles permissions granulaires dans public.access_permissions
--      (module.edition.view, cashier.daily_report.export, cashier.balance.read,
--      cashier.post, cashier.cancel, cashier.reset_draft, cashier.posted.update,
--      cashier.attachments.download).
--   2. Retire cashier.delete du rôle caissiere par défaut.
--   3. Attribue les permissions par défaut validées aux rôles existants
--      (admin, caissiere, manager, tresorier).
--   4. Ajoute private.has_permission(text) et aligne la policy RLS DELETE de
--      public.cashier_transactions sur la permission cashier.delete.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Insertion des 8 nouvelles permissions dans le catalogue access_permissions
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
    'module.edition.view',
    'module.edition',
    'view',
    'Voir le menu Édition (Rapport de caisse)',
    'Afficher le menu Édition → Rapport dans la barre supérieure et accéder à la page /edition/rapport.',
    false
  ),
  (
    'cashier.daily_report.export',
    'cashier.daily_report',
    'export',
    'Prévisualiser et exporter le rapport journalier de caisse',
    'Générer l’aperçu et télécharger le rapport journalier officiel CAISSE TRX en PDF (.pdf) et Excel (.xlsx).',
    true
  ),
  (
    'cashier.balance.read',
    'cashier.balance',
    'read',
    'Consulter le solde de caisse',
    'Afficher le Solde Actuel, la colonne Solde courant de la caisse et les soldes dans les exports.',
    true
  ),
  (
    'cashier.post',
    'cashier',
    'post',
    'Comptabiliser en caisse',
    'Valider et comptabiliser les opérations de caisse en brouillon (attribution de pièce comptable).',
    true
  ),
  (
    'cashier.cancel',
    'cashier',
    'cancel',
    'Annuler en caisse',
    'Annuler des opérations du journal de caisse.',
    true
  ),
  (
    'cashier.reset_draft',
    'cashier',
    'reset_draft',
    'Remettre en brouillon en caisse',
    'Remettre en brouillon des opérations de caisse (comptabilisées ou annulées).',
    true
  ),
  (
    'cashier.posted.update',
    'cashier.posted',
    'update',
    'Modifier une opération comptabilisée en caisse',
    'Modifier directement une écriture de caisse ayant déjà le statut Comptabilisé.',
    true
  ),
  (
    'cashier.attachments.download',
    'cashier.attachments',
    'download',
    'Télécharger les pièces jointes de caisse',
    'Télécharger le bordereau récapitulatif des pièces comptables de caisse.',
    true
  )
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

-- -----------------------------------------------------------------------------
-- 2. Retrait de cashier.delete du rôle caissiere par défaut
-- -----------------------------------------------------------------------------
DELETE FROM public.access_role_permissions rp
USING public.access_roles r
WHERE rp.role_id = r.id
  AND r.role_key = 'caissiere'
  AND rp.permission_key = 'cashier.delete';

-- -----------------------------------------------------------------------------
-- 3. Attribution par défaut des nouvelles permissions aux rôles existants
-- -----------------------------------------------------------------------------
WITH default_role_grants (role_key, permission_key) AS (
  VALUES
    -- Administrateur : les 8 nouvelles permissions
    ('admin', 'module.edition.view'),
    ('admin', 'cashier.daily_report.export'),
    ('admin', 'cashier.balance.read'),
    ('admin', 'cashier.post'),
    ('admin', 'cashier.cancel'),
    ('admin', 'cashier.reset_draft'),
    ('admin', 'cashier.posted.update'),
    ('admin', 'cashier.attachments.download'),
    -- Caissière : édition rapport, solde, comptabiliser, annuler, pièces jointes
    ('caissiere', 'module.edition.view'),
    ('caissiere', 'cashier.daily_report.export'),
    ('caissiere', 'cashier.balance.read'),
    ('caissiere', 'cashier.post'),
    ('caissiere', 'cashier.cancel'),
    ('caissiere', 'cashier.attachments.download'),
    -- Manager et Trésorier : lecture du solde de caisse
    ('manager', 'cashier.balance.read'),
    ('tresorier', 'cashier.balance.read')
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT r.id,
       g.permission_key,
       '{"type":"all","version":1}'::jsonb,
       CAST(NULL AS uuid)
FROM default_role_grants g
JOIN public.access_roles r ON r.role_key = g.role_key
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Fonction helper RBAC sécurisée pour RLS : private.has_permission(text)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.has_permission(p_permission_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
BEGIN
  IF v_user_id IS NULL OR p_permission_key IS NULL OR btrim(p_permission_key) = '' THEN
    RETURN false;
  END IF;

  IF NOT private.is_active_user() THEN
    RETURN false;
  END IF;

  IF private.is_admin() THEN
    RETURN true;
  END IF;

  -- Priorité absolue au refus individuel explicite (deny)
  IF EXISTS (
    SELECT 1
    FROM public.access_user_overrides uo
    WHERE uo.user_id = v_user_id
      AND uo.permission_key = p_permission_key
      AND uo.effect = 'deny'
      AND uo.scope->>'type' = 'all'
      AND (uo.expires_at IS NULL OR uo.expires_at > now())
  ) THEN
    RETURN false;
  END IF;

  -- Autorisation individuelle explicite (allow)
  IF EXISTS (
    SELECT 1
    FROM public.access_user_overrides uo
    WHERE uo.user_id = v_user_id
      AND uo.permission_key = p_permission_key
      AND uo.effect = 'allow'
      AND uo.scope->>'type' = 'all'
      AND (uo.expires_at IS NULL OR uo.expires_at > now())
  ) THEN
    RETURN true;
  END IF;

  -- Autorisation via rôle actif attribué
  RETURN EXISTS (
    SELECT 1
    FROM public.access_user_roles ur
    JOIN public.access_roles r ON r.id = ur.role_id AND r.is_active IS TRUE
    JOIN public.access_role_permissions rp ON rp.role_id = r.id
    WHERE ur.user_id = v_user_id
      AND (ur.expires_at IS NULL OR ur.expires_at > now())
      AND rp.permission_key = p_permission_key
      AND rp.scope->>'type' = 'all'
  );
END;
$$;

REVOKE ALL ON FUNCTION private.has_permission(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.has_permission(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Alignement de la policy RLS DELETE de cashier_transactions sur cashier.delete
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS cashier_transactions_delete_admin_only ON public.cashier_transactions;
DROP POLICY IF EXISTS cashier_transactions_delete_authorized ON public.cashier_transactions;

CREATE POLICY cashier_transactions_delete_authorized ON public.cashier_transactions
  FOR DELETE
  USING (
    private.is_active_user()
    AND (private.is_admin() OR private.has_permission('cashier.delete'))
  );

COMMIT;
