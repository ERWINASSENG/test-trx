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

Les affectations actives de `access_user_roles` sont la source d’autorité des
rôles : le rôle historique de `profiles` n’est utilisé en repli que lorsqu’il
n’existe aucune affectation active. Cela empêche un rôle personnalisé, tel que
DAF, d’hériter involontairement des privilèges d’un rôle canonique normalisé
comme `employe`.

Dans le module RH, `hr.read` autorise l’accès à l’espace RH, tandis que la liste
des profils collaborateurs exige `users.read`. Le serveur protège cette liste
par cette permission même s’il utilise la clé Supabase `service_role`; l’interface
masque également l’annuaire aux utilisateurs sans ce droit. Les profils
collaborateurs ne sont plus mis en cache dans `localStorage`, afin qu’un refus
d’accès ou un changement de compte ne réaffiche pas des données précédemment
chargées.

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
- dossiers : `dossiers.read` et `dossiers.create`. La migration
  `20261011113000_add_dossier_access_permissions.sql` initialise le catalogue et
  reprend les portées des droits Caisse/CRM existants. Le rôle historique
  `manager` conserve explicitement la lecture et la création des dossiers.
- CRM : la création d’un dossier depuis une opportunité exige à la fois
  `crm.create` et `dossiers.create`.

Les scopes `owner` des journaux sont résolus par le serveur à partir de `journals.created_by`.
L’écran de configuration des journaux suit lui aussi ces permissions effectives
pour la lecture, la création, la modification et la suppression. Les changements
de statut passent par l’API protégée `journals.update`, sans écriture Supabase
directe depuis le navigateur.

Le centre de gestion charge d’abord les permissions effectives de l’utilisateur,
puis ne demande que les sections permises (`access.roles.read`,
`access.permissions.read`, `access.users.read`, `access.audit.read`). Les erreurs
de chargement de section restent visibles au lieu de provoquer des requêtes
interdites à l’initialisation.

### Migration Angular

Le service [access-control.service.ts](src/app/core/services/access-control.service.ts) ne contient pas l’autorité : il appelle uniquement l’API serveur et expose les permissions effectives à l’interface.

Le guard Angular lit `data.permission`; il ne décide plus à partir de `data.roles`.

Le lanceur et le layout filtrent l’affichage avec les permissions effectives, mais ces filtres restent uniquement ergonomiques. Les routes Express restent la protection réelle.

### Visibilité des modules et accès aux données

La visibilité d’une tuile et l’ouverture de son module utilisent désormais des
permissions `module.<nom>.view` indépendantes des autorisations métier. Par
exemple, `module.hr.view` permet d’ouvrir l’espace RH, tandis que `users.read`
reste nécessaire pour consulter l’annuaire. Voir un module n’accorde ni lecture,
ni création, ni modification de ses données.

Les API métier conservent leurs contrôles `requirePermission(...)`. Une route
autorisée par `module.*.view` n’élargit pas les droits de l’API. L’ancienne
lecture directe Supabase des journaux a été supprimée afin qu’un refus ou une
indisponibilité de l’API ne contourne pas son contrôle serveur.

La migration locale
`20261012120000_add_module_visibility_permissions.sql` ajoute les permissions
de visibilité au catalogue et reprend les accès modules existants à partir des
anciennes permissions d’entrée de route. Elle ne transforme pas une permission
de lecture des données en permission de visibilité à l’exécution; après la
migration, l’administrateur peut gérer ces deux familles séparément. Cette
migration n’a pas été appliquée à la base de production.

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

Le dépôt conserve un bundle documentaire et des migrations SQL individuelles :

- `supabase/tous-les-sql.sql`
- `supabase/migrations/`

Le bundle contient des migrations historiques séparées par des marqueurs
`SOURCE`; il ne doit pas être exécuté tel quel. La migration Dossiers ci-dessus
est un fichier individuel et n’a pas été appliquée à une base distante dans le
cadre de cette mise à jour.

## À faire dans la base TEST

### 1. Réconcilier l’historique Supabase

Le répertoire `supabase/migrations` contient certaines migrations individuelles,
mais pas l’intégralité de l’historique fondateur (référencé dans le bundle).
Avant tout déploiement :

1. inspecter l’état réel avec `supabase migration list`;
2. comparer `supabase_migrations.schema_migrations` avec les migrations déjà appliquées;
3. vérifier l’historique avant toute réparation ou application de migration;
4. ne jamais pousser le bundle complet comme une migration unique sans vérifier l’historique.

### 2. Appliquer les migrations du contrôle d’accès dans l’ordre

Les migrations fondatrices historiques sont référencées dans
`supabase/tous-les-sql.sql`, dans cet ordre :

1. `20260929100000_access_control_foundation.sql`
2. `20260929110000_access_control_initial_permissions.sql`
3. `20260929120000_access_control_mutations.sql`

La première crée les tables et reprend les rôles existants. La deuxième crée le catalogue initial des permissions. La troisième ajoute la RPC atomique d’administration et son audit.
Après réconciliation de l’historique, appliquer aussi les migrations
individuelles restantes dans l’ordre de leur horodatage, dont la migration
Dossiers. Ne pas appliquer de migration distante sans validation explicite.

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
- pour la présente mise à jour : build complet réussi, 25 tests ciblés réussis
  sur 4 fichiers, et vérification des 47 clés de permissions API contre les
  fichiers SQL sans clé manquante;
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
