/**
 * Modèle métier pour le module Caisse Transimex
 * Colonnes : Check, Date, Libellé, Type de Transaction, Distribution Analytique (Matricule), Employé, QTE, Montant, Soldes
 */

export type TransactionTypeCategory = 'entree' | 'sortie';
export type TransactionStatus = 'draft' | 'posted' | 'cancelled';
export type Service = 'TRANSIT' | 'TRANSPORT' | 'MANUT' | 'COMMERCIAL' | 'GROUPAGE' | 'DG' | 'SECURITER';
export const CASHIER_SERVICES: Service[] = ['TRANSIT', 'TRANSPORT', 'MANUT', 'COMMERCIAL', 'GROUPAGE', 'DG', 'SECURITER'];
export type CashierServiceType = Service;
export type CashierOperationType = Service; // Rétrocompatibilité

export interface CashierTransaction {
  id: string;
  pieceComptable?: string; // Référence séquentielle Odoo (ex: CSH1/2026/00001)
  date: string; // Format DD/MM/YYYY
  libelle: string; // Ex: "Carburant", "Frais généraux"
  service?: Service | string; // "Opérations" ou "Administration"
  /** Alias historique conservé pour les imports et anciennes intégrations. */
  typeTransaction?: string;
  typeDescription?: string; // Sous-texte descriptif
  category: TransactionTypeCategory; // entree (+) ou sortie (-)
  status?: TransactionStatus; // 'draft' (Brouillon) ou 'posted' (Comptabilisé)
  noDossier?: string; // Requis si service === 'Opérations' (ex: Matricule véhicule / Dossier)
  /** Alias historique du numéro de dossier/matricule. */
  matriculeVehicule?: string;
  firstName?: string; // Optionnel pour rétrocompatibilité
  partenaire?: string; // Nom du partenaire ou de l'employé associé
  employee?: string; // Alias employé
  quantity?: number; // Quantité (QTE) - Requis si service === 'Opérations'
  montant: number; // Valeur numérique signée (positif ou négatif)
  soldeApres?: number; // Solde cumulé calculé
  selected?: boolean; // Case à cocher de sélection
  createdBy?: string; // UUID du créateur (auth.uid() / profiles.id)
  employeeId?: string; // Référence forte vers profiles.id
  createdAt?: string; // Date de création ISO
  updatedAt?: string; // Date de modification ISO
}

export interface CashierFilterState {
  searchQuery: string;
  categoryFilter: 'all' | 'entree' | 'sortie';
  pageIndex: number;
  pageSize: number;
}
