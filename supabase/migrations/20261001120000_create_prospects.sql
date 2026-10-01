-- Module Prospects: schema, least-privilege grants, RLS and initial permissions.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  company_name text CHECK (company_name IS NULL OR length(btrim(company_name)) <= 200),
  contact_name text CHECK (contact_name IS NULL OR length(btrim(contact_name)) <= 200),
  email text CHECK (email IS NULL OR length(btrim(email)) <= 320),
  phone text CHECK (phone IS NULL OR length(btrim(phone)) <= 40),
  source text CHECK (source IS NULL OR length(btrim(source)) <= 100),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  estimated_value numeric(14,2) CHECK (estimated_value IS NULL OR estimated_value >= 0),
  currency varchar(3) NOT NULL DEFAULT 'XAF' CHECK (currency ~ '^[A-Z]{3}$'),
  next_follow_up date,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_prospects_status_created ON public.prospects (status, created_at DESC);
CREATE INDEX idx_prospects_assigned_to ON public.prospects (assigned_to);
CREATE INDEX idx_prospects_follow_up ON public.prospects (next_follow_up) WHERE next_follow_up IS NOT NULL;
CREATE INDEX idx_prospects_created_by ON public.prospects (created_by);
CREATE INDEX idx_prospects_email_lower ON public.prospects (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.prospects FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.prospects TO service_role;

CREATE POLICY prospects_service_role_all ON public.prospects
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER trg_prospects_updated_at
  BEFORE UPDATE ON public.prospects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.access_permissions (
  permission_key, resource_key, action_key, label, description, is_sensitive
)
VALUES
  ('prospects.read', 'prospects', 'read', 'Consulter les prospects', 'Consulter les prospects autorisés.', true),
  ('prospects.create', 'prospects', 'create', 'Créer un prospect', 'Créer un nouveau prospect.', true),
  ('prospects.update', 'prospects', 'update', 'Modifier un prospect', 'Modifier les informations et le suivi d’un prospect.', true),
  ('prospects.delete', 'prospects', 'delete', 'Supprimer un prospect', 'Supprimer un prospect.', true)
ON CONFLICT (permission_key) DO UPDATE
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive,
    updated_at = now();

INSERT INTO public.access_role_permissions (role_id, permission_key, scope)
SELECT roles.id, permissions.permission_key, '{"type":"all","version":1}'::jsonb
FROM public.access_roles roles
CROSS JOIN public.access_permissions permissions
WHERE roles.role_key = 'admin'
  AND permissions.resource_key = 'prospects'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;
