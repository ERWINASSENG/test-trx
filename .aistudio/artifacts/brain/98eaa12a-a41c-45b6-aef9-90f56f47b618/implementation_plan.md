# Refonte du formulaire de cotation en Fiche de demande de cotation maritime (Transimex)

Transformation intégrale du formulaire modal de cotation en une **Fiche de demande de cotation maritime / Sea Freight Quotation Request Form** professionnelle, fidèle au document officiel Transimex et adaptée au style **Odoo épuré et compact**, tout en préservant le chiffrage, l'enregistrement et les fonctionnalités existantes.

## User Review & Critical Decisions

> [!IMPORTANT]
> Le formulaire de création/modification de cotation adopte fidèlement la structure, les rubriques bilingues (Français / Anglais) et les options de la fiche Transimex fournie, tout en s'intégrant sans rupture dans le modèle de données de l'application (chiffrage, colonnes, calcul des totaux, assignation commerciale, client).

- **Structure adoptée** : Organisation par sections visuelles épurées Odoo avec barres de titre grises / contrastées :
  1. *En-tête officiel* : Titre « FICHE DE DEMANDE DE COTATION MARITIME / SEA FREIGHT QUOTATION REQUEST FORM », référence, statut, commercial assigné.
  2. *Informations sur le client / Client Information* : Nom de la société, nom du contact, téléphone, email, adresse, avec sélecteur et création rapide.
  3. *Détails de l'expédition / Shipment Details* : Type de marchandise, description, poids brut total (kg), volume total (m³), nombre de colis, type d'emballage.
  4. *Itinéraire souhaité / Preferred Route* : Port de chargement, port de déchargement, Incoterm (EXW, FOB, CFR, DAP, CIF...), dates estimées de départ et d'arrivée, transport intérieur requis.
  5. *Type de service souhaité / Type of Service Required* : FCL, LCL, RO/RO (Véhicules), Break Bulk, Autre.
  6. *Documents disponibles & Services additionnels* : Facture commerciale, Liste de colisage, Certificat d'origine, Fiche technique / MSDS, Dédouanement, Assurance transport, Entreposage, Manutention portuaire, Suivi & traçabilité.
  7. *Chiffrage & Structure de cotation* : Tableau compact des prestations et frais maritimes avec calcul automatique du montant total et devise (XAF, EUR, USD).
- **Style visuel Odoo** : Disposition épurée, formulaires en deux colonnes équilibrées, typographie soignée, bordures fines, badges d'état compacts et pied de page d'action avec total en direct et coordonnées Transimex.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚓ FICHE DE DEMANDE DE COTATION MARITIME / SEA FREIGHT QUOTATION            │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Informations sur le client / Client Information                          │
│    Société · Contact · Téléphone · E-mail · Adresse                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. Détails de l'expédition / Shipment Details                               │
│    Type marchandise · Description · Poids (kg) · Volume (m³) · Colis · Emb. │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. Itinéraire souhaité / Preferred Route & Incoterm                         │
│    Port départ · Port arrivée · Incoterm · Dates est. · Transport intérieur │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Type de service & Options (FCL / LCL / RO/RO / Break Bulk / Docs / Serv) │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. Lignes de chiffrage & Prestations (Tableau compact Odoo avec calcul)     │
├─────────────────────────────────────────────────────────────────────────────┤
│ Pied de page : Total estimé / calculé · Annuler · Enregistrer la cotation   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 1. Overview & Core Concept
- **Ce que fait la refonte** : Remplace l'ancien formulaire générique par la véritable fiche métier maritime de Transimex tout en restant directement exploitable par l'équipe commerciale pour chiffrer, enregistrer et mettre à jour les offres maritimes.
- **Utilisateurs cibles** : Commerciaux, responsables d'exploitation transit/maritime, managers.

## 2. User Experience & Visual Design
- **Esthétique Odoo compacte** :
  - Fonds neutres doux, lignes de démarcation `border-slate-200`, bannières de sections grises/ardoise subtiles conformes au document PDF.
  - Checkboxes et radios alignés proprement avec étiquettes bilingues claires.
  - Saisie intuitive du client avec liaison automatique de ses coordonnées (téléphone, email, contact).
- **Chiffrage fluide** :
  - Tableau de ventilation des coûts avec désignation des prestations (Fret maritime, BAF, CAF, Manutention portuaire, etc.) et colonnes montants.
  - Calcul dynamique du total général en direct dans le pied de page fixe.

## 3. Product Decisions & Data Mapping
- **Compatibilité données existantes** :
  - Les champs spécifiques maritimes (coordonnées du contact, expédition, itinéraire, services, documents et options) sont enregistrés dans `sales_quotes.sea_freight` en JSONB. La colonne a une valeur par défaut `{}` pour conserver les cotations créées avant son ajout.
  - Le tableau de chiffrage reste stocké séparément dans `sales_quotes.columns` et `sales_quotes.rows`; le serveur valide et conserve les deux structures à la création et à la modification.
  - Respect strict des types TypeScript et des composants standalone Angular 19.

## 4. Plan de modification des fichiers

1. **`src/app/core/models/quote.model.ts`**
   - Enrichissement des types avec les métadonnées de la demande maritime (ports, incoterms, détails colis, services, documents).

2. **`src/app/features/quotes/quotes.html`**
   - Remplacement complet de la section modale `section.quote-editor` par la nouvelle fiche maritime Transimex en sections Odoo compactes.

3. **`src/app/features/quotes/quotes.scss`**
   - Styles dédiés Odoo compact : bannières grises de sections, grilles de formulaires bilingues 2 colonnes, options cases à cocher élégantes, tableau de chiffrage compact.

4. **`src/app/features/quotes/quotes.ts`**
   - Logique des signaux pour les champs maritimes, auto-complétion des coordonnées du client sélectionné, et sauvegarde unifiée.

5. **`src/app/features/quotes/quotes.spec.ts`**
   - Tests unitaires complets sur la nouvelle structure de demande et de calcul de cotation maritime.
