import { Injectable, computed, inject, signal } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { CashierService } from './cashier.service';
import { AccessControlService } from './access-control.service';
import { CreateJournalDto, Journal, JournalType, UpdateJournalDto } from '../models/journal.model';
import { getApiErrorMessage } from '../utils/api-error.util';

@Injectable({
  providedIn: 'root',
})
export class JournalService {
  private readonly supabaseService = inject(SupabaseService);
  private readonly authService = inject(AuthService);
  private readonly notificationService = inject(NotificationService);
  private readonly cashierService = inject(CashierService);
  private readonly accessControl = inject(AccessControlService);

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

  public readonly canViewJournals = computed(() => {
    return this.accessControl.hasPermission('journals.read');
  });

  public readonly canCreateJournal = computed(() => {
    return this.accessControl.hasPermission('journals.create');
  });

  public readonly canUpdateJournal = computed(() => {
    return this.accessControl.hasPermission('journals.update');
  });

  public readonly canDeleteJournal = computed(() => {
    return this.accessControl.hasPermission('journals.delete');
  });

  public readonly isReadOnly = computed(() => {
    return this.canViewJournals() && !this.canUpdateJournal();
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
      const requestedUserId = this.authService.currentUser()?.id ?? null;

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

          const resJson = await res.json().catch(() => null);
          if (res.ok) {
            if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) return;
            if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) return;
            const serverList = resJson?.journals;
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
                created_by: typeof row['created_by'] === 'string' ? row['created_by'] : undefined,
                created_at: typeof row['created_at'] === 'string' ? row['created_at'] : undefined,
                updated_at: typeof row['updated_at'] === 'string' ? row['updated_at'] : undefined,
              }));

              const hasNative = mapped.some((j) => j.sequence_prefix === 'CSH1' || j.id === this.defaultNativeCashJournal.id);
              this._journals.set(hasNative ? mapped : [this.defaultNativeCashJournal, ...mapped]);
              return;
            } else if (Array.isArray(serverList) && serverList.length === 0) {
              this._journals.set([this.defaultNativeCashJournal]);
              return;
            } else {
              this.notificationService.error('Le serveur a renvoyé une liste de journaux invalide.', 'Chargement impossible');
            }
          } else {
            this.notificationService.error(
              getApiErrorMessage(resJson, `Impossible de charger les journaux (erreur HTTP ${res.status}).`),
              'Chargement impossible'
            );
          }
        } catch (apiErr) {
          console.warn('[JOURNAL] API Express /api/journals indisponible:', apiErr);
          this.notificationService.error(
            apiErr instanceof TypeError
              ? 'Connexion au service des journaux impossible. Vérifiez votre connexion puis réessayez.'
              : 'Une erreur est survenue lors du chargement des journaux.',
            'Chargement impossible'
          );
        }
      } else {
        this.notificationService.error('Votre session a expiré. Reconnectez-vous pour charger les journaux.', 'Authentification requise');
      }

      // The server is the authorization boundary; a failed response must not
      // fall back to a direct browser query that could bypass it.
      this._journals.set([this.defaultNativeCashJournal]);
    } catch (err) {
      console.error('Impossible de charger les journaux via l’API sécurisée:', err);
      this.notificationService.error('Une erreur est survenue lors du chargement des journaux.', 'Chargement impossible');
      this._journals.set([this.defaultNativeCashJournal]);
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
        'Tu ne disposes pas de la permission nécessaire pour créer des journaux.',
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

        const resData = await res.json().catch(() => null);
        if (res.ok && resData?.journal) {
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
          const errMsg = getApiErrorMessage(
            resData,
            `Impossible de créer le journal${res.ok ? ' : réponse serveur invalide' : ` (erreur HTTP ${res.status})`}.`
          );
          this.notificationService.error(errMsg, 'Échec de création');
          return null;
        }
      } catch (err: unknown) {
        console.error('Erreur API création journal:', err);
        this.notificationService.error(
          err instanceof TypeError
            ? 'Connexion au service des journaux impossible pour créer le journal. Vérifiez votre connexion puis réessayez.'
            : 'Une erreur est survenue lors de la création du journal.',
          'Échec de création'
        );
        return null;
      }
    }

    this.notificationService.error('Session expirée ou non autorisée.', 'Authentification requise');
    return null;
  }

  /**
   * Modifie un journal comptable existant via l'API sécurisée /api/journals/:id
   * Strictement réservé à l'administrateur et au trésorier.
   */
  public async updateJournal(id: string, dto: UpdateJournalDto): Promise<Journal | null> {
    if (!this.canUpdateJournal()) {
      this.notificationService.error(
        'Tu ne disposes pas de la permission nécessaire pour modifier des journaux.',
        'Action non autorisée'
      );
      return null;
    }

    const payload: Record<string, unknown> = {};
    if (dto.name !== undefined) payload['name'] = dto.name.trim();
    if (dto.type !== undefined) payload['type'] = dto.type;
    if (dto.ledger_type !== undefined) payload['ledger_type'] = dto.ledger_type.trim();
    if (dto.sequence_prefix !== undefined) payload['sequence_prefix'] = dto.sequence_prefix.trim().toUpperCase();
    if (dto.default_account !== undefined) payload['default_account'] = dto.default_account.trim();
    if (dto.currency !== undefined) payload['currency'] = dto.currency.trim().toUpperCase();
    if (dto.is_active !== undefined) payload['is_active'] = dto.is_active;

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

    if (token) {
      try {
        const res = await fetch(`/api/journals/${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        const resData = await res.json().catch(() => null);
        if (res.ok && resData?.journal) {
          const row = resData.journal;
          const updated: Journal = {
            id: String(row.id),
            name: String(row.name),
            type: (row.type as JournalType) || 'bank',
            type_label: this.getTypeLabel(String(row.type || 'bank')),
            ledger_type: String(row.ledger_type || ''),
            sequence_prefix: String(row.sequence_prefix),
            default_account: String(row.default_account),
            currency: String(row.currency || 'XAF'),
            is_active: typeof row.is_active === 'boolean' ? row.is_active : true,
            selected: false,
            created_at: String(row.created_at || ''),
            updated_at: String(row.updated_at || new Date().toISOString()),
          };

          this._journals.update((list) =>
            list.map((j) => (j.id === id ? updated : j))
          );
          this.notificationService.success(`Le journal « ${updated.name} » a été mis à jour avec succès.`, 'Journal modifié');
          return updated;
        } else {
          const errMsg = getApiErrorMessage(
            resData,
            `Impossible de modifier le journal${res.ok ? ' : réponse serveur invalide' : ` (erreur HTTP ${res.status})`}.`
          );
          this.notificationService.error(errMsg, 'Échec de modification');
          return null;
        }
      } catch (err: unknown) {
        console.error('Erreur API modification journal:', err);
        this.notificationService.error(
          err instanceof TypeError
            ? 'Connexion au service des journaux impossible pour modifier le journal. Vérifiez votre connexion puis réessayez.'
            : 'Une erreur est survenue lors de la modification du journal.',
          'Échec de modification'
        );
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
    if (!this.canDeleteJournal()) {
      this.notificationService.error(
        'Tu ne disposes pas de la permission nécessaire pour supprimer des journaux.',
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
            const payload = await res.json().catch(() => null);
            this.notificationService.error(
              getApiErrorMessage(payload, `Impossible de supprimer le journal « ${journal.name} » (erreur HTTP ${res.status}).`),
              'Erreur de suppression'
            );
          }
        } catch (error) {
          this.notificationService.error(
            error instanceof TypeError
              ? `Connexion au service des journaux impossible pour supprimer « ${journal.name} ». Vérifiez votre connexion puis réessayez.`
              : `Une erreur est survenue lors de la suppression du journal « ${journal.name} ».`,
            'Erreur de suppression'
          );
        }
      } else {
        this.notificationService.error('Votre session a expiré. Reconnectez-vous pour supprimer les journaux.', 'Authentification requise');
        break;
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
    if (!this.canUpdateJournal()) {
      this.notificationService.error(
        'Tu ne disposes pas de la permission nécessaire pour modifier des journaux.',
        'Action non autorisée'
      );
      return;
    }

    const target = this._journals().find((j) => j.id === id);
    if (!target || id.startsWith('native-')) return;
    const updatedState = !target.is_active;

    let token = this.authService.token();
    if (!token && this.supabaseService.supabase) {
      try {
        const { data } = await this.supabaseService.supabase.auth.getSession();
        token = data.session?.access_token || null;
      } catch (error) {
        console.error('Impossible de récupérer la session pour modifier le journal:', error);
        this.notificationService.error('Session expirée ou non autorisée.', 'Authentification requise');
        return;
      }
    }
    if (!token) {
      this.notificationService.error('Session expirée ou non autorisée.', 'Authentification requise');
      return;
    }

    try {
      const response = await fetch(`/api/journals/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ is_active: updatedState }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        this.notificationService.error(
          getApiErrorMessage(payload, `Impossible de modifier le statut du journal (erreur HTTP ${response.status}).`),
          'Échec de modification'
        );
        return;
      }
      this._journals.update((list) =>
        list.map((journal) => (journal.id === id ? { ...journal, is_active: updatedState } : journal))
      );
    } catch (error) {
      console.error('Erreur API mise à jour du statut journal:', error);
      this.notificationService.error(
        error instanceof TypeError
          ? 'Connexion au service des journaux impossible pour modifier le statut. Vérifiez votre connexion puis réessayez.'
          : 'Une erreur est survenue lors de la modification du statut du journal.',
        'Échec de modification'
      );
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
