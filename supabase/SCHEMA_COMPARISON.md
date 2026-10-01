# Comparaison des schémas SQL

Date de comparaison : 2026-10-01

## Sources

| Source | Statut | Origine |
|---|---|---|
| `schema-live-2026-10-01.sql` | Référence réelle | Export du projet Supabase `acpnphsvdcvagljlcrvl` |
| `schema-complete.sql` | Reconstruction projet | Code Angular/Express, Graphify et bundle SQL local |

## Verdict

Les deux fichiers **ne sont pas identiques à 100 %**.

Le fichier live doit être considéré comme la source de vérité pour la base actuellement déployée. Le fichier `schema-complete.sql` décrit une base cible reconstruite à partir du code et ne doit pas être appliqué sur la base existante sans migration de rapprochement.

## Tableau comparatif synthétique

| Élément | Schéma live | `schema-complete.sql` | Verdict |
|---|---|---|---|
| Source | Export direct de Supabase | Reconstruction Graphify/code/bundle | **Live prioritaire** |
| Idempotence | `IF NOT EXISTS`, `DROP IF EXISTS`, `CREATE OR REPLACE` | Création principalement directe | **Différent** |
| `profiles` | Structure réelle déployée | Structure reconstruite équivalente | Globalement équivalent |
| `dossiers.created_by` | FK sans `ON DELETE SET NULL` | FK avec `ON DELETE SET NULL` | **Différent** |
| `journals.created_by` | `DEFAULT auth.uid()` + FK `ON DELETE SET NULL` | FK avec défaut différent | **Différent** |
| `journal_entries.employee_id` | UUID sans FK | FK vers `profiles(id)` | **Différent** |
| `cashier_transactions.dossier_id` | FK sans suppression automatique | `ON DELETE SET NULL` | **Différent** |
| Triggers `updated_at` | `set_updated_at` / `handle_updated_at` | Reconstruction distincte | **Différent** |
| Policies profils | Profils actifs lisibles par tout connecté | Lecture plus restrictive | **Écart de confidentialité** |
| Policies journaux | Conditions réellement déployées | Conditions reconstruites | **Différent** |
| Policies écritures | Ownership et rôles live | Ownership reconstruit | **À valider par RLS** |
| Policies caisse | Conditions live par rôle/auteur | Conditions reconstruites | **À valider par RLS** |
| Fonctions `SECURITY DEFINER` | Certains droits accordés à `anon`/`authenticated` | Droits reconstruits plus restrictifs | **Écart de sécurité** |
| `access_control_mutate` | Version complète de production | Version reconstruite | **Live prioritaire** |
| Rôles et permissions | Données présentes en base | Seeds de référence | **Les affectations réelles diffèrent** |
| Scopes `all` / `owner` | État réel de la base | Scopes reconstruits | **À comparer en SQL** |
| Données métier | Exclues | Exclues | Aucun fichier ne contient les transactions |

## Décision

| Question | Réponse |
|---|---|
| Les deux schémas sont-ils identiques ? | Non. |
| Quel fichier représente la base actuelle ? | `schema-live-2026-10-01.sql`. |
| Peut-on appliquer `schema-complete.sql` directement ? | Non, pas sur la base existante. |
| Le fichier complet peut-il servir pour une base neuve ? | Oui, après validation PostgreSQL. |
| Les policies et FK sont-elles interchangeables ? | Non, elles modifient les droits et les suppressions. |


## Tableau comparatif

