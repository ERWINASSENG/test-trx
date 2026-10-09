# Centre de gestion des accès

Date : 2026-09-29

## Objectif

Centraliser les rôles, permissions, autorisations et privilèges côté serveur. L’interface permet à un administrateur de demander une modification, mais elle ne décide jamais seule d’un accès et ne contacte pas Supabase directement pour les mutations sensibles.

## Ce qui a été implémenté

### Modèle dynamique

Le modèle n’utilise plus une liste fixe de rôles pour le nouveau système :

- `access_roles` : rôles système ou personnalisés, créables progressivement.
- `access_permissions` : capacités textuelles comme `cashier.create` ou `journal_entries.update`.
- `access_role_permissions` : permissions accordées à un rôle avec un contexte JSON versionné.
- `access_user_roles` : plusieurs rôles possibles par utilisateur, avec expiration facultative.
- `access_user_overrides` : exceptions individuelles `allow` ou `deny`, avec motif obligatoire et expiration facultative.
- `access_audit_log` : historique des changements d’accès.

Les clés de rôle et de permission sont des données serveur. Ajouter un rôle ou une permission ne nécessite donc pas de modifier l’union TypeScript legacy.

### Scopes contextuels

Les périmètres sont stockés sous forme JSONB avec une version :

```json
{"type":"owner","version":1}
```

Le serveur n’exécute jamais une expression fournie par l’administrateur. Il possède une liste d’évaluateurs sûrs :

- `all`
- `self`
- `owner`
- `department`

Un nouveau contexte métier doit être ajouté par du code serveur avec un évaluateur explicite. Tout type inconnu est refusé.

### Moteur serveur

Fichier principal : `src/server/access-control.ts`.

Il :

- recharge les permissions depuis la base;
- vérifie que le profil est actif;
- applique les affectations de rôles non expirées;
- applique les exceptions utilisateur;
- donne priorité à un refus individuel;
- refuse par défaut si la base ou le catalogue est indisponible;
- vérifie le contexte de la ressource, notamment le propriétaire d’un journal.

Le middleware Express utilisé par les routes est `requirePermission(...)`.

### API d’administration

Fichier : `src/server/access-control.handlers.ts`.

Routes disponibles :

- `GET /api/access-control/me`
- `GET /api/access-control/roles`
- `POST /api/access-control/roles`
- `PATCH /api/access-control/roles/:roleId`
- `DELETE /api/access-control/roles/:roleId`
- `GET /api/access-control/permissions`
- `GET /api/access-control/roles/:roleId/permissions`
- `PUT /api/access-control/roles/:roleId/permissions`
- `GET /api/access-control/users`
- `GET /api/access-control/users/:userId`
- `POST /api/access-control/users/:userId/roles`
- `DELETE /api/access-control/users/:userId/roles/:roleId`
- `PUT /api/access-control/users/:userId/overrides`
- `DELETE /api/access-control/users/:userId/overrides/:overrideId`
- `GET /api/access-control/audit`

Les mutations passent par la fonction SQL `access_control_mutate`, afin que l’autorisation, la modification et l’audit soient atomiques.

### Migration des routes métier

Les routes Express principales utilisent désormais des permissions plutôt que des tableaux de rôles :

- caisse : `cashier.read`, `cashier.create`, `cashier.update`, `cashier.delete`, `cashier.duplicate`, `cashier.status_update`;
- journaux : `journals.read`, `journals.create`, `journals.update`, `journals.delete`;
- écritures : `journal_entries.read`, `journal_entries.chart_read`, `journal_entries.create`, `journal_entries.update`, `journal_entries.delete`;
- utilisateurs : `users.read`, `users.create`, `users.update`, `users.delete`;
- profil : `profile.update`.

Les scopes `owner` des journaux sont résolus par le serveur à partir de `journals.created_by`.

### Migration Angular

Le service [access-control.service.ts](src/app/core/services/access-control.service.ts) ne contient pas l’autorité : il appelle uniquement l’API serveur et expose les permissions effectives à l’interface.

Le guard Angular lit `data.permission`; il ne décide plus à partir de `data.roles`.

Le lanceur et le layout filtrent l’affichage avec les permissions effectives, mais ces filtres restent uniquement ergonomiques. Les routes Express restent la protection réelle.

Le nouveau centre est disponible à :

```text
/admin/access-control
```

Le badge du menu utilisateur affiche le libellé de l’affectation dynamique active
chargé avec le profil (`access_user_roles` / `access_roles`). Le champ `role`
historique reste normalisé pour les usages qui attendent un rôle canonique ;
il ne doit pas remplacer le libellé dynamique dans l’interface.

Les anciens chemins `/admin`, `/admin/view` et `/admin/users` convergent vers ce centre.

### Icône

L’icône du module est :

```text
public/assets/module-icons/access-control.svg
```

Elle provient de l’archive officielle Odoo :

