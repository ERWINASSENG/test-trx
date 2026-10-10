BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS contact_role text,
  ADD COLUMN IF NOT EXISTS sector text;

UPDATE public.prospects
SET sector = source
WHERE sector IS NULL AND source IS NOT NULL;

DO $migration$
DECLARE
  prospect_row record;
  legacy_notes jsonb;
BEGIN
  FOR prospect_row IN
    SELECT id, notes
    FROM public.prospects
    WHERE (country IS NULL OR contact_role IS NULL)
      AND notes ~ '^\s*\{.*\}\s*$'
  LOOP
    BEGIN
      legacy_notes := prospect_row.notes::jsonb;
      IF jsonb_typeof(legacy_notes) = 'object' THEN
        UPDATE public.prospects
        SET country = coalesce(country, nullif(legacy_notes ->> 'country', '')),
            contact_role = coalesce(contact_role, nullif(legacy_notes ->> 'contactRole', ''))
        WHERE id = prospect_row.id;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      CONTINUE;
    END;
  END LOOP;
END
$migration$;

CREATE TABLE IF NOT EXISTS public.prospect_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 200),
  job_title text CHECK (job_title IS NULL OR length(job_title) <= 120),
  email text CHECK (email IS NULL OR length(email) <= 320),
  phone text CHECK (phone IS NULL OR length(phone) <= 40),
  is_primary boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prospect_contacts_prospect
  ON public.prospect_contacts (prospect_id, is_primary DESC, full_name);

