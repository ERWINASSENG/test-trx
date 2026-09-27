import { Injectable, computed, inject, signal, effect, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { CashierService } from './cashier.service';
import { CreateJournalDto, Journal, JournalType } from '../models/journal.model';

@Injectable({
  providedIn: 'root',
})
export class JournalService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly notificationService = inject(NotificationService);
  private readonly cashierService = inject(CashierService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  // Journal natif représentant la caisse active de l'entreprise
  private readonly defaultNativeCashJournal: Journal = {
    id: 'native-caisse-principal',
    name: 'Caisse Principale',
    type: 'cash',
    type_label: 'Espèces',
    ledger_type: '',
    sequence_prefix: 'CSH1',
    default_account: '510000 Valeurs à encaisser',
    currency: 'XAF',
    is_active: true,
    selected: false,
  };

  private readonly _journals = signal<Journal[]>([]);
  private readonly _isLoading = signal<boolean>(false);
  private readonly _searchQuery = signal<string>('');
  private readonly _pageIndex = signal<number>(0);
  private readonly _pageSize = signal<number>(20);

  public readonly journals = computed(() => this._journals());
  public readonly isLoading = computed(() => this._isLoading());
  public readonly searchQuery = computed(() => this._searchQuery());
  public readonly pageIndex = computed(() => this._pageIndex());
  public readonly pageSize = computed(() => this._pageSize());

  // Liste filtrée selon la saisie utilisateur
  public readonly filteredJournals = computed(() => {
    const q = this._searchQuery().trim().toLowerCase();
    const list = this._journals();
    if (!q) return list;
    return list.filter(
      (j) =>
        j.name.toLowerCase().includes(q) ||
        (j.type_label || j.type).toLowerCase().includes(q) ||
        j.sequence_prefix.toLowerCase().includes(q) ||
        j.default_account.toLowerCase().includes(q)
    );
  });

  // Liste paginée
  public readonly pagedJournals = computed(() => {
    const list = this.filteredJournals();
    const start = this._pageIndex() * this._pageSize();
    return list.slice(start, start + this._pageSize());
  });

  // Nombre d'éléments sélectionnés
  public readonly selectedJournalsCount = computed(() => {
    return this._journals().filter((j) => j.selected).length;
  });

  // Indicateur si tous les éléments visibles sont sélectionnés
  public readonly isAllSelected = computed(() => {
    const visible = this.pagedJournals();
    return visible.length > 0 && visible.every((j) => j.selected);
  });

  // Pagination standard Odoo (ex: "01-08 / 08" ou "00-00 / 00")
  public readonly paginationLabel = computed(() => {
    const total = this.filteredJournals().length;
    if (total === 0) return '00-00 / 00';
    const start = this._pageIndex() * this._pageSize() + 1;
    const end = Math.min((this._pageIndex() + 1) * this._pageSize(), total);
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return `${pad(start)}-${pad(end)} / ${pad(total)}`;
  });

  public readonly hasPrevPage = computed(() => this._pageIndex() > 0);
  public readonly hasNextPage = computed(() => {
    return (this._pageIndex() + 1) * this._pageSize() < this.filteredJournals().length;
  });

  // Liste des journaux actifs destinés à s'afficher sous forme de cartes sur le tableau de bord
  public readonly activeJournals = computed(() =>
    this._journals().filter((j) => j.is_active)
  );

  // Permissions d'accès aux journaux
  // Seuls admin, tresorier et manager peuvent consulter les journaux
  public readonly canViewJournals = computed(() => {
    const role = this.authService.currentRole();
    return role === 'admin' || role === 'tresorier' || role === 'manager';
  });

  // Seul le trésorier et l'administrateur sont autorisés à créer ou supprimer des journaux
  public readonly canCreateJournal = computed(() => {
    const role = this.authService.currentRole();
    return role === 'admin' || role === 'tresorier';
  });

  public readonly canManageJournals = computed(() => {
    const role = this.authService.currentRole();
    return role === 'admin' || role === 'tresorier';
  });

  // Indique si l'utilisateur consulte en lecture seule (les managers)
  public readonly isManagerReadOnly = computed(() => {
    return this.authService.currentRole() === 'manager';
  });

  public getJournalById(id: string): Journal | undefined {
    return this._journals().find((j) => j.id === id);
  }

  public getJournalBalance(journalId: string): number {
    const transactions = this.cashierService.allTransactions();
    if (journalId === this.defaultNativeCashJournal.id || journalId === 'native-caisse-principal' || journalId === 'CSH1') {
      return transactions
        .filter(
          (t) =>
            (!t.journalId && !t.journal_id) ||
            t.journalId === 'native-caisse-principal' ||
            t.journal_id === 'native-caisse-principal' ||
            t.journalId === 'CSH1' ||
            t.journal_id === 'CSH1' ||
            t.pieceComptable?.startsWith('CSH1')
        )
        .reduce((sum, t) => sum + (Number(t.montant) || 0), 0);
    }
    return transactions
      .filter((t) => t.journalId === journalId || t.journal_id === journalId)
      .reduce((sum, t) => sum + (Number(t.montant) || 0), 0);
  }

  public getJournalTransactionCount(journalId: string): number {
    const transactions = this.cashierService.allTransactions();
    if (journalId === this.defaultNativeCashJournal.id || journalId === 'native-caisse-principal' || journalId === 'CSH1') {
      return transactions.filter(
        (t) =>
          (!t.journalId && !t.journal_id) ||
          t.journalId === 'native-caisse-principal' ||
          t.journal_id === 'native-caisse-principal' ||
          t.journalId === 'CSH1' ||
          t.journal_id === 'CSH1' ||
          t.pieceComptable?.startsWith('CSH1')
      ).length;
    }
    return transactions.filter((t) => t.journalId === journalId || t.journal_id === journalId).length;
  }

  constructor() {
    // Initialise avec le journal natif de caisse pour garantir qu'aucune rupture n'arrive
    this._journals.set([this.defaultNativeCashJournal]);

    if (this.isBrowser) {
      effect(() => {
        const user = this.authService.currentUser();
        if (user) {
          this.loadJournals();
        }
      });
    }
  }

  public setSearchQuery(query: string): void {
    this._searchQuery.set(query);
    this._pageIndex.set(0);
  }

  public prevPage(): void {
    if (this.hasPrevPage()) {
      this._pageIndex.update((i) => i - 1);
    }
  }

  public nextPage(): void {
    if (this.hasNextPage()) {
      this._pageIndex.update((i) => i + 1);
    }
  }

  public toggleSelect(id: string): void {
    this._journals.update((list) =>
      list.map((j) => (j.id === id ? { ...j, selected: !j.selected } : j))
    );
  }

  public toggleSelectAll(select: boolean): void {
    const visibleIds = new Set(this.pagedJournals().map((j) => j.id));
    this._journals.update((list) =>
      list.map((j) => (visibleIds.has(j.id) ? { ...j, selected: select } : j))
    );
  }

  public clearSelection(): void {
    this._journals.update((list) => list.map((j) => ({ ...j, selected: false })));
  }

  /**
   * Charge les journaux depuis l'API backend sécurisée /api/journals
   * Seuls admin, tresorier et manager y ont accès.
   */
  public async loadJournals(): Promise<void> {
    // Si l'utilisateur n'est pas autorisé à voir les journaux, restreindre au journal de caisse natif
    if (!this.canViewJournals()) {
      this._journals.set([this.defaultNativeCashJournal]);
      return;
    }

    try {
      this._isLoading.set(true);

      // Récupération du jeton d'authentification
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

      // Canal 1 : API Express Serveur-Relais (droits élevés service_role)
      if (token) {
        try {
          const res = await fetch('/api/journals', {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });

          if (res.ok) {
            const resJson = await res.json();
            const serverList = resJson.journals;
            if (Array.isArray(serverList) && serverList.length > 0) {
              const mapped: Journal[] = serverList.map((row: Record<string, unknown>) => ({
                id: String(row['id'] ?? ''),
                name: String(row['name'] ?? ''),
                type: (row['type'] as JournalType) || 'cash',
                type_label: this.getTypeLabel(String(row['type'] ?? '')),
                ledger_type: String(row['ledger_type'] ?? ''),
                sequence_prefix: String(row['sequence_prefix'] ?? ''),
                default_account: String(row['default_account'] ?? ''),
                currency: String(row['currency'] ?? 'XAF'),
                is_active: typeof row['is_active'] === 'boolean' ? row['is_active'] : true,
                selected: false,
                created_at: typeof row['created_at'] === 'string' ? row['created_at'] : undefined,
                updated_at: typeof row['updated_at'] === 'string' ? row['updated_at'] : undefined,
              }));

              const hasNative = mapped.some((j) => j.sequence_prefix === 'CSH1' || j.id === this.defaultNativeCashJournal.id);
              this._journals.set(hasNative ? mapped : [this.defaultNativeCashJournal, ...mapped]);
              return;
            } else if (Array.isArray(serverList) && serverList.length === 0) {
              this._journals.set([this.defaultNativeCashJournal]);
              return;
            }
          }
        } catch (apiErr) {
          console.warn('[JOURNAL] API Express /api/journals indisponible:', apiErr);
        }
      }

      // Canal 2 : Repli Supabase direct si disponible
      const client = this.supabaseService.supabase;
      if (client) {
        const { data, error } = await client
          .from('journals')
          .select('*')
          .order('created_at', { ascending: true });

        if (error) {
          if (this._journals().length === 0) {
            this._journals.set([this.defaultNativeCashJournal]);
          }
          return;
        }

        if (data && data.length > 0) {
          const mapped: Journal[] = data.map((row: Record<string, unknown>) => ({
            id: String(row['id'] ?? ''),
            name: String(row['name'] ?? ''),
            type: (row['type'] as JournalType) || 'cash',
            type_label: this.getTypeLabel(String(row['type'] ?? '')),
            ledger_type: String(row['ledger_type'] ?? ''),
            sequence_prefix: String(row['sequence_prefix'] ?? ''),
            default_account: String(row['default_account'] ?? ''),
            currency: String(row['currency'] ?? 'XAF'),
            is_active: typeof row['is_active'] === 'boolean' ? row['is_active'] : true,
            selected: false,
            created_at: typeof row['created_at'] === 'string' ? row['created_at'] : undefined,
            updated_at: typeof row['updated_at'] === 'string' ? row['updated_at'] : undefined,
          }));

          const hasNative = mapped.some((j) => j.sequence_prefix === 'CSH1' || j.id === this.defaultNativeCashJournal.id);
          this._journals.set(hasNative ? mapped : [this.defaultNativeCashJournal, ...mapped]);
        } else {
          this._journals.set([this.defaultNativeCashJournal]);
        }
      }
    } catch (err) {
      console.warn('Fallback local pour les journaux comptables:', err);
      if (this._journals().length === 0) {
        this._journals.set([this.defaultNativeCashJournal]);
      }
    } finally {
      this._isLoading.set(false);
    }
  }

  /**
   * Enregistre un nouveau journal comptable via l'API sécurisée /api/journals
   * Strictement réservé à l'administrateur et au trésorier.
   */
  public async createJournal(dto: CreateJournalDto): Promise<Journal | null> {
    if (!this.canCreateJournal()) {
      this.notificationService.error(
        'Seul le trésorier et l’administrateur sont autorisés à créer de nouveaux journaux.',
        'Action non autorisée'
      );
      return null;
    }

    const payload = {
      name: dto.name.trim(),
      type: dto.type,
      ledger_type: dto.ledger_type || '',
      sequence_prefix: dto.sequence_prefix.trim().toUpperCase(),
      default_account: dto.default_account.trim(),
      currency: dto.currency || 'XAF',
      is_active: dto.is_active ?? true,
    };

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

    // Sauvegarde via API Express
    if (token) {
      try {
        const res = await fetch('/api/journals', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        const resData = await res.json();
        if (res.ok && resData.journal) {
          const row = resData.journal;
          const inserted: Journal = {
            id: String(row.id),
            name: String(row.name),
            type: (row.type as JournalType) || payload.type,
            type_label: this.getTypeLabel(String(row.type || payload.type)),
            ledger_type: String(row.ledger_type || ''),
            sequence_prefix: String(row.sequence_prefix),
            default_account: String(row.default_account),
            currency: String(row.currency || 'XAF'),
            is_active: typeof row.is_active === 'boolean' ? row.is_active : true,
            selected: false,
            created_at: String(row.created_at || new Date().toISOString()),
          };

          this._journals.update((list) => [...list, inserted]);
          this.notificationService.success(`Le journal « ${inserted.name} » a été créé avec succès.`, 'Journal créé');
          return inserted;
        } else {
          const errMsg = resData.error || 'Impossible de créer le journal.';
          this.notificationService.error(errMsg, 'Échec de création');
          return null;
        }
      } catch (err: unknown) {
        console.error('Erreur API création journal:', err);
        this.notificationService.error('Erreur de communication avec le serveur.', 'Échec réseau');
        return null;
      }
    }

    this.notificationService.error('Session expirée ou non autorisée.', 'Authentification requise');
    return null;
  }

  /**
   * Supprime les journaux sélectionnés (protège le journal natif de caisse)
   * Strictement réservé à l'administrateur et au trésorier.
   */
  public async deleteSelectedJournals(): Promise<boolean> {
    if (!this.canManageJournals()) {
      this.notificationService.error(
        'Seul le trésorier et l’administrateur sont autorisés à supprimer des journaux.',
        'Action non autorisée'
      );
      return false;
    }

    const selected = this._journals().filter((j) => j.selected);
    if (selected.length === 0) return false;

    // Protection absolue du journal natif de caisse
    const toDelete = selected.filter(
      (j) => j.id !== this.defaultNativeCashJournal.id && j.sequence_prefix !== 'CSH1'
    );

    if (toDelete.length === 0) {
      this.notificationService.warning('Le journal de Caisse Principale est un journal système protégé et ne peut pas être supprimé.', 'Action impossible');
      this.clearSelection();
      return false;
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

    let deletedCount = 0;
    const deleteIds: string[] = [];

    for (const journal of toDelete) {
      if (token) {
        try {
          const res = await fetch(`/api/journals/${journal.id}`, {
            method: 'DELETE',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });
          if (res.ok) {
            deletedCount++;
            deleteIds.push(journal.id);
          } else {
            const json = await res.json();
            this.notificationService.error(json.error || `Impossible de supprimer ${journal.name}`, 'Erreur suppression');
          }
        } catch {
          // Ignorer erreur unitaire
        }
      }
    }

    if (deleteIds.length > 0) {
      this._journals.update((list) => list.filter((j) => !deleteIds.includes(j.id)));
      this.notificationService.success(`${deletedCount} journal(s) supprimé(s) avec succès.`, 'Suppression terminée');
      return true;
    }

    return false;
  }

  /**
   * Exporte les journaux (sélectionnés ou tous) en CSV UTF-8
   */
  public exportJournals(onlySelected = false): void {
    const items = onlySelected
      ? this._journals().filter((j) => j.selected)
      : this.filteredJournals();

    if (items.length === 0) {
      this.notificationService.info('Aucun journal à exporter.', 'Export');
      return;
    }

    const headers = ['Nom du journal', 'Type', 'Grand livre', 'Préfixe Séquence', 'Compte par défaut', 'Statut'];
    const rows = items.map((j) => [
      `"${j.name.replace(/"/g, '""')}"`,
      `"${(j.type_label || j.type).replace(/"/g, '""')}"`,
      `"${(j.ledger_type || '').replace(/"/g, '""')}"`,
      `"${j.sequence_prefix}"`,
      `"${(j.default_account || '').replace(/"/g, '""')}"`,
      `"${j.is_active ? 'Actif' : 'Inactif'}"`,
    ]);

    const csvContent = '\uFEFF' + [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `journaux_comptables_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);

    this.notificationService.success(`${items.length} journal(s) exporté(s) avec succès.`, 'Export terminé');
  }

  /**
   * Active ou désactive un journal
   */
  public async toggleActive(id: string): Promise<void> {
    const target = this._journals().find((j) => j.id === id);
    if (!target) return;

    const updatedState = !target.is_active;
    this._journals.update((list) =>
      list.map((j) => (j.id === id ? { ...j, is_active: updatedState } : j))
    );

    const client = this.supabaseService.supabase;
    if (client && !id.startsWith('native-')) {
      try {
        await client.from('journals').update({ is_active: updatedState }).eq('id', id);
      } catch (e) {
        console.warn('Erreur mise à jour statut journal:', e);
      }
    }
  }

  public getTypeLabel(type: string): string {
    switch (type) {
      case 'cash':
        return 'Espèces';
      case 'bank':
        return 'Banque';
      case 'sale':
        return 'Ventes';
      case 'purchase':
        return 'Achats';
      case 'general':
      case 'divers':
        return 'Divers';
      default:
        return type;
    }
  }
}
