BEGIN;

INSERT INTO public.access_permissions (
  permission_key,
  resource_key,
  action_key,
  label,
  description,
  is_sensitive
)
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
SET resource_key = EXCLUDED.resource_key,
    action_key = EXCLUDED.action_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    is_sensitive = EXCLUDED.is_sensitive;

COMMIT;
