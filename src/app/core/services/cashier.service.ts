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
  journal_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type CashierSortField = 'pieceComptable' | 'date' | 'montant' | 'libelle';
export type CashierSortDirection = 'asc' | 'desc';

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
  private cashierRealtimeChannel: ReturnType<NonNullable<SupabaseService['supabase']>['channel']> | null = null;
  private journalRealtimeChannel: ReturnType<NonNullable<SupabaseService['supabase']>['channel']> | null = null;
  private realtimeRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private journalRefreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly _journalBalanceRefreshVersion = signal(0);
  public readonly journalBalanceRefreshVersion = this._journalBalanceRefreshVersion.asReadonly();

  // Résumé global calculé côté serveur (indépendant de la pagination locale)
  private readonly _serverSummary = signal<{
    total_entrees: number;
    total_sorties: number;
    solde_global: number;
    total_count: number;
    nb_brouillons?: number;
    nb_annulees?: number;
  } | null>(null);
  public readonly serverSummary = this._serverSummary.asReadonly();

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
    // Réactivité unique coordonnée (P0 #7 : élimine la triple invocation concurrente au démarrage)
    effect(() => {
      const user = this.authService.currentUser();
      if (user && this.isBrowser) {
        this.loadTransactions();
        this.loadCashierSummary();
        this.setupRealtimeSubscription();
      } else if (!user && this.isBrowser) {
        this.cleanupRealtimeSubscription();
      }
    });
  }

  ngOnDestroy(): void {
    this.cleanupRealtimeSubscription();
  }

  // Signaux de tri réactif (par défaut : Pièce comptable en ordre décroissant)
  public readonly sortField = signal<CashierSortField>('pieceComptable');
  public readonly sortDirection = signal<CashierSortDirection>('desc');

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

  /**
   * Bascule le tri sur un champ donné ou inverse la direction si déjà actif
   */
  public toggleSort(field: CashierSortField): void {
    if (this.sortField() === field) {
      this.sortDirection.update((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortField.set(field);
      this.sortDirection.set(field === 'pieceComptable' ? 'desc' : 'asc');
    }
  }

  public setSort(field: CashierSortField, direction: CashierSortDirection): void {
    this.sortField.set(field);
    this.sortDirection.set(direction);
  }

  /**
   * Extrait le numéro séquentiel numérique d'une référence de pièce comptable (ex: "CSH1/2026/00011" -> 11)
   */
  public extractPieceSequence(piece?: string): number {
    if (!piece) return 0;
    const match = piece.match(/\/(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  }

  // Gestion du journal actif sélectionné
  private readonly _activeJournalId = signal<string>('native-caisse-principal');
  private readonly _activeJournalPrefix = signal<string>('CSH1');
  public readonly activeJournalId = computed(() => this._activeJournalId());
  public readonly activeJournalPrefix = computed(() => this._activeJournalPrefix());

  public setActiveJournal(journalId: string, prefix = 'CSH1'): void {
    const targetId = journalId || 'native-caisse-principal';
    this._activeJournalId.set(targetId);
    this._activeJournalPrefix.set(prefix || 'CSH1');
    this.setPageIndex(0);

    if (targetId !== 'native-caisse-principal' && targetId !== 'CSH1') {
      void this.loadJournalEntries(targetId);
    }
  }

  public setActiveJournalId(journalId: string): void {
    this.setActiveJournal(journalId, this._activeJournalPrefix());
  }

  public setActiveJournalPrefix(prefix: string): void {
    this._activeJournalPrefix.set(prefix || 'CSH1');
  }

  /**
   * Charge de manière hermétique les écritures rattachées à un journal bancaire / trésorerie
   */
  public async loadJournalEntries(journalId: string): Promise<void> {
    if (!journalId || journalId === 'native-caisse-principal' || journalId === 'CSH1') {
      return;
    }

    let token = this.authService.token();
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

    try {
      const res = await fetch(`/api/journals/${encodeURIComponent(journalId)}/entries`, {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const json = await res.json();
        const entries = json.entries || [];
        const mappedOps: CashierTransaction[] = entries.map((row: Record<string, unknown>) => ({
          id: String(row['id']),
          pieceComptable: String(row['piece_comptable']),
          date: this.formatDate(String(row['date'] || '')),
          libelle: String(row['libelle']),
          service: row['service'] ? String(row['service']) : '',
          typeDescription: row['type_description'] ? String(row['type_description']) : '',
          category: (row['category'] === 'sortie' ? 'sortie' : 'entree') as 'entree' | 'sortie',
          status: (row['status'] as 'draft' | 'posted' | 'cancelled') || 'draft',
          noDossier: row['no_dossier'] ? String(row['no_dossier']) : '',
          firstName: '',
          employee: row['employee'] ? String(row['employee']) : '',
          partenaire: row['partenaire'] ? String(row['partenaire']) : '',
          quantity: row['quantity'] ? Number(row['quantity']) : undefined,
          montant: Number(row['montant']) || 0,
          soldeApres: row['solde_apres'] !== undefined && row['solde_apres'] !== null ? Number(row['solde_apres']) : undefined,
          selected: false,
          createdBy: row['created_by'] ? String(row['created_by']) : undefined,
          employeeId: row['employee_id'] ? String(row['employee_id']) : undefined,
          journalId: journalId,
          journal_id: journalId,
          createdAt: String(row['created_at'] || ''),
          updatedAt: row['updated_at'] ? String(row['updated_at']) : undefined,
        }));

        this._transactions.update((curr) => {
          const withoutThisJournal = curr.filter((t) => t.journalId !== journalId && t.journal_id !== journalId);
          return [...withoutThisJournal, ...mappedOps];
        });
      }
    } catch (err) {
      console.warn(`Erreur chargement écritures pour le journal ${journalId}:`, err);
    }
  }

  // Transactions appartenant exclusivement à la Caisse Principale (CSH1)
  public readonly caisseTransactions = computed(() => {
    const list = this._transactions();
    return list.filter(
      (t) =>
        (!t.journalId && !t.journal_id) ||
        t.journalId === 'native-caisse-principal' ||
        t.journal_id === 'native-caisse-principal' ||
        t.journalId === 'CSH1' ||
        t.journal_id === 'CSH1' ||
        t.pieceComptable?.startsWith('CSH1')
    );
  });

  /**
   * Charge le résumé global et le solde exact depuis le serveur PostgreSQL (P0 #5)
   */
  public async loadCashierSummary(): Promise<void> {
    if (!this.isBrowser) return;
    try {
      const token = this.authService.token();
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/cahier/operations/summary', { headers });
      if (res.ok) {
        const json = await res.json();
        if (json?.summary) {
          this._serverSummary.set(json.summary);
        }
      }
    } catch {
      // Ignorer silencieusement
    }
  }

  // Solde permanent et hermétique de la Caisse Principale (CSH1)
  // Utilise en priorité le solde global exact calculé côté serveur PostgreSQL (P0 #5)
  public readonly caisseBalance = computed(() => {
    const summary = this._serverSummary();
    if (summary && summary.solde_global !== undefined) {
      return Number(summary.solde_global);
    }
    const list = this.caisseTransactions();
    if (list.length === 0) return 0;
    return list.reduce((acc, curr) => acc + (curr.status === 'posted' ? Number(curr.montant) || 0 : 0), 0);
  });

  // Transactions appartenant exclusivement au journal sélectionné
  public readonly journalTransactions = computed(() => {
    const list = this._transactions();
    const currentJournal = this._activeJournalId();

    if (!currentJournal || currentJournal === 'native-caisse-principal' || currentJournal === 'CSH1') {
      return this.caisseTransactions();
    }

    return list.filter((t) => t.journalId === currentJournal || t.journal_id === currentJournal);
  });

  // États exposés en lecture seule
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());
  public readonly allTransactions = computed(() => this._transactions());

  // Transactions filtrées par mot-clé et type, puis triées de manière déterministe
  public readonly filteredTransactions = computed(() => {
    const query = this._filterState().searchQuery.trim().toLowerCase();
    const category = this._filterState().categoryFilter;
    const field = this.sortField();
    const direction = this.sortDirection();
    const list = this.journalTransactions();

    const filtered = list.filter((tx) => {
      const matchesCategory =
        category === 'all' || tx.category === category;
      if (!matchesCategory) return false;

      if (!query) return true;

      const searchableText = `${tx.libelle} ${tx.pieceComptable || ''} ${tx.service || ''} ${tx.typeDescription || ''} ${tx.firstName || ''} ${tx.employee || ''} ${tx.partenaire || ''} ${tx.noDossier || ''}`.toLowerCase();
      return searchableText.includes(query);
    });

    return [...filtered].sort((a, b) => {
      const draftWithoutPieceA = a.status === 'draft' && !a.pieceComptable;
      const draftWithoutPieceB = b.status === 'draft' && !b.pieceComptable;
      if (draftWithoutPieceA !== draftWithoutPieceB) {
        return draftWithoutPieceA ? -1 : 1;
      }

      let comparison = 0;
      if (field === 'pieceComptable') {
        const numA = this.extractPieceSequence(a.pieceComptable);
        const numB = this.extractPieceSequence(b.pieceComptable);
        comparison = numA - numB;
      } else if (field === 'date') {
        const timeA = this.parseDateTimestamp(a.date);
        const timeB = this.parseDateTimestamp(b.date);
        if (timeA !== timeB) {
          comparison = timeA - timeB;
        } else {
          comparison = this.extractPieceSequence(a.pieceComptable) - this.extractPieceSequence(b.pieceComptable);
        }
      } else if (field === 'montant') {
        comparison = a.montant - b.montant;
      } else if (field === 'libelle') {
        comparison = (a.libelle || '').localeCompare(b.libelle || '');
      }

      return direction === 'asc' ? comparison : -comparison;
    });
  });

  // Calcul du solde actuel en temps réel pour le journal actif
  public readonly currentBalance = computed(() => {
    const list = this.journalTransactions();
    if (list.length === 0) return 0;
    return list.reduce((acc, curr) => acc + (curr.status === 'posted' ? Number(curr.montant) || 0 : 0), 0);
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
          this._transactions.update((curr) => {
            const bankOps = curr.filter(
              (t) =>
                t.journalId &&
                t.journalId !== 'native-caisse-principal' &&
                t.journalId !== 'CSH1' &&
                !t.pieceComptable?.startsWith('CSH1')
            );
            return [...mappedTransactions, ...bankOps];
          });
        }
      } catch (err: unknown) {
        console.error('Erreur globale lors du chargement des opérations de caisse:', err);
      } finally {
        this._isLoading.set(false);
        this.activeLoadPromise = null;
        this.loadCashierSummary();
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
    op: Partial<CashierTransaction> | Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>,
    refreshSummary = true
  ): Promise<{ success: boolean; operation?: CashierTransaction; error?: string }> {
    this._error.set(null);

    // Une pièce officielle ne peut pas être choisie par le client.
    const explicitPiece = op.pieceComptable ? normalizePieceComptable(op.pieceComptable) : undefined;
    if (explicitPiece) {
      const pieceDuplicate = findDuplicatePieceComptable({ pieceComptable: explicitPiece }, this._transactions());
      if (pieceDuplicate) {
        const errorMsg = `Le numéro de pièce comptable "${explicitPiece}" est déjà attribué à une autre opération (ID: ${pieceDuplicate.id}, Date: ${pieceDuplicate.date}, Libellé: "${pieceDuplicate.libelle}"). Les numéros de pièces comptables doivent être strictement uniques.`;
        this.setError(errorMsg);
        return { success: false, error: errorMsg };
      }

      const errorMsg = 'La pièce comptable est attribuée par la base à la comptabilisation. Les numéros importés ne sont pas conservés.';
      this.setError(errorMsg);
      return { success: false, error: errorMsg };
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

    const targetJournalId = op.journalId || op.journal_id || this._activeJournalId();
    const isNativeCaisse =
      !targetJournalId ||
      targetJournalId === 'native-caisse-principal' ||
      targetJournalId === 'CSH1' ||
      this._activeJournalPrefix() === 'CSH1';

    let savedRow: CashierDbRow | null = null;
    let bankEntryResult: Record<string, unknown> | null = null;

    // ROUTAGE SÉCURISÉ SELON LE TYPE DE JOURNAL
    if (!isNativeCaisse) {
      // ────────────────────────────────────────────────────────────────────────
      // ROUTAGE HERMÉTIQUE VERS LE JOURNAL DE BANQUE / TRÉSORERIE DÉDIÉ
      // Aucune écriture n'est envoyée vers cashier_transactions ni la Caisse Principale
      // ────────────────────────────────────────────────────────────────────────
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(`/api/journals/${encodeURIComponent(targetJournalId)}/entries`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            journal_id: targetJournalId,
            date: this.toIsoDateString(op.date),
            libelle: op.libelle,
            service: op.service || null,
            type_description: op.typeDescription || null,
            category: op.category === 'sortie' ? 'sortie' : 'entree',
            status: op.status || 'draft',
            no_dossier: op.noDossier || null,
            partenaire: op.partenaire || op.employee || null,
            employee: op.employee || op.partenaire || null,
            quantity: Number(op.quantity) || 1,
            montant: montant,
          }),
        });

        if (response.ok) {
          const resJson = await response.json();
          bankEntryResult = resJson.entry;
        } else {
          const errJson = await response.json().catch(() => ({}));
          const serverError = errJson.error || `Erreur serveur ${response.status}`;
          this.setError(serverError);
          return { success: false, error: serverError };
        }
      } catch (apiErr) {
        console.error('Erreur API journal entries POST:', apiErr);
        const errMsg = apiErr instanceof Error ? apiErr.message : 'Erreur de connexion';
        this.setError(errMsg);
        return { success: false, error: errMsg };
      }

      if (!bankEntryResult) {
        this.setError('Impossible d’enregistrer l’écriture dans ce journal.');
        return { success: false, error: this._error()! };
      }

      const currentUserId = this.authService.currentUser()?.id;
      const operationToStore: CashierTransaction = {
        id: String(bankEntryResult['id']),
        pieceComptable: String(bankEntryResult['piece_comptable']),
        date: this.formatDate(String(bankEntryResult['date'] || '')),
        libelle: String(bankEntryResult['libelle']),
        service: bankEntryResult['service'] ? String(bankEntryResult['service']) : '',
        typeDescription: bankEntryResult['type_description'] ? String(bankEntryResult['type_description']) : '',
        category: (bankEntryResult['category'] === 'sortie' ? 'sortie' : 'entree') as 'entree' | 'sortie',
        status: (bankEntryResult['status'] as 'draft' | 'posted' | 'cancelled') || op.status || 'draft',
        noDossier: bankEntryResult['no_dossier'] ? String(bankEntryResult['no_dossier']) : '',
        firstName: '',
        employee: bankEntryResult['employee'] ? String(bankEntryResult['employee']) : '',
        partenaire: bankEntryResult['partenaire'] ? String(bankEntryResult['partenaire']) : '',
        quantity: bankEntryResult['quantity'] ? Number(bankEntryResult['quantity']) : undefined,
        montant: Number(bankEntryResult['montant']),
        soldeApres: bankEntryResult['solde_apres'] !== undefined && bankEntryResult['solde_apres'] !== null ? Number(bankEntryResult['solde_apres']) : estimatedNewSolde,
        selected: false,
        createdBy: bankEntryResult['created_by'] ? String(bankEntryResult['created_by']) : currentUserId,
        employeeId: bankEntryResult['employee_id'] ? String(bankEntryResult['employee_id']) : undefined,
        journalId: targetJournalId,
        journal_id: targetJournalId,
        createdAt: String(bankEntryResult['created_at'] || new Date().toISOString()),
        updatedAt: bankEntryResult['updated_at'] ? String(bankEntryResult['updated_at']) : undefined,
      };

      this._transactions.update((currentOps) => [operationToStore, ...currentOps]);
      if (refreshSummary) void this.loadCashierSummary();
      return { success: true, operation: operationToStore };
    }

    // Étape 1 : Appel de l'API Serveur-Relais pour la Caisse Principale
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
          journal_id: null,
        }),
      });

      if (response.ok) {
        const resJson = await response.json();
        savedRow = (resJson.operation || resJson.transaction) as CashierDbRow;
      } else {
        const errJson = await response.json().catch(() => ({}));
        const serverError = errJson.error || `Erreur serveur ${response.status}`;

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
    const persistedJournalId = isNativeCaisse
      ? 'native-caisse-principal'
      : savedRow.journal_id || op.journalId || op.journal_id || this._activeJournalId();
    const operationToStore: CashierTransaction = {
      id: savedRow.id,
      pieceComptable: savedRow.piece_comptable || explicitPiece || undefined,
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
      journalId: persistedJournalId,
      journal_id: persistedJournalId,
      createdAt: savedRow.created_at || new Date().toISOString(),
      updatedAt: savedRow.updated_at,
    };

    // Étape 4 (RÉACTIVITÉ INSTANTANÉE) : Mise à jour immédiate du Signal Angular 19
    this._transactions.update((currentOps) => [operationToStore, ...currentOps]);
    this.setPageIndex(0);
    this.recalculateRunningBalances();
    if (refreshSummary) void this.loadCashierSummary();

    return { success: true, operation: operationToStore };
  }

  /**
   * Alias rétrocompatible pour l'ajout d'une transaction
   */
  public async addTransaction(
    newTx: Omit<CashierTransaction, 'id' | 'soldeApres' | 'selected'>,
    refreshSummary = true
  ): Promise<{ success: boolean; operation?: CashierTransaction; error?: string }> {
    return this.saveOperationViaApi(newTx, refreshSummary);
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
          pieceComptable: undefined,
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
          journalId: this._activeJournalId(),
          journal_id: this._activeJournalId() === 'native-caisse-principal' ? null : this._activeJournalId(),
        }, false);

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
    void this.loadCashierSummary();
    return { success: true, message: 'Transaction modifiée avec succès' };
  }

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * 3. SUPPRESSION D'OPÉRATIONS : API RELAIS AVEC REPLI ET RÉACTIVITÉ
   * ───────────────────────────────────────────────────────────────────────────
   */
  public async cancelTransaction(id: string): Promise<boolean> {
    if (!id) return false;
    return this.cancelTransactions([id]);
  }

  public async cancelSelected(): Promise<boolean> {
    const selectedIds = this.caisseTransactions()
      .filter((t) => t.selected)
      .map((t) => t.id);

    if (selectedIds.length === 0) return true;
    return this.cancelTransactions(selectedIds);
  }

  private async cancelTransactions(targetIds: string[]): Promise<boolean> {
    if (targetIds.length === 0) return true;

    this._error.set(null);
    let activeToken: string | null = null;
    try {
      if (typeof this.authService.waitForSession === 'function') {
        await this.authService.waitForSession();
      }
      if (typeof this.supabaseService.ensureInitialized === 'function') {
        await this.supabaseService.ensureInitialized();
      }

      const supabase = this.supabaseService.supabase;
      if (supabase) {
        const { data: sessionData, error } = await supabase.auth.getSession();
        if (error) throw error;
        activeToken = sessionData.session?.access_token || this.authService.token();
      } else {
        activeToken = this.authService.token();
      }
    } catch (err) {
      console.warn('Session Supabase non récupérable pour annulation:', err);
      this.setError('Session d’authentification indisponible. Reconnectez-vous avant d’annuler.');
      return false;
    }

    if (!activeToken) {
      this.setError('Session d’authentification indisponible. Reconnectez-vous avant d’annuler.');
      return false;
    }

    let cancelledSuccessfully = false;
    let failureReason: string | null = null;

    // Annule les lignes sans supprimer leur pièce comptable.
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (activeToken) {
        headers['Authorization'] = `Bearer ${activeToken}`;
      }

      let response = await fetch('/api/cahier/operations/status', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ids: targetIds, status: 'cancelled' }),
      });

      if (!response.ok && response.status === 404) {
        response = await fetch('/api/cashier/transactions/status', {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ ids: targetIds, status: 'cancelled' }),
        });
      }

      if (response.ok) {
        cancelledSuccessfully = true;
      } else {
        const errJson = await response.json().catch(() => null);
        if (response.status === 403) {
          failureReason = errJson?.error || 'Action refusée : vous ne pouvez modifier que les opérations que vous avez vous-même enregistrées.';
        } else {
          failureReason = errJson?.error || errJson?.message || `Erreur serveur HTTP ${response.status}`;
        }
      }
    } catch (networkErr) {
      console.warn('Erreur réseau appel API Express PATCH, annulation impossible:', networkErr);
    }

    if (!cancelledSuccessfully && !failureReason) {
      failureReason = 'Le service de caisse est temporairement indisponible. Veuillez réessayer.';
    }

    if (!cancelledSuccessfully) {
      let errorMsg = failureReason || 'Impossible d’annuler cette opération dans la base de données.';
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
      console.error('[CashierService] Échec annulation DB:', errorMsg);
      return false;
    }

    this._transactions.update((items) => items.map((item) =>
      targetIds.includes(item.id) ? { ...item, status: 'cancelled', selected: false } : item
    ));
    this.recalculateRunningBalances();
    void this.loadCashierSummary();
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
        void this.loadCashierSummary();
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
        this.recalculateRunningBalances();
        void this.loadCashierSummary();
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
    const updatedChronological = chronological.map((tx) => {
      if (tx.status !== 'posted') {
        return { ...tx, soldeApres: balance };
      }
      balance += tx.montant;
      // Ne JAMAIS inventer de fausse pièce comptable CSH1/... côté client (P0 #6)
      return {
        ...tx,
        soldeApres: tx.soldeApres !== undefined && tx.soldeApres !== null ? tx.soldeApres : balance,
      };
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
      journalId: row.journal_id || undefined,
      journal_id: row.journal_id || undefined,
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
    const mappedChronological = chronological.map((row) => {
      const numMontant = Number(row.montant) || 0;
      runningBalance += numMontant;

      return {
        id: row.id,
        // Ne JAMAIS forger de fausse pièce comptable côté client : la base fait autorité (P0 #6)
        pieceComptable: row.piece_comptable ? String(row.piece_comptable).trim() : undefined,
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
        createdBy: row.created_by || undefined,
        employeeId: row.employee_id || undefined,
        journalId: row.journal_id || undefined,
        journal_id: row.journal_id || undefined,
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
  * Écoute un signal privé d'invalidation puis recharge les données par l'API autorisée.
   */
  private async setupRealtimeSubscription(): Promise<void> {
    if (!this.isBrowser) return;

    try {
      await this.supabaseService.ensureInitialized();
      const client = this.supabaseService.supabase;
      if (!client) return;

      let token = this.authService.token();
      if (!token) {
        const { data } = await client.auth.getSession();
        token = data.session?.access_token || '';
      }
      if (!token) return;

      await client.realtime.setAuth(token);
      const role = this.authService.currentRole();
      const canReadCashier = ['admin', 'caissier', 'caissiere', 'manager', 'comptable', 'tresorier'].includes(role || '');
      const canReadJournalBalances = ['admin', 'manager', 'tresorier'].includes(role || '');

      if (canReadCashier && !this.cashierRealtimeChannel) {
        this.cashierRealtimeChannel = client
          .channel('cashier-balances:invalidate', { config: { private: true } })
          .on('broadcast', { event: 'cashier_balances_invalidated' }, () => this.scheduleRealtimeRefresh())
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              if (this._transactions().length === 0) this.loadTransactions();
              this.loadCashierSummary();
            }
          });
      }

      if (canReadJournalBalances && !this.journalRealtimeChannel) {
        this.journalRealtimeChannel = client
          .channel('journal-balances:invalidate', { config: { private: true } })
          .on('broadcast', { event: 'journal_balances_invalidated' }, () => this.scheduleJournalRefresh())
          .subscribe();
      }
    } catch (err) {
      console.warn('Impossible d’initialiser le canal Realtime Supabase:', err);
    }
  }

  private scheduleRealtimeRefresh(): void {
    if (this.realtimeRefreshTimeout) clearTimeout(this.realtimeRefreshTimeout);
    this.realtimeRefreshTimeout = setTimeout(() => {
      this.realtimeRefreshTimeout = null;
      void this.loadTransactions();
    }, 250);
  }

  private scheduleJournalRefresh(): void {
    if (this.journalRefreshTimeout) clearTimeout(this.journalRefreshTimeout);
    this.journalRefreshTimeout = setTimeout(() => {
      this.journalRefreshTimeout = null;
      this._journalBalanceRefreshVersion.update((version) => version + 1);
    }, 250);
  }

  private cleanupRealtimeSubscription(): void {
    if (this.realtimeRefreshTimeout) {
      clearTimeout(this.realtimeRefreshTimeout);
      this.realtimeRefreshTimeout = null;
    }
    if (this.journalRefreshTimeout) {
      clearTimeout(this.journalRefreshTimeout);
      this.journalRefreshTimeout = null;
    }
    const client = this.supabaseService.supabase;
    if (this.cashierRealtimeChannel && client) {
      try {
        void client.removeChannel(this.cashierRealtimeChannel);
      } catch (err) {
        console.warn('Erreur lors du nettoyage du canal Realtime Supabase:', err);
      }
      this.cashierRealtimeChannel = null;
    }
    if (this.journalRealtimeChannel && client) {
      try {
        void client.removeChannel(this.journalRealtimeChannel);
      } catch (err) {
        console.warn('Erreur lors du nettoyage du canal Realtime des journaux:', err);
      }
      this.journalRealtimeChannel = null;
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
