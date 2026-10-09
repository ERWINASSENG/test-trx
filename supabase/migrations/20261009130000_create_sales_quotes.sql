BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE SEQUENCE IF NOT EXISTS public.sales_quote_number_seq;

CREATE TABLE IF NOT EXISTS public.sales_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number text NOT NULL UNIQUE DEFAULT (
    'COT-' || to_char(now() AT TIME ZONE 'UTC', 'YYYY') || '-' ||
    lpad(nextval('public.sales_quote_number_seq'::regclass)::text, 7, '0')
  ),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Cotation' CHECK (length(btrim(title)) BETWEEN 2 AND 200),
  currency varchar(3) NOT NULL DEFAULT 'XAF' CHECK (currency ~ '^[A-Z]{3}$'),
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  rows jsonb NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  total_column_id text NOT NULL,
  total_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  valid_until date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_quotes_assigned_updated
  ON public.sales_quotes (assigned_to, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_quotes_prospect_created
  ON public.sales_quotes (prospect_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_quotes_status_valid_until
  ON public.sales_quotes (status, valid_until)
  WHERE status IN ('draft', 'sent') AND valid_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sales_quote_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  total_column_id text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_quote_templates_name
  ON public.sales_quote_templates (name);
CREATE INDEX IF NOT EXISTS idx_sales_quote_templates_creator
  ON public.sales_quote_templates (created_by);

DROP TRIGGER IF EXISTS trg_sales_quotes_updated_at ON public.sales_quotes;
CREATE TRIGGER trg_sales_quotes_updated_at
  BEFORE UPDATE ON public.sales_quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_sales_quote_templates_updated_at ON public.sales_quote_templates;
CREATE TRIGGER trg_sales_quote_templates_updated_at
  BEFORE UPDATE ON public.sales_quote_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sales_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_templates ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.sales_quotes, public.sales_quote_templates
  FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.sales_quotes, public.sales_quote_templates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sales_quote_number_seq TO service_role;

DROP POLICY IF EXISTS sales_quotes_service_role_all ON public.sales_quotes;
CREATE POLICY sales_quotes_service_role_all ON public.sales_quotes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sales_quote_templates_service_role_all ON public.sales_quote_templates;
CREATE POLICY sales_quote_templates_service_role_all ON public.sales_quote_templates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.access_roles (role_key, label, description, is_system)
VALUES ('commercial', 'Commercial', 'Création et suivi des cotations commerciales attribuées.', true)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.access_permissions (permission_key, resource_key, action_key, label, description, is_sensitive)
VALUES
  ('quotes.read', 'quotes', 'read', 'Consulter les cotations', 'Consulter les cotations attribuées au commercial.', true),
  ('quotes.create', 'quotes', 'create', 'Créer une cotation', 'Créer une cotation et en définir les colonnes.', true),
  ('quotes.update', 'quotes', 'update', 'Modifier une cotation', 'Modifier une cotation attribuée au commercial.', true),
  ('quotes.delete', 'quotes', 'delete', 'Supprimer une cotation', 'Supprimer une cotation attribuée au commercial.', true),
  ('quotes.assign', 'quotes', 'assign', 'Attribuer les cotations', 'Attribuer et réattribuer les cotations aux commerciaux.', true),
  ('quotes.templates.read', 'quotes.templates', 'read', 'Consulter les modèles de cotation', 'Consulter les modèles partagés de cotation.', true),
  ('quotes.templates.create', 'quotes.templates', 'create', 'Créer un modèle de cotation', 'Enregistrer une structure de cotation comme modèle partagé.', true),
  ('quotes.templates.update', 'quotes.templates', 'update', 'Modifier un modèle de cotation', 'Modifier un modèle de cotation créé par soi-même.', true),
  ('quotes.templates.delete', 'quotes.templates', 'delete', 'Supprimer un modèle de cotation', 'Supprimer un modèle de cotation créé par soi-même.', true)
ON CONFLICT (permission_key) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

WITH commercial_grants(permission_key) AS (
  VALUES
    ('quotes.read'),
    ('quotes.create'),
    ('quotes.update'),
    ('quotes.delete'),
    ('quotes.templates.read'),
    ('quotes.templates.create'),
    ('quotes.templates.update'),
    ('quotes.templates.delete')
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT roles.id, permissions.permission_key, '{"type":"all","version":1}'::jsonb, NULL
FROM public.access_roles roles
JOIN commercial_grants grants ON true
JOIN public.access_permissions permissions ON permissions.permission_key = grants.permission_key
WHERE roles.role_key = 'commercial'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;
