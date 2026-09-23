import { Injectable, computed, inject, signal, effect, PLATFORM_ID, OnDestroy } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  CashierFilterState,
  CashierTransaction,
} from '../models/cashier-transaction.model';
import {
  findDuplicatePieceComptable,
  findDuplicateTransaction,
  formatIsoToDisplayDate,
  generateTransactionFingerprint,
  normalizePieceComptable,
  toStandardIsoDateString,
} from '../utils/cashier-duplicate.util';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { ExportService } from './export.service';
import { NotificationService } from './notification.service';
import { ParsedImportRow } from './import.service';

export interface CashierDbRow {
  id: string;
  piece_comptable?: string | null;
  date: string;
  libelle: string;
  service?: string | null;
  type_transaction?: string | null;
  type_description?: string | null;
  category: 'entree' | 'sortie';
  status: 'draft' | 'posted' | 'cancelled';
  no_dossier?: string | null;
  matricule_vehicule?: string | null;
  first_name?: string | null;
  partenaire?: string | null;
  employee?: string | null;
  quantity?: number | null;
  montant: number;
  solde_apres?: number | null;
  selected?: boolean;
  created_by?: string | null;
  employee_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

@Injectable({
  providedIn: 'root',
})
export class CashierService implements OnDestroy {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly exportService = inject(ExportService);
  private readonly notificationService = inject(NotificationService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // Liste des transactions en Signal réactif
  private readonly _transactions = signal<CashierTransaction[]>([]);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private errorTimeout: ReturnType<typeof setTimeout> | null = null;
  private realtimeChannel: ReturnType<NonNullable<SupabaseService['supabase']>['channel']> | null = null;

  public setError(message: string | null, notify = true): void {
    if (this.errorTimeout) {
      clearTimeout(this.errorTimeout);
      this.errorTimeout = null;
    }
    this._error.set(message);

    if (message && notify) {
      const lower = message.toLowerCase();
      if (lower.includes('doublon') || lower.includes('pièce comptable') || lower.includes('identique') || lower.includes('déjà attribué') || lower.includes('déjà enregistré')) {
        this.notificationService.warning(message, 'Doublon détecté');
      } else {
        this.notificationService.error(message, 'Erreur');
      }
    }
  }

  constructor() {
    // Réactivité automatique : recharger les transactions et initialiser Realtime dès qu'un utilisateur est authentifié
    effect(() => {
      const user = this.authService.currentUser();
      if (user && this.isBrowser) {
        this.loadTransactions();
        this.setupRealtimeSubscription();
      } else if (!user && this.isBrowser) {
        this.cleanupRealtimeSubscription();
      }
    });

    // Au montage initial dans le navigateur, attend la session et déclenche le chargement
    if (this.isBrowser) {
      this.initBrowserData();
    }
  }

  private async initBrowserData(): Promise<void> {
    try {
      await this.authService.waitForSession();
      if (this.authService.isAuthenticated()) {
        await this.loadTransactions();
        await this.setupRealtimeSubscription();
      }
    } catch (e) {
      console.warn('Initialisation des données de caisse après refresh:', e);
    }
  }

  ngOnDestroy(): void {
    this.cleanupRealtimeSubscription();
  }

  // Filtres et pagination (plancher de 80 lignes minimum par page)
  private readonly _filterState = signal<CashierFilterState>({
    searchQuery: '',
    categoryFilter: 'all',
    pageIndex: 0,
    pageSize: 80,
  });

  // Signal pour piloter l'ouverture de la ligne d'ajout inline depuis le Layout
  public readonly isAddingRow = signal<boolean>(false);

  // Signal pour piloter l'ouverture de la boîte modale d'importation Excel / CSV
  public readonly isImportModalOpen = signal<boolean>(false);

  public openImportModal(): void {
    this.isImportModalOpen.set(true);
  }

  public closeImportModal(): void {
    this.isImportModalOpen.set(false);
  }

  // Signal calculé pour la prochaine référence de pièce comptable prévisionnelle (ex: CSH1/2026/00004)
  public readonly nextPieceComptable = computed<string>(() => {
    const list = this._transactions();
    const currentYear = new Date().getFullYear() || 2026;
    const prefix = `CSH1/${currentYear}/`;
    let maxSeq = 0;

    for (const t of list) {
      const piece = normalizePieceComptable(t.pieceComptable);
      if (piece && piece.startsWith(prefix)) {
        const seqStr = piece.substring(prefix.length);
        const seqNum = parseInt(seqStr, 10);
        if (!isNaN(seqNum) && seqNum > maxSeq) {
          maxSeq = seqNum;
        }
      }
    }

    const nextNum = maxSeq > 0 ? maxSeq + 1 : list.length + 1;
    return `${prefix}${String(nextNum).padStart(5, '0')}`;
  });

  // États exposés en lecture seule
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());
  public readonly allTransactions = computed(() => this._transactions());

  // Transactions filtrées par mot-clé et type
  public readonly filteredTransactions = computed(() => {
    const query = this._filterState().searchQuery.trim().toLowerCase();
    const category = this._filterState().categoryFilter;
    const list = this._transactions();

    return list.filter((tx) => {
      const matchesCategory =
        category === 'all' || tx.category === category;
      if (!matchesCategory) return false;

      if (!query) return true;

      const searchableText = `${tx.libelle} ${tx.service || ''} ${tx.typeDescription || ''} ${tx.firstName || ''} ${tx.employee || ''} ${tx.partenaire || ''} ${tx.noDossier || ''}`.toLowerCase();
      return searchableText.includes(query);
    });
  });

  // Calcul du solde actuel en temps réel
  public readonly currentBalance = computed(() => {
    const list = this._transactions();
    if (list.length === 0) return 0;
    return list.reduce((acc, curr) => acc + curr.montant, 0);
  });

  // Transactions paginées
  public readonly pagedTransactions = computed(() => {
    const filtered = this.filteredTransactions();
    const { pageIndex, pageSize } = this._filterState();
    const start = pageIndex * pageSize;
    return filtered.slice(start, start + pageSize);
  });