https://download.odoocdn.com/icons/Odoo-icons.zip

L’icône source utilisée est `approvals.svg`, choisie pour représenter les autorisations et validations.

## Fichiers importants

- `src/app/core/models/access-control.model.ts`
- `src/app/core/services/access-control.service.ts`
- `src/app/core/guards/role.guard.ts`
- `src/app/core/models/app-module.model.ts`
- `src/app/features/admin/access-control/access-control.ts`
- `src/app/features/admin/access-control/access-control.html`
- `src/app/features/admin/access-control/access-control.scss`
- `src/server/access-control.ts`
- `src/server/access-control.handlers.ts`
- `src/server/access-control.spec.ts`
- `src/server.ts`
- `public/assets/module-icons/access-control.svg`

## Fichiers SQL

Le projet conserve actuellement un seul fichier SQL :

- `supabase/tous-les-sql.sql`

Il contient le schéma, les anciennes migrations regroupées, les nouvelles migrations du contrôle d’accès et les tests SQL, séparés par des marqueurs `SOURCE`.

Les fichiers SQL individuels ont été supprimés à la demande. Le bundle est une archive documentaire et ne doit pas être exécuté tel quel.

## À faire dans la base TEST

### 1. Réconcilier l’historique Supabase

Le dossier standard `supabase/migrations` ne contient plus les migrations individuelles. Avant tout déploiement :

1. inspecter l’état réel avec `supabase migration list`;
2. comparer `supabase_migrations.schema_migrations` avec les migrations déjà appliquées;
3. restaurer des migrations horodatées ou utiliser une stratégie de réparation validée;
4. ne jamais pousser le bundle complet comme une migration unique sans vérifier l’historique.

### 2. Appliquer les migrations du contrôle d’accès dans l’ordre

À extraire depuis `supabase/tous-les-sql.sql`, dans cet ordre :

1. `20260929100000_access_control_foundation.sql`
2. `20260929110000_access_control_initial_permissions.sql`
3. `20260929120000_access_control_mutations.sql`

La première crée les tables et reprend les rôles existants. La deuxième crée le catalogue initial des permissions. La troisième ajoute la RPC atomique d’administration et son audit.

### 3. Vérifier les prérequis de schéma

Les contrôles précédents liés à la caisse et aux journaux doivent aussi être présents, notamment :

- `journals.created_by`;
- les policies RLS de propriété des journaux;
- les policies de la caisse native réservées à `admin` et `caissiere`;
- les grants directs retirés pour les tables financières et les tables de contrôle d’accès;
- l’exécution de la RPC réservée à `service_role`.

### 4. Exécuter les tests SQL

Les tests à extraire et exécuter dans une base TEST isolée sont :

- `access_control_rls.test.sql`;
- `financial_access_rls.test.sql`;
- `journal_ownership_rls.test.sql`;
- `rls_policies.sql`.

Ils doivent confirmer :

- absence de grants directs au navigateur;
- refus des utilisateurs non autorisés;
- refus d’un trésorier sur le journal d’un autre;
- refus d’un trésorier sur `CSH1`;
- autorisation d’une caissière et d’un administrateur sur la caisse;
- priorité des refus individuels;
- impossibilité de supprimer le dernier administrateur;
- audit des changements de droits.

## État de validation

Validé localement :

- build Angular/SSR réussi;
- diagnostics VS Code sans erreur;
- `git diff --check` propre;
- suite complète : 35 fichiers, 226 tests réussis;
- tests du moteur de permissions : 5 réussis;
- tests ciblés guard/layout/Caisse/moteur : 35 réussis.

Non validé localement :

- migrations SQL non exécutées;
- tests pgTAP non exécutés;
- connexion à la base TEST non vérifiée;
- parcours navigateur du nouveau centre bloqué tant que les tables `access_*` ne sont pas créées.

La CLI Supabase, `psql` et Docker n’étaient pas disponibles dans l’environnement de développement au moment de l’implémentation.

## Architecture Graphify

Graphify a confirmé les relations suivantes :

```text
AuthService / profiles
        -> Angular guard et permissions effectives
        -> AppLauncher / MainLayout / CashierManagement
        -> Express requirePermission
        -> access_control handlers et RPC
        -> tables access_* / RLS / audit Supabase
```

Le graphe contient encore des références historiques aux anciens fichiers SQL supprimés; il devra être actualisé après stabilisation de l’arborescence SQL.

## Références officielles

- Supabase RLS : https://supabase.com/docs/guides/database/postgres/row-level-security
- Sécurisation de l’API Supabase : https://supabase.com/docs/guides/api/securing-your-api
- Supabase Auth : https://supabase.com/docs/guides/auth
- Actifs Odoo : https://www.odoo.com/fr_FR/page/brand-assets
- Archive officielle des icônes Odoo : https://download.odoocdn.com/icons/Odoo-icons.zip