CREATE TABLE IF NOT EXISTS public.sales_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE RESTRICT,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 200),
  stage text NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new', 'qualified', 'quote_preparation', 'quote_sent', 'negotiation', 'won', 'lost')),
  transport_mode text CHECK (transport_mode IS NULL OR transport_mode IN ('air', 'sea')),
  direction text CHECK (direction IS NULL OR direction IN ('import', 'export')),
  origin text CHECK (origin IS NULL OR length(origin) <= 160),
  destination text CHECK (destination IS NULL OR length(destination) <= 160),
  goods_description text CHECK (goods_description IS NULL OR length(goods_description) <= 2000),
  weight_kg numeric(14, 3) CHECK (weight_kg IS NULL OR weight_kg >= 0),
  volume_m3 numeric(14, 3) CHECK (volume_m3 IS NULL OR volume_m3 >= 0),
  incoterm text CHECK (incoterm IS NULL OR length(incoterm) <= 20),
  estimated_value numeric(14, 2) NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  currency varchar(3) NOT NULL DEFAULT 'XAF' CHECK (currency ~ '^[A-Z]{3}$'),
  expected_close_date date,
  won_reason text CHECK (won_reason IS NULL OR won_reason IN ('accepted_quote', 'signed_contract')),
  contract_reference text CHECK (contract_reference IS NULL OR length(contract_reference) <= 120),
  notes text CHECK (notes IS NULL OR length(notes) <= 10000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (stage <> 'won' OR won_reason IS NOT NULL),
  CHECK (won_reason <> 'signed_contract' OR contract_reference IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sales_opportunities_owner_stage
  ON public.sales_opportunities (assigned_to, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_opportunities_prospect
  ON public.sales_opportunities (prospect_id, updated_at DESC);

ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS opportunity_id uuid
  REFERENCES public.sales_opportunities(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sales_quotes_opportunity
  ON public.sales_quotes (opportunity_id) WHERE opportunity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.sales_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES public.sales_opportunities(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.prospect_contacts(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('call', 'email', 'meeting', 'task')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 200),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  notes text CHECK (notes IS NULL OR length(notes) <= 5000),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (opportunity_id IS NULL OR prospect_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sales_activities_owner_due
  ON public.sales_activities (assigned_to, due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sales_activities_opportunity
  ON public.sales_activities (opportunity_id, due_at);

CREATE TABLE IF NOT EXISTS public.sales_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  starts_at date,
  ends_at date,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  notes text CHECK (notes IS NULL OR length(notes) <= 5000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX IF NOT EXISTS idx_sales_campaigns_status_dates
  ON public.sales_campaigns (status, starts_at);

CREATE TABLE IF NOT EXISTS public.sales_campaign_prospects (
  campaign_id uuid NOT NULL REFERENCES public.sales_campaigns(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, prospect_id)
);

CREATE OR REPLACE FUNCTION public.prepare_sales_campaign_audience(
  p_campaign_id uuid,
  p_prospect_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  inserted_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sales_campaigns WHERE id = p_campaign_id
  ) THEN
    RAISE EXCEPTION 'Campagne introuvable.';
  END IF;

  DELETE FROM public.sales_campaign_prospects WHERE campaign_id = p_campaign_id;
  INSERT INTO public.sales_campaign_prospects (campaign_id, prospect_id)
  SELECT p_campaign_id, recipient_id
  FROM unnest(coalesce(p_prospect_ids, ARRAY[]::uuid[])) AS recipient_id
  ON CONFLICT (campaign_id, prospect_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END
$function$;
REVOKE ALL ON FUNCTION public.prepare_sales_campaign_audience(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_sales_campaign_audience(uuid, uuid[])
  TO service_role;

ALTER TABLE public.dossiers
  ADD COLUMN IF NOT EXISTS opportunity_id uuid
  REFERENCES public.sales_opportunities(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dossiers_opportunity_unique
  ON public.dossiers (opportunity_id) WHERE opportunity_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_prospect_contacts_updated_at ON public.prospect_contacts;
CREATE TRIGGER trg_prospect_contacts_updated_at BEFORE UPDATE ON public.prospect_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_sales_opportunities_updated_at ON public.sales_opportunities;
CREATE TRIGGER trg_sales_opportunities_updated_at BEFORE UPDATE ON public.sales_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_sales_activities_updated_at ON public.sales_activities;
CREATE TRIGGER trg_sales_activities_updated_at BEFORE UPDATE ON public.sales_activities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_sales_campaigns_updated_at ON public.sales_campaigns;
CREATE TRIGGER trg_sales_campaigns_updated_at BEFORE UPDATE ON public.sales_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.sync_accepted_quote_to_sales_crm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.status = 'accepted'
    AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW.opportunity_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.sales_opportunities
        WHERE id = NEW.opportunity_id AND prospect_id = NEW.prospect_id
      ) THEN
        RAISE EXCEPTION 'La cotation et l’opportunité associée doivent appartenir à la même société.';
      END IF;
      UPDATE public.sales_opportunities
      SET stage = 'won', won_reason = 'accepted_quote', contract_reference = NULL
      WHERE id = NEW.opportunity_id AND stage <> 'won';
    END IF;
    UPDATE public.prospects
    SET status = 'converted'
    WHERE id = NEW.prospect_id AND status <> 'converted';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS trg_sync_accepted_quote_to_sales_crm ON public.sales_quotes;
CREATE TRIGGER trg_sync_accepted_quote_to_sales_crm
  AFTER INSERT OR UPDATE OF status ON public.sales_quotes
  FOR EACH ROW EXECUTE FUNCTION public.sync_accepted_quote_to_sales_crm();

ALTER TABLE public.prospect_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_campaign_prospects ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.prospect_contacts, public.sales_opportunities, public.sales_activities,
  public.sales_campaigns, public.sales_campaign_prospects
FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE
  public.prospect_contacts, public.sales_opportunities, public.sales_activities,
  public.sales_campaigns, public.sales_campaign_prospects
TO service_role;

DROP POLICY IF EXISTS prospect_contacts_service_role_all ON public.prospect_contacts;
CREATE POLICY prospect_contacts_service_role_all ON public.prospect_contacts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sales_opportunities_service_role_all ON public.sales_opportunities;
CREATE POLICY sales_opportunities_service_role_all ON public.sales_opportunities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sales_activities_service_role_all ON public.sales_activities;
CREATE POLICY sales_activities_service_role_all ON public.sales_activities
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sales_campaigns_service_role_all ON public.sales_campaigns;
CREATE POLICY sales_campaigns_service_role_all ON public.sales_campaigns
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS sales_campaign_prospects_service_role_all ON public.sales_campaign_prospects;
CREATE POLICY sales_campaign_prospects_service_role_all ON public.sales_campaign_prospects
  FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.access_permissions (permission_key, resource_key, action_key, label, description, is_sensitive)
VALUES
  ('crm.read', 'crm', 'read', 'Consulter le CRM commercial', 'Accéder au pipeline et aux données commerciales attribuées.', true),
  ('crm.create', 'crm', 'create', 'Créer dans le CRM commercial', 'Créer des clients, opportunités, contacts, activités et dossiers commerciaux.', true),
  ('crm.update', 'crm', 'update', 'Modifier le CRM commercial', 'Modifier ses propres opportunités et activités commerciales.', true),
  ('crm.delete', 'crm', 'delete', 'Supprimer dans le CRM commercial', 'Supprimer des données commerciales autorisées.', true),
  ('crm.team.read', 'crm.team', 'read', 'Voir toute l’équipe commerciale', 'Consulter les opportunités et activités de toute l’équipe commerciale.', true),
  ('crm.team.manage', 'crm.team', 'manage', 'Gérer toute l’équipe commerciale', 'Réattribuer et modifier les opportunités et activités de toute l’équipe.', true),
  ('crm.campaigns.manage', 'crm.campaigns', 'manage', 'Gérer les campagnes commerciales', 'Planifier des campagnes et préparer des segments sans envoi automatique.', true)
ON CONFLICT (permission_key) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

WITH crm_grants(permission_key) AS (
  VALUES ('crm.read'), ('crm.create'), ('crm.update'), ('crm.campaigns.manage')
)
INSERT INTO public.access_role_permissions (role_id, permission_key, scope, granted_by)
SELECT roles.id, permissions.permission_key, '{"type":"all","version":1}'::jsonb, NULL
FROM public.access_roles roles
JOIN crm_grants grants ON true
JOIN public.access_permissions permissions ON permissions.permission_key = grants.permission_key
WHERE roles.role_key = 'commercial'
ON CONFLICT (role_id, permission_key, scope) DO NOTHING;

COMMIT;