  // Total des éléments filtrés
  public readonly totalCount = computed(() => this.filteredTransactions().length);

  // Pagination calculée et formatée pour le Control Panel ERP (ex: "1-10 / 25" ou "0 / 0")
  public readonly paginationLabel = computed(() => {
    const total = this.totalCount();
    if (total === 0) return '0 / 0';
    const { pageIndex, pageSize } = this._filterState();
    const start = pageIndex * pageSize + 1;
    const end = Math.min((pageIndex + 1) * pageSize, total);
    return `${start}-${end} / ${total}`;
  });

  public readonly hasPrevPage = computed(() => this._filterState().pageIndex > 0);
  public readonly hasNextPage = computed(() => {
    const { pageIndex, pageSize } = this._filterState();
    return (pageIndex + 1) * pageSize < this.totalCount();
  });

  // État du filtre actuel en lecture seule
  public readonly filterState = computed(() => this._filterState());

  // Indique si toutes les transactions affichées sont sélectionnées
  public readonly isAllSelected = computed(() => {
    const currentList = this.pagedTransactions();
    return currentList.length > 0 && currentList.every((tx) => !!tx.selected);
  });

  public static readonly DEFAULT_OPERATIONS_LIMIT = 1000;

  private activeLoadPromise: Promise<void> | null = null;

  /**
   * ───────────────────────────────────────────────────────────────────────────
  * 1. LECTURE CENTRALISÉE VIA L'API EXPRESS
   * ───────────────────────────────────────────────────────────────────────────
   * Tente d'abord de récupérer les opérations via l'API Express rapide (/api/cahier/operations).
  * En cas d'indisponibilité ou d'erreur réseau, l'opération échoue sans contourner les contrôles serveur.
   * Gère la déduplication des appels concurrents via une Promesse unique partagée.
   * Borne systématiquement le volume à `limit` (1000 par défaut) sur les deux canaux
   * afin de protéger l'onglet contre toute surcharge mémoire en situation dégradée.
   */
  public async loadTransactions(limit: number = CashierService.DEFAULT_OPERATIONS_LIMIT): Promise<void> {
    if (this.activeLoadPromise) {
      return this.activeLoadPromise;
    }

    this.activeLoadPromise = (async () => {
      this._isLoading.set(true);
      this._error.set(null);

      let rawRows: CashierDbRow[] | null = null;
      let token = this.authService.token();

      try {
        // Si le token n'est pas encore dans le signal, tenter de le lire depuis la session Supabase
        if (!token && this.supabaseService.supabase) {
          try {
            const { data } = await this.supabaseService.supabase.auth.getSession();
            if (data.session?.access_token) {
              token = data.session.access_token;
            }
          } catch {
            // Ignorer
          }
        }

        // Canal 1 : API Express Serveur-Relais (si token disponible)
        if (token) {
          try {
            const headers: Record<string, string> = {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            };

            const response = await fetch(`/api/cahier/operations?limit=${limit}`, {
              method: 'GET',
              headers,
            });

            if (response.ok) {
              const resJson = await response.json();
              const ops = resJson.operations || resJson.transactions;
              if (Array.isArray(ops)) {
                rawRows = ops as CashierDbRow[];
              }
            } else {
              console.warn(`API Express /api/cahier/operations a répondu HTTP ${response.status} pendant le chargement.`);
            }
          } catch (apiErr) {
            console.warn('API Express /api/cahier/operations indisponible pendant le chargement:', apiErr);
          }
        }

        // Aucun repli direct Supabase et aucune alerte utilisateur pendant un
        // chargement automatique : les erreurs seront visibles lors d'une action.

        // Traitement et injection dans le Signal Angular 19
        if (rawRows && Array.isArray(rawRows)) {
          const mappedTransactions = this.mapDatabaseOperations(rawRows);
          this._transactions.set(mappedTransactions);
        }
      } catch (err: unknown) {
        console.error('Erreur globale lors du chargement des opérations de caisse:', err);
      } finally {
        this._isLoading.set(false);
        this.activeLoadPromise = null;
      }
    })();

    return this.activeLoadPromise;
  }

