# Plan d'implémentation — Tableau de bord Commercial Transimex (Fidèle à la maquette)

Création du composant dédié `DashboardCommercial` sur la route `/dashboard` réservé aux profils commerciaux, connecté dynamiquement aux services existants (`CrmService`, `QuoteService`, `DossierService`, `ProspectService`).

## Architecture et Composants

### 1. Modèles & Rôles
- Ajout du rôle `'commercial'` dans `src/app/core/models/auth.model.ts` (ou prise en charge `role === 'commercial'`).
- Extension de `DashboardViewType` dans `src/app/features/dashboard/dashboard.ts` pour inclure `'commercial'` lorsque l'utilisateur connecté possède ce rôle.

### 2. Nouveau Composant `DashboardCommercial`
Emplacement : `src/app/features/dashboard/dashboard-commercial/`
- `dashboard-commercial.ts` : Composant standalone Angular 19, `OnPush`, injectant `CrmService`, `QuoteService`, `DossierService` et `ProspectService`. Calcul réactif des KPIs, du funnel, des opportunités récentes et des tâches de suivi.
- `dashboard-commercial.html` : Gabarit conforme au design de la maquette :
  - 4 cartes KPI d'en-tête (CA prévisionnel, Devis en cours, Opportunités, Taux de conversion).
  - Entonnoir des ventes (5 étapes visuelles avec barres dynamiques et ratios).
  - Évolution du CA (courbe Chart.js double Réalisé / Prévisionnel 12 mois).
  - Carte vectorielle SVG interactive de l'Afrique Centrale (Cameroun, Douala, Kribi, corridors).
  - Tableau du pipeline des opportunités (avec statuts colorés, logo client et actions).
  - Checklist interactive « Mes tâches de suivi » avec badges de priorité.
  - Grille des 7 services logistiques Transimex.
- `dashboard-commercial.scss` : Styles respectant le mode clair et le mode sombre, typographie fluide, cartes arrondies `rounded-2xl`, animations fluides.
- `dashboard-commercial.spec.ts` : Tests unitaires couvrant l'instanciation, le calcul des KPIs dynamiques et l'interactivité des tâches.

### 3. Intégration dans `src/app/features/dashboard/dashboard.ts` et `dashboard.html`
- Prise en charge du profil `commercial` dans le computed `dashboardView`.
- Ajout d'un sélecteur de prévisualisation de rôle pour permettre aux administrateurs et managers de visualiser et tester la vue commerciale directement.
