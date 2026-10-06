# Déploiement de la limitation de débit en production

L'API utilise Upstash Redis REST pour partager les compteurs entre les instances
serverless Vercel. En développement, `express-rate-limit` conserve son store
mémoire local.

## Configuration Vercel

Créer une base Redis Upstash proche de la région Vercel, puis configurer les
variables suivantes dans l'environnement **Preview** et **Production** de Vercel :

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `API_RATE_LIMIT_MAX` (facultatif ; valeur par défaut : `200`)
- `API_RATE_LIMIT_WINDOW_MS` (facultatif ; valeur par défaut : `900000`)
- `API_SLOW_REQUEST_LOG_MS` (facultatif ; valeur par défaut : `1000`)

Les deux variables Upstash sont des secrets : les ajouter dans le tableau de bord
Vercel, jamais dans le dépôt ou dans le navigateur. Le nombre et la durée de
limitation globaux sont appliqués par adresse IP. Ne pas les augmenter sans un
test de charge et une vérification des usages derrière des adresses IP partagées.
Les limites dédiées à l'authentification et aux mutations restent inchangées.

## Mise en service sans migration de base

1. Configurer les variables dans Vercel **Preview**.
2. Déployer une Preview, vérifier les parcours API usuels et exécuter un test de
   charge avec des données de test, jusqu'au pic attendu.
3. Observer les réponses `429`, les erreurs Upstash, les temps de réponse Vercel
   et les métriques de requêtes/connexions Supabase.
4. Ajuster les limites dans Preview, puis promouvoir un déploiement validé vers
   Production. Aucun changement de schéma Supabase n'est requis.
5. Garder le déploiement précédent disponible pour un retour arrière Vercel.

Si Upstash devient temporairement indisponible ou si ses variables manquent,
l'API continue à répondre : la limitation distribuée est temporairement ignorée
et l'incident est journalisé. Cela préserve la disponibilité, mais réduit la
protection contre les abus jusqu'au rétablissement du store.

En Preview et en Production, les requêtes `/api` dépassant
`API_SLOW_REQUEST_LOG_MS` génèrent un log JSON `slow_api_request` avec le verbe,
le modèle de route Express, le statut HTTP et la durée en millisecondes. Ces logs
permettent d'identifier les endpoints lents sans enregistrer de jeton, d'adresse
email, de paramètre d'URL ou de données métier.