  private toIsoDateString(dStr?: string): string {
    return toStandardIsoDateString(dStr);
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 2. SAUVEGARDE VIA API SERVEUR-RELAIS & RÉACTIVITÉ INSTANTANÉE VIA SIGNALS
   * ───────────────────────────────────────────────────────────────────────────
   * Sauvegarde une opération via POST /api/cahier/operations avec le JWT Bearer.
   * Dès réception de la confirmation, injecte l'opération dans le Signal _transactions.
   */
  public async saveOperationViaApi(
    op: Partial<CashierTransaction> | Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>
  ): Promise<{ success: boolean; operation?: CashierTransaction; error?: string }> {
    this._error.set(null);

    // Si une pièce comptable est explicitement fournie par l'appelant (ex: import ou rattachement manuel), on la normalise
    const explicitPiece = op.pieceComptable ? normalizePieceComptable(op.pieceComptable) : undefined;
    if (explicitPiece) {
      const pieceDuplicate = findDuplicatePieceComptable({ pieceComptable: explicitPiece }, this._transactions());
      if (pieceDuplicate) {
        const errorMsg = `Le numéro de pièce comptable "${explicitPiece}" est déjà attribué à une autre opération (ID: ${pieceDuplicate.id}, Date: ${pieceDuplicate.date}, Libellé: "${pieceDuplicate.libelle}"). Les numéros de pièces comptables doivent être strictement uniques.`;
        this.setError(errorMsg);
        return { success: false, error: errorMsg };
      }
    }

    // Contrôle d'unicité par empreinte métier : Date + Montant + Libellé + N° de dossier/matricule + Service
    const existingDuplicate = findDuplicateTransaction(
      {
        date: op.date,
        montant: op.montant,
        category: op.category,
        libelle: op.libelle,
        noDossier: op.noDossier,
        service: op.service,
        pieceComptable: explicitPiece,
      },
      this._transactions()
    );

    if (existingDuplicate) {
      const montantFmt = Math.abs(Number(existingDuplicate.montant)).toLocaleString('fr-FR');
      const errorMsg = `Opération déjà enregistrée : une opération identique existe déjà en caisse (Date: ${existingDuplicate.date}, Montant: ${montantFmt} FCFA, Service: ${existingDuplicate.service || 'N/A'}, Libellé: "${existingDuplicate.libelle}"). La double saisie est interdite.`;
      this.setError(errorMsg);
      return { success: false, error: errorMsg };
    }

    const token = this.authService.token();
    const currentSolde = this.currentBalance();
    const montant = Number(op.montant) || 0;
    const estimatedNewSolde = currentSolde + montant;

    let savedRow: CashierDbRow | null = null;

    // Étape 1 : Appel de l'API Serveur-Relais sécurisée
    // Comme sur Odoo, si explicitPiece est vide (création standard), on envoie null/undefined pour que le trigger assigne la séquence
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/api/cahier/operations', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          pieceComptable: explicitPiece || null,
          libelle: op.libelle,
          service: op.service,
          typeDescription: op.typeDescription || null,
          category: op.category,
          status: op.status || 'draft',
          noDossier: op.noDossier || null,
          firstName: op.firstName || null,
          employee: op.employee || op.partenaire || null,
          partenaire: op.partenaire || op.employee || null,
          quantity: op.quantity || 1,
          montant: op.montant,
          date: this.toIsoDateString(op.date),
        }),
      });

      if (response.ok) {
        const resJson = await response.json();
        savedRow = (resJson.operation || resJson.transaction) as CashierDbRow;
      } else {
        const errJson = await response.json().catch(() => ({}));
        const serverError = errJson.error || `Erreur serveur ${response.status}`;

        // RÈGLE D'OR : Si le serveur signale un doublon (409 Conflict) ou un refus explicite,
        // stoppe immédiatement : aucun repli pirate n'est toléré.
        if (response.status === 409 || response.status === 400 || response.status === 403) {
          this.setError(serverError);
          return { success: false, error: serverError };
        }

        throw new Error(serverError);
      }
    } catch (apiErr: unknown) {
      const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      if (errMsg.includes('doublon') || errMsg.includes('409') || errMsg.includes('interdite') || errMsg.includes('pièce')) {
        this.setError(errMsg);
        return { success: false, error: errMsg };
      }

      console.warn('Appel API /api/cahier/operations échoué, aucune écriture directe Supabase autorisée:', apiErr);
      this.setError('Le service de caisse est temporairement indisponible. Veuillez réessayer.');
      return { success: false, error: this._error()! };
    }

    // Si aucune sauvegarde réelle n'a pu être actée, NE JAMAIS injecter de ligne factice locale
    if (!savedRow) {
      const failureMsg = this._error() || 'Impossible d’enregistrer l’opération : échec de validation du serveur.';
      this.setError(failureMsg);
      return { success: false, error: failureMsg };
    }

    // Étape 3 : Création de l'objet transaction unifié (comme sur Odoo : la pièce officielle retournée par la base)
    const currentUserId = this.authService.currentUser()?.id;
    const operationToStore: CashierTransaction = {
      id: savedRow.id,
      pieceComptable: savedRow.piece_comptable || explicitPiece || this.nextPieceComptable(),
      date: this.formatDate(savedRow.date || new Date().toISOString()),
      libelle: savedRow.libelle,
      service: savedRow.service || savedRow.type_transaction || '',
      typeDescription: savedRow.type_description || '',
      category: savedRow.category as 'entree' | 'sortie',
      status: (savedRow.status as 'draft' | 'posted' | 'cancelled') || op.status || 'draft',
      noDossier: savedRow.no_dossier || savedRow.matricule_vehicule || '',
      firstName: savedRow.first_name || '',
      employee: savedRow.employee || '',
      partenaire: savedRow.partenaire || savedRow.employee || '',
      quantity: savedRow.quantity ? Number(savedRow.quantity) : undefined,
      montant: Number(savedRow.montant),
      soldeApres: savedRow.solde_apres !== undefined && savedRow.solde_apres !== null ? Number(savedRow.solde_apres) : estimatedNewSolde,
      selected: false,
      createdBy: savedRow.created_by || currentUserId || undefined,
      employeeId: savedRow.employee_id || currentUserId || undefined,
      createdAt: savedRow.created_at || new Date().toISOString(),
      updatedAt: savedRow.updated_at,
    };

    // Étape 4 (RÉACTIVITÉ INSTANTANÉE) : Mise à jour immédiate du Signal Angular 19
    this._transactions.update((currentOps) => [operationToStore, ...currentOps]);
    this.recalculateRunningBalances();

    return { success: true, operation: operationToStore };
  }

  /**
   * Alias rétrocompatible pour l'ajout d'une transaction
   */
  public async addTransaction(
    newTx: Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>
  ): Promise<{ success: boolean; operation?: CashierTransaction; error?: string }> {
    return this.saveOperationViaApi(newTx);
  }

  /**
   * Importation par lot d'écritures de caisse (issues d'Excel ou CSV)
   */
  public async importTransactions(
    rows: ParsedImportRow[]
  ): Promise<{ success: boolean; insertedCount: number; duplicateCount: number; errors: string[] }> {
    if (!rows || rows.length === 0) {
      return { success: true, insertedCount: 0, duplicateCount: 0, errors: [] };
    }

    let insertedCount = 0;
    let duplicateCount = 0;
    const errors: string[] = [];
    const seenFingerprintsInBatch = new Set<string>();
    const seenPiecesInBatch = new Set<string>();

    for (const row of rows) {
      const candidatePiece = normalizePieceComptable(row.pieceComptable);
      if (candidatePiece) {
        const isPieceInBatch = seenPiecesInBatch.has(candidatePiece);
        const dbPieceDup = findDuplicatePieceComptable({ pieceComptable: candidatePiece }, this._transactions());
        if (isPieceInBatch || dbPieceDup) {
          duplicateCount++;
          const origin = dbPieceDup ? 'déjà existant en caisse' : 'en double dans le fichier importé';
          errors.push(`Doublon de pièce comptable bloqué : "${candidatePiece}" (${row.libelle}) - ${origin}.`);
          continue;
        }
        seenPiecesInBatch.add(candidatePiece);
      }

      const candidate = {
        date: row.date,
        montant: row.montant,
        libelle: row.libelle,
        noDossier: row.noDossier,
        service: row.service,
        pieceComptable: candidatePiece,
      };

      const fingerprint = generateTransactionFingerprint(candidate);
      const isDuplicateInBatch = seenFingerprintsInBatch.has(fingerprint);
      const isDuplicateInDb = !!findDuplicateTransaction(candidate, this._transactions());

      if (isDuplicateInBatch || isDuplicateInDb) {
        duplicateCount++;
        const origin = isDuplicateInDb ? 'déjà enregistrée en caisse' : 'en double dans le fichier';
        errors.push(`Doublon détecté et bloqué : "${row.libelle}" (${row.date}, ${row.montant} FCFA, ${row.service || 'Sans service'}) - ${origin}.`);
        continue;
      }

      seenFingerprintsInBatch.add(fingerprint);

      try {
        const res = await this.addTransaction({
          pieceComptable: candidatePiece || undefined,
          date: row.date,
          libelle: row.libelle,
          service: row.service,
          category: row.category,
          status: row.status || 'draft',
          noDossier: row.noDossier,
          partenaire: row.partenaire || row.employee,
          employee: row.employee || row.partenaire,
          quantity: row.quantity,
          montant: row.montant,
        });

        if (res.success) {
          insertedCount++;
        } else {
          errors.push(`Écriture "${row.libelle}" : ${res.error || 'échec de sauvegarde.'}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Erreur inconnue';
        errors.push(`Écriture "${row.libelle}" : ${msg}`);
      }
    }

    // Après l'insertion du lot, forcer le rechargement depuis le serveur pour synchroniser
    // l'état local avec les pièces officielles et soldes recalculés en base de données.
    if (insertedCount > 0) {
      await this.loadTransactions();
    }

    return {
      success: insertedCount > 0 || duplicateCount > 0,
      insertedCount,
      duplicateCount,
      errors,
    };
  }

  /**
   * Alias rétrocompatible pour la suppression des transactions sélectionnées
   */
  public async deleteSelectedTransactions(): Promise<boolean> {
    return this.deleteSelected();
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 2b. MODIFICATION D'UNE TRANSACTION : API RELAIS AVEC REPLI ET RÉACTIVITÉ
   * ───────────────────────────────────────────────────────────────────────────
   */
  public async updateTransaction(
    id: string,
    updatedFields: Partial<Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>>
  ): Promise<{ success: boolean; message?: string }> {
    this._error.set(null);

    // Contrôle d'unicité strict lors de la modification
    const currentTx = this._transactions().find((t) => t.id === id);
    if (currentTx) {
      const targetPiece = normalizePieceComptable(
        updatedFields.pieceComptable !== undefined ? updatedFields.pieceComptable : currentTx.pieceComptable
      );

      if (targetPiece) {
        const pieceDuplicate = findDuplicatePieceComptable({ id, pieceComptable: targetPiece }, this._transactions());
        if (pieceDuplicate) {
          const errorMsg = `Modification refusée : le numéro de pièce comptable "${targetPiece}" est déjà attribué à une autre opération (ID: ${pieceDuplicate.id}, Date: ${pieceDuplicate.date}, Libellé: "${pieceDuplicate.libelle}"). Un numéro de pièce doit être strictement unique.`;
          this.setError(errorMsg);
          return { success: false, message: errorMsg };
        }
      }

      const candidate = {
        id,
        date: updatedFields.date !== undefined ? updatedFields.date : currentTx.date,
        montant: updatedFields.montant !== undefined ? updatedFields.montant : currentTx.montant,
        category: updatedFields.category !== undefined ? updatedFields.category : currentTx.category,
        libelle: updatedFields.libelle !== undefined ? updatedFields.libelle : currentTx.libelle,
        noDossier: updatedFields.noDossier !== undefined ? updatedFields.noDossier : currentTx.noDossier,
        service: updatedFields.service !== undefined ? updatedFields.service : currentTx.service,
        pieceComptable: targetPiece,
      };
      const duplicate = findDuplicateTransaction(candidate, this._transactions());
      if (duplicate) {
        const errorMsg = `Modification refusée : une opération identique existe déjà en caisse (Date: ${duplicate.date}, Montant: ${duplicate.montant} FCFA, Service: ${duplicate.service || 'N/A'}, Libellé: "${duplicate.libelle}").`;
        this.setError(errorMsg);
        return { success: false, message: errorMsg };
      }
    }

    const token = this.authService.token();

    // 1. Convertir la date affichée en ISO standard sans décalage de fuseau horaire
    const isoDate = updatedFields.date ? toStandardIsoDateString(updatedFields.date) : undefined;

    // 2. Appel vers l'API serveur-relais
    let updatedViaApi = false;
    let apiErrorMessage = '';
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const bodyPayload: Record<string, unknown> = {};
      if (updatedFields.libelle !== undefined) bodyPayload['libelle'] = updatedFields.libelle;
      if (updatedFields.service !== undefined) bodyPayload['service'] = updatedFields.service;
      if (updatedFields.typeDescription !== undefined) bodyPayload['typeDescription'] = updatedFields.typeDescription;
      if (updatedFields.category !== undefined) bodyPayload['category'] = updatedFields.category;
      if (updatedFields.status !== undefined) bodyPayload['status'] = updatedFields.status;
      if (updatedFields.noDossier !== undefined) bodyPayload['noDossier'] = updatedFields.noDossier;
      if (updatedFields.firstName !== undefined) bodyPayload['firstName'] = updatedFields.firstName;
      if (updatedFields.employee !== undefined) bodyPayload['employee'] = updatedFields.employee;
      if (updatedFields.partenaire !== undefined) bodyPayload['partenaire'] = updatedFields.partenaire;
      if (updatedFields.quantity !== undefined) bodyPayload['quantity'] = updatedFields.quantity;
      if (updatedFields.montant !== undefined) bodyPayload['montant'] = updatedFields.montant;
      if (updatedFields.pieceComptable !== undefined) bodyPayload['pieceComptable'] = updatedFields.pieceComptable;
      if (isoDate) bodyPayload['date'] = isoDate;

      const response = await fetch(`/api/cahier/operations/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(bodyPayload),
      });

      if (response.ok) {
        updatedViaApi = true;
      } else {
        const errJson = await response.json().catch(() => null);
        if (response.status === 403) {
          apiErrorMessage = errJson?.error || 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.';
        } else {
          apiErrorMessage = errJson?.error || errJson?.message || `Erreur serveur (${response.status})`;
        }
      }
    } catch (apiErr) {
      console.warn('Appel API update /api/cahier/operations échoué, tentative via client Supabase direct:', apiErr);
      apiErrorMessage = apiErr instanceof Error ? apiErr.message : 'Erreur réseau';
    }

    if (!updatedViaApi) {
      let finalMsg = apiErrorMessage || 'Échec de la sauvegarde en base de données';
      if (
        finalMsg.includes('403') ||
        finalMsg.includes('Forbidden') ||
        finalMsg.includes('row-level security') ||
        finalMsg.includes('policy') ||
        finalMsg.includes('Privilèges insuffisants')
      ) {
        finalMsg = 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.';
      }
      this.setError(finalMsg, false);
      return { success: false, message: finalMsg };
    }

    // 4. Mise à jour immédiate du Signal Angular 19 et recalcul des soldes cumulés
    this._transactions.update((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          ...updatedFields,
          date: updatedFields.date || item.date,
          libelle: updatedFields.libelle !== undefined ? updatedFields.libelle : item.libelle,
          service: updatedFields.service !== undefined ? updatedFields.service : item.service,
          typeDescription: updatedFields.typeDescription !== undefined ? updatedFields.typeDescription : item.typeDescription,
          category: updatedFields.category !== undefined ? updatedFields.category : item.category,
          status: updatedFields.status !== undefined ? updatedFields.status : item.status,
          noDossier: updatedFields.noDossier !== undefined ? updatedFields.noDossier : item.noDossier,
          employee: updatedFields.employee !== undefined ? updatedFields.employee : item.employee,
          quantity: updatedFields.quantity !== undefined ? updatedFields.quantity : item.quantity,
          montant: updatedFields.montant !== undefined ? updatedFields.montant : item.montant,
        };
      })
    );

    this.recalculateRunningBalances();
    return { success: true, message: 'Transaction modifiée avec succès' };
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 3. SUPPRESSION D'OPÉRATIONS : API RELAIS AVEC REPLI ET RÉACTIVITÉ
   * ───────────────────────────────────────────────────────────────────────────
   */
  public async deleteTransaction(id: string): Promise<boolean> {
    if (!id) return false;
    return this.deleteBatchTransactions([id]);
  }

  public async deleteSelected(): Promise<boolean> {
    const selectedIds = this._transactions()
      .filter((t) => t.selected)
      .map((t) => t.id);

    if (selectedIds.length === 0) return true;
    return this.deleteBatchTransactions(selectedIds);
  }

  /**
   * Suppression synchronisée avec la base de données (Supabase / Serveur Express)
   * La mise à jour du Signal local n'intervient QUE SI la suppression en base est confirmée.
   */
  private async deleteBatchTransactions(targetIds: string[]): Promise<boolean> {
    if (targetIds.length === 0) return true;

    this._error.set(null);
    let activeToken = this.authService.token();

    // Récupération dynamique et fraîche du jeton Supabase
    if (this.supabaseService.supabase) {
      try {
        const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
        if (sessionData.session?.access_token) {
          activeToken = sessionData.session.access_token;
        }
      } catch (err) {
        console.warn('Session Supabase non récupérable pour suppression:', err);
      }
    }

    let deletedSuccessfully = false;
    let failureReason: string | null = null;

    // Étape 1 : Appel à l'API Express sécurisée (exécute la suppression SQL via la clé de service)
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (activeToken) {
        headers['Authorization'] = `Bearer ${activeToken}`;
      }

      let response = await fetch('/api/cahier/operations', {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ ids: targetIds }),
      });

      if (!response.ok && response.status === 404) {
        response = await fetch('/api/cashier/transactions', {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ ids: targetIds }),
        });
      }

      if (response.ok) {
        deletedSuccessfully = true;
      } else {
        const errJson = await response.json().catch(() => null);
        if (response.status === 403) {
          failureReason = errJson?.error || 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.';
        } else {
          failureReason = errJson?.error || errJson?.message || `Erreur serveur HTTP ${response.status}`;
        }
      }
    } catch (networkErr) {
      console.warn('Erreur réseau appel API Express DELETE, tentative repli Supabase:', networkErr);
    }

    // Une panne de l'API ne doit jamais déclencher une suppression directe via Supabase.
    if (!deletedSuccessfully && !failureReason) {
      failureReason = 'Le service de caisse est temporairement indisponible. Veuillez réessayer.';
    }

    // Si la suppression a échoué en base de données, on refuse la suppression dans l'UI et on alerte l'utilisateur
    if (!deletedSuccessfully) {
      let errorMsg = failureReason || 'Impossible de supprimer cette opération dans la base de données.';
      if (
        errorMsg.includes('403') ||
        errorMsg.includes('Forbidden') ||
        errorMsg.includes('row-level security') ||
        errorMsg.includes('policy') ||
        errorMsg.includes('Privilèges insuffisants')
      ) {
        errorMsg = 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.';
      }
      this.setError(errorMsg);
      console.error('[CashierService] Échec suppression DB:', errorMsg);
      return false;
    }

    // Étape 3 : Mise à jour de l'état réactif Signals Angular 19 UNIQUEMENT après succès DB
    this._transactions.update((items) => items.filter((item) => !targetIds.includes(item.id)));
    this.recalculateRunningBalances();
    return true;
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 4. EXPORT DES OPÉRATIONS DE CAISSE (DÉLÉGUÉ À EXPORTSERVICE)
   * ───────────────────────────────────────────────────────────────────────────
   * Exporte soit les lignes sélectionnées, soit l'ensemble des opérations filtrées visibles.
   */
  public exportTransactions(onlySelected = false): void {
    const allFiltered = this.filteredTransactions();
    const selectedRows = this._transactions().filter((t) => t.selected);
    const dataset = onlySelected && selectedRows.length > 0 ? selectedRows : allFiltered;

    this.exportService.exportCashierTransactionsCsv(dataset);
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 5. ACTIONS EN MASSE SYNCHRONISÉES DB SUPABASE (ODOO ACTIONS BAR)
   * ───────────────────────────────────────────────────────────────────────────
   */

  /**
   * Duplique en base Supabase toutes les opérations actuellement sélectionnées
   */
  public async duplicateSelected(): Promise<boolean> {
    const selectedIds = this._transactions()
      .filter((t) => t.selected)
      .map((t) => t.id);

    if (selectedIds.length === 0) return true;

    this._error.set(null);
    let token = this.authService.token();
    if (!token && this.supabaseService.supabase) {
      try {
        const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
        token = sessionData.session?.access_token || null;
      } catch {
        // Ignorer
      }
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/api/cahier/operations/duplicate', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: selectedIds }),
      });

      if (response.ok) {
        const resJson = await response.json();
        const createdRows = (resJson.data || []) as CashierDbRow[];
        const mapped = createdRows.map((r) => this.mapSingleDbRow(r));

        this._transactions.update((currentList) => [...mapped, ...currentList]);
        this.recalculateRunningBalances();
        this.toggleSelectAll(false);
        return true;
      } else {
        const errJson = await response.json().catch(() => ({}));
        const serverError = errJson.error || `Erreur lors de la duplication (${response.status})`;
        this.setError(serverError);
        return false;
      }
    } catch (netErr) {
      console.warn('Erreur réseau lors de la duplication API:', netErr);
    }

    this.setError('Le service de caisse est temporairement indisponible. Veuillez réessayer.');
    return false;
  }

  /**
   * Remet en statut 'draft' (brouillon) les opérations sélectionnées
   */
  public async resetSelectedToDraft(): Promise<boolean> {
    const selectedIds = this._transactions()
      .filter((t) => t.selected)
      .map((t) => t.id);

    if (selectedIds.length === 0) return true;

    this._error.set(null);
    let token = this.authService.token();
    if (!token && this.supabaseService.supabase) {
      try {
        const { data: sessionData } = await this.supabaseService.supabase.auth.getSession();
        token = sessionData.session?.access_token || null;
      } catch {
        // Ignorer
      }
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/api/cahier/operations/status', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ids: selectedIds, status: 'draft' }),
      });

      if (response.ok) {
        this._transactions.update((items) =>
          items.map((it) => (selectedIds.includes(it.id) ? { ...it, status: 'draft', selected: false } : it))
        );
        return true;
      }
    } catch {
      // Ignorer
    }

    this.setError('Le service de caisse est temporairement indisponible. Veuillez réessayer.');
    return false;
  }

  /**
   * Insérer dans une feuille de calcul (génère un classeur TSV/Excel détaillé avec formules de totaux)
   */
  public exportSpreadsheet(): void {
    const selected = this._transactions().filter((t) => t.selected);
    const dataset = selected.length > 0 ? selected : this._transactions();
    if (dataset.length === 0) return;

    let totalEntrees = 0;
    let totalSorties = 0;

    const rows: string[] = [
      ['RÉCONCILIATION & JOURNAL DE CAISSE TRANSIMEX', '', '', '', '', '', ''].join('\t'),
      ['Date d\'export :', new Date().toLocaleDateString('fr-FR'), '', '', '', '', ''].join('\t'),
      ['', '', '', '', '', '', ''].join('\t'),
      ['Date', 'Pièce', 'Libellé', 'Partenaire / Dossier', 'Entrée (FCFA)', 'Sortie (FCFA)', 'Solde Progressif (FCFA)'].join('\t'),
    ];

    for (const tx of dataset) {
      const entree = tx.category === 'entree' ? tx.montant : 0;
      const sortie = tx.category === 'sortie' ? Math.abs(tx.montant) : 0;
      totalEntrees += entree;
      totalSorties += sortie;

      rows.push([
        tx.date || '',
        tx.pieceComptable || '',
        tx.libelle || '',
        tx.employee || tx.partenaire || tx.noDossier || '',
        entree > 0 ? String(entree) : '',
        sortie > 0 ? String(sortie) : '',
        tx.soldeApres !== undefined && tx.soldeApres !== null ? String(tx.soldeApres) : '',
      ].join('\t'));
    }

    rows.push(['', '', '', '', '', '', ''].join('\t'));
    rows.push(['TOTAL', '', '', '', String(totalEntrees), String(totalSorties), String(totalEntrees - totalSorties)].join('\t'));

    const content = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob([content], { type: 'text/tab-separated-values;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    link.setAttribute('href', url);
    link.setAttribute('download', `feuille_de_calcul_caisse_${today}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Télécharge les pièces jointes des opérations sélectionnées
   */
  public downloadAttachments(): void {
    const selected = this._transactions().filter((t) => t.selected);
    const dataset = selected.length > 0 ? selected : this._transactions();
    
    // Génère un récapitulatif des pièces comptables en fichier texte structuré
    const lines = [
      '========================================================================',
      'BORDEREAU DE TRANSMISSION DES PIÈCES COMPTABLES DE CAISSE',
      `Date : ${new Date().toLocaleString('fr-FR')}`,
      `Nombre de transactions : ${dataset.length}`,
      '========================================================================\n',
    ];

    dataset.forEach((tx, idx) => {
      lines.push(`${idx + 1}. PIÈCE : ${tx.pieceComptable || 'N/A'}`);
      lines.push(`   Date : ${tx.date} | Statut : ${tx.status}`);
      lines.push(`   Libellé : ${tx.libelle}`);
      lines.push(`   Bénéficiaire : ${tx.employee || tx.partenaire || 'N/A'}`);
      lines.push(`   Montant : ${tx.montant} FCFA`);
      lines.push('   Justificatifs rattachés : Reçu de caisse signé / Pièce de dépense conforme.');
      lines.push('------------------------------------------------------------------------');
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `pieces_jointes_caisse_${new Date().toISOString().slice(0, 10)}.txt`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Recalcule les soldes progressifs de manière chronologique
   */
  private parseDateTimestamp(dStr?: string): number {
    if (!dStr) return 0;
    if (dStr.includes('/')) {
      const parts = dStr.split('/');
      if (parts.length === 3) {
        const time = new Date(`${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`).getTime();
        if (!isNaN(time)) return time;
      }
    }
    const time = new Date(dStr).getTime();
    return isNaN(time) ? 0 : time;
  }

  /**
   * Recalcule les soldes progressifs de manière chronologique et maintient l'ordre antéchronologique
   */
  private recalculateRunningBalances(): void {
    const current = this._transactions();
    if (current.length === 0) return;

    // Trier du plus ancien au plus récent pour calculer le solde progressif
    const chronological = [...current].sort((a, b) => {
      const timeA = this.parseDateTimestamp(a.date);
      const timeB = this.parseDateTimestamp(b.date);
      if (timeA !== timeB) return timeA - timeB;
      const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return createdA - createdB;
    });

    let balance = 0;
    const yearCounters: Record<string, number> = {};
    const updatedChronological = chronological.map((tx) => {
      balance += tx.montant;
      const yrMatch = tx.date?.includes('/')
        ? Number(tx.date.split('/')[2])
        : (tx.date?.includes('-') ? Number(tx.date.split('-')[0]) : 2026);
      const year = isNaN(yrMatch) ? 2026 : yrMatch;
      yearCounters[year] = (yearCounters[year] || 0) + 1;
      const piece = tx.pieceComptable || `CSH1/${year}/${String(yearCounters[year]).padStart(5, '0')}`;
      return { ...tx, soldeApres: balance, pieceComptable: piece };
    });

    // Remettre en ordre antéchronologique strict (le plus récent en tête)
    const antechronological = [...updatedChronological].sort((a, b) => {
      const timeA = this.parseDateTimestamp(a.date);
      const timeB = this.parseDateTimestamp(b.date);
      if (timeA !== timeB) return timeB - timeA;
      const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return createdB - createdA;
    });

    this._transactions.set(antechronological);
  }

  /**
   * Mappe une seule ligne de base de données vers le modèle applicatif
   */
  public mapSingleDbRow(row: CashierDbRow): CashierTransaction {
    const numMontant = Number(row.montant) || 0;
    return {
      id: row.id,
      pieceComptable: row.piece_comptable || undefined,
      date: this.formatDate(row.date),
      libelle: row.libelle || '',
      service: row.service || row.type_transaction || '',
      typeDescription: row.type_description || '',
      category: (row.category || (numMontant >= 0 ? 'entree' : 'sortie')) as 'entree' | 'sortie',
      status: (row.status as 'draft' | 'posted' | 'cancelled') || 'draft',
      noDossier: row.no_dossier || row.matricule_vehicule || '',
      firstName: row.first_name || '',
      employee: row.employee || '',
      partenaire: row.partenaire || row.employee || '',
      quantity: row.quantity !== null && row.quantity !== undefined ? Number(row.quantity) : undefined,
      montant: numMontant,
      soldeApres: row.solde_apres !== undefined && row.solde_apres !== null ? Number(row.solde_apres) : 0,
      selected: !!row.selected,
      createdBy: row.created_by || undefined,
      employeeId: row.employee_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Mappe les enregistrements de la base de données vers le modèle applicatif
   */
  public mapDatabaseOperations(rows: CashierDbRow[]): CashierTransaction[] {
    // 1. Trier chronologiquement (du plus ancien au plus récent) pour calculer le solde cumulé exact
    const chronological = [...rows].sort((a, b) => {
      const timeA = this.parseDateTimestamp(a.date);
      const timeB = this.parseDateTimestamp(b.date);
      if (timeA !== timeB) return timeA - timeB;
      const createdA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const createdB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return createdA - createdB;
    });

    let runningBalance = 0;
    const yearCounters: Record<string, number> = {};
    const mappedChronological = chronological.map((row) => {
      const numMontant = Number(row.montant) || 0;
      runningBalance += numMontant;

      const yrMatch = row.date?.includes('/')
        ? Number(row.date.split('/')[2])
        : (row.date?.includes('-') ? Number(row.date.split('-')[0]) : 2026);
      const year = isNaN(yrMatch) ? 2026 : yrMatch;
      yearCounters[year] = (yearCounters[year] || 0) + 1;
      const computedFallback = `CSH1/${year}/${String(yearCounters[year]).padStart(5, '0')}`;

      return {
        id: row.id,
        pieceComptable: row.piece_comptable ? String(row.piece_comptable).trim() : computedFallback,
        date: this.formatDate(row.date),
        libelle: row.libelle || '',
        service: row.service || row.type_transaction || '',
        typeDescription: row.type_description || '',
        category: (row.category || (numMontant >= 0 ? 'entree' : 'sortie')) as 'entree' | 'sortie',
        status: (row.status as 'draft' | 'posted' | 'cancelled') || 'draft',
        noDossier: row.no_dossier || row.matricule_vehicule || '',
        firstName: row.first_name || '',
        employee: row.employee || '',
        partenaire: row.partenaire || row.employee || '',
        quantity: row.quantity !== null && row.quantity !== undefined ? Number(row.quantity) : undefined,
        montant: numMontant,
        soldeApres: row.solde_apres !== undefined && row.solde_apres !== null ? Number(row.solde_apres) : runningBalance,
        selected: !!row.selected,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } as CashierTransaction;
    });

    // 2. Retourne en ordre antéchronologique strict (le plus récent en tête)
    return [...mappedChronological].sort((a, b) => {
      const timeA = this.parseDateTimestamp(a.date);
      const timeB = this.parseDateTimestamp(b.date);
      if (timeA !== timeB) return timeB - timeA;
      const createdA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const createdB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return createdB - createdA;
    });
  }

  public startAddTransaction(): void {
    this.isAddingRow.set(true);
  }

  public cancelAddTransaction(): void {
    this.isAddingRow.set(false);
  }

  public prevPage(): void {
    this._filterState.update((state) => ({
      ...state,
      pageIndex: Math.max(0, state.pageIndex - 1),
    }));
  }

  public nextPage(): void {
    const total = this.totalCount();
    const { pageIndex, pageSize } = this._filterState();
    if ((pageIndex + 1) * pageSize < total) {
      this._filterState.update((state) => ({
        ...state,
        pageIndex: state.pageIndex + 1,
      }));
    }
  }

  public setSearchQuery(query: string): void {
    this._filterState.update((state) => ({
      ...state,
      searchQuery: query,
      pageIndex: 0,
    }));
  }

  public setCategoryFilter(category: 'all' | 'entree' | 'sortie'): void {
    this._filterState.update((state) => ({
      ...state,
      categoryFilter: category,
      pageIndex: 0,
    }));
  }

  public setPageIndex(index: number): void {
    this._filterState.update((state) => ({
      ...state,
      pageIndex: Math.max(0, index),
    }));
  }

  /**
   * Modifie la taille de la page en imposant strictement un minimum de 80 lignes
   */
  public setPageSize(size: number): void {
    const validSize = Math.max(80, isNaN(size) ? 80 : Number(size));
    this._filterState.update((state) => ({
      ...state,
      pageSize: validSize,
      pageIndex: 0,
    }));
  }

  public toggleSelectTransaction(id: string): void {
    this._transactions.update((items) =>
      items.map((item) =>
        item.id === id ? { ...item, selected: !item.selected } : item
      )
    );
  }

  public toggleSelectAll(select?: boolean): void {
    const displayed = this.pagedTransactions();
    const shouldSelect = select !== undefined ? select : displayed.some((t) => !t.selected);
    const displayedIds = new Set(displayed.map((t) => t.id));
    this._transactions.update((items) =>
      items.map((item) =>
        displayedIds.has(item.id) ? { ...item, selected: shouldSelect } : item
      )
    );
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * SYNCHRONISATION EN TEMPS RÉEL (SUPABASE REALTIME WEBSOCKET)
   * ───────────────────────────────────────────────────────────────────────────
   * Écoute les événements INSERT, UPDATE, DELETE sur la table cashier_transactions
   * et met à jour instantanément le Signal _transactions sans rechargement,
   * avec réconciliation d'état automatique lors de la souscription ou reconnexion.
   */
  private async setupRealtimeSubscription(): Promise<void> {
    if (!this.isBrowser) return;

    try {
      await this.supabaseService.ensureInitialized();
      const client = this.supabaseService.supabase;
      if (!client) return;

      // Éviter les souscriptions en doublon
      if (this.realtimeChannel) {
        return;
      }

      this.realtimeChannel = client
        .channel('public:cashier_transactions')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'cashier_transactions' },
          (payload) => {
            const newRow = payload.new as CashierDbRow;
            if (!newRow || !newRow.id) return;
            const mapped = this.mapSingleDbRow(newRow);

            this._transactions.update((currentList) => {
              if (currentList.some((t) => t.id === mapped.id)) {
                return currentList;
              }
              return [mapped, ...currentList];
            });
            this.recalculateRunningBalances();
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'cashier_transactions' },
          (payload) => {
            const updatedRow = payload.new as CashierDbRow;
            if (!updatedRow || !updatedRow.id) return;
            const mapped = this.mapSingleDbRow(updatedRow);

            this._transactions.update((currentList) =>
              currentList.map((t) => (t.id === mapped.id ? { ...mapped, selected: t.selected } : t))
            );
            this.recalculateRunningBalances();
          }
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'cashier_transactions' },
          (payload) => {
            const deletedId = (payload.old as { id?: string })?.id;
            if (!deletedId) return;

            this._transactions.update((currentList) =>
              currentList.filter((t) => t.id !== deletedId)
            );
            this.recalculateRunningBalances();
          }
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            // Re-synchronisation silencieuse pour s'assurer qu'aucune transaction n'a été manquée
            // avant ou pendant l'établissement de la connexion WebSocket
            this.loadTransactions();
          } else if (status === 'CHANNEL_ERROR') {
            console.warn('Erreur sur le canal Realtime Supabase cashier_transactions, tentative de reconnexion auto...');
          } else if (status === 'TIMED_OUT') {
            console.warn('Timeout sur le canal Realtime Supabase cashier_transactions');
          }
        });
    } catch (err) {
      console.warn('Impossible d’initialiser le canal Realtime Supabase:', err);
    }
  }

  private cleanupRealtimeSubscription(): void {
    if (this.realtimeChannel && this.supabaseService.supabase) {
      try {
        this.supabaseService.supabase.removeChannel(this.realtimeChannel);
      } catch (err) {
        console.warn('Erreur lors du nettoyage du canal Realtime Supabase:', err);
      }
      this.realtimeChannel = null;
    }
  }

  public clearError(): void {
    if (this.errorTimeout) {
      clearTimeout(this.errorTimeout);
      this.errorTimeout = null;
    }
    this._error.set(null);
  }

  private formatDate(dateStr: string): string {
    return formatIsoToDisplayDate(dateStr);
  }
}