| Domaine | Schéma live | `schema-complete.sql` | Impact |
|---|---|---|---|
| Idempotence | `IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE` | Création principalement directe | Le fichier complet vise surtout une base neuve ; le live peut être rejoué avec moins de risque de conflit. |
| `profiles` | Structure globalement identique | Structure globalement identique | Pas d’écart fonctionnel majeur relevé. |
| `dossiers.created_by` | FK vers `profiles(id)` sans `ON DELETE SET NULL` | `ON DELETE SET NULL` | Le comportement lors de la suppression d’un profil diffère. |
| `journals.created_by` | `DEFAULT auth.uid()` + FK `ON DELETE SET NULL` | FK `ON DELETE SET NULL`, sans le même défaut explicite | La création directe d’un journal peut produire un `created_by` différent. |
| `journal_entries.employee_id` | UUID sans clé étrangère | FK vers `profiles(id)` avec `ON DELETE SET NULL` | Le fichier complet ajoute une contrainte absente de la base réelle. |
| `cashier_transactions.dossier_id` | FK sans `ON DELETE SET NULL` | FK avec `ON DELETE SET NULL` | Le comportement de suppression d’un dossier diffère. |
| `cashier_transactions.employee_id` | FK sans clause de suppression explicite | FK `ON DELETE SET NULL` | Le comportement de suppression d’un profil diffère. |
| `cashier_transactions.created_by` | FK sans clause de suppression explicite | FK `ON DELETE SET NULL` | Le comportement de conservation des auteurs diffère. |
| Triggers `updated_at` | `set_updated_at` et `handle_updated_at` | `write_updated_at` dans la version reconstruite initiale | Les noms de fonctions et triggers ne correspondent pas exactement. |
| Policies profils | Les profils actifs sont lisibles par tout utilisateur connecté | Lecture limitée au profil propre ou administrateur | Écart de confidentialité important. |
| Policies journaux | La policy live autorise la lecture selon ses conditions actuelles et ne correspond pas partout au filtrage propriétaire reconstruit | Filtrage plus strict des journaux de trésorier | Le comportement de lecture et de modification peut différer. |
| Policies `journal_entries` | Conditions et noms issus de la base réelle | Conditions reconstruites depuis le code/migrations | La protection effective doit être vérifiée avec des tests RLS. |
| Policies caisse | Conditions live spécifiques aux auteurs et rôles | Conditions reconstruites | Les autorisations directes Data API peuvent diverger. |
| `SECURITY DEFINER` | Certaines fonctions restent exécutables par `anon`/`authenticated` | Droits reconstruits plus restrictifs sur plusieurs fonctions | Écart de sécurité et de privilèges. |
| `access_control_mutate` | Version complète de production, avec garde-fou dernier administrateur et refus d’override sur `access.*` | Version reconstruite par le projet | La RPC live est plus fiable pour la base existante. |
| RBAC | Rôles, permissions, scopes et affectations issus de la base | Seeds reconstruits depuis le bundle | Les données présentes en production ne sont pas remplacées par le fichier complet. |
| Données métier | Exclues du fichier live fourni | Exclues du fichier complet | Aucun des deux fichiers ne représente les transactions réelles. |
| Fixtures pgTAP | Exclues | Exclues | Les tests RLS restent dans les fichiers de tests/bundle séparés. |

## Écarts critiques

### 1. Le fichier live est prioritaire

Le schéma live provient directement de Supabase. Il reflète donc les policies, privilèges, contraintes et fonctions réellement actifs au moment du relevé.

`schema-complete.sql` est utile comme base de reconstruction, mais il ne doit pas être utilisé pour écraser la base existante.

### 2. Contraintes de suppression différentes

Les clauses `ON DELETE` ne sont pas décoratives. Elles déterminent si la suppression d’un profil ou d’un dossier :

- bloque la suppression ;
- conserve une référence orpheline ;
- met automatiquement la référence à `NULL`.

Il faut conserver les clauses du schéma live pour respecter le comportement réel actuel.

### 3. Policies différentes

L’écart le plus important concerne les policies RLS :

- lecture des profils actifs ;
- lecture et modification des journaux ;
- accès aux écritures de journaux ;
- accès aux transactions de caisse ;
- privilèges directs `authenticated` et exécution des fonctions `SECURITY DEFINER`.

Une modification du fichier reconstruit ne modifiera pas la base tant qu’elle n’est pas appliquée par une migration validée.

### 4. RPC de contrôle des accès

La RPC live doit être conservée comme référence fonctionnelle. Toute version reconstruite doit reprendre au minimum :

- la vérification de l’utilisateur actif ;
- la permission de l’acteur ;
- la protection du dernier administrateur ;
- la règle d’un seul rôle actif ;
- le refus des overrides sur les permissions `access.*` ;
- l’écriture dans `access_audit_log` ;
- la synchronisation avec `profiles.role` et `auth.users.app_metadata`.

## Recommandation

1. Conserver `schema-live-2026-10-01.sql` comme référence de l’environnement réel.
2. Ne pas exécuter `schema-complete.sql` sur la base existante.
3. Comparer les deux fichiers avant toute migration avec un outil PostgreSQL réel (`pg_dump --schema-only`, `supabase db diff` ou introspection `information_schema`/`pg_catalog`).
4. Transformer uniquement les écarts validés en migrations versionnées.
5. Exécuter les tests RLS après migration sur une base TEST isolée.

## Limite de cette comparaison

La comparaison est statique. La base live n’a pas été interrogée directement dans cette session avec `pg_dump`, `psql` ou la CLI Supabase. Le fichier live fourni est donc considéré comme l’état de référence transmis par l’utilisateur, mais son état actuel doit être revalidé avant une migration destructive ou corrective.
