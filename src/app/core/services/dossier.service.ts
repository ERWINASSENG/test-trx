import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { Dossier, DossierExpenseSummary } from '../models/dossier.model';
import { getApiErrorMessage } from '../utils/api-error.util';

export interface DossierPageRequest {
  limit?: number;
  offset?: number;
  search?: string;
  dossierId?: string;
}

export type CreateDossierInput = Pick<Dossier, 'noDossier'> &
  Partial<Pick<Dossier, 'client' | 'description' | 'prospectId' | 'assignedTo'>>;

export interface DossierAssignee {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface DossierApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  preserveData?: boolean;
}

@Injectable({ providedIn: 'root' })
export class DossierService {
  private readonly authService = inject(AuthService);
  private dataUserId: string | null | undefined;

  private readonly _dossiers = signal<Dossier[]>([]);
  private readonly _total = signal(0);
  private readonly _assignees = signal<DossierAssignee[]>([]);
  private readonly _assigneesLoaded = signal(false);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _expenseSummary = signal<DossierExpenseSummary[]>([]);
  private readonly _isExpenseSummaryLoading = signal(false);
  private readonly _expenseSummaryError = signal<string | null>(null);
  private readonly _createModalRequested = signal(false);

  public readonly dossiers = computed(() => this._dossiers());
  public readonly expenseSummary = computed(() => this._expenseSummary());
  public readonly createModalRequested = this._createModalRequested.asReadonly();
  public readonly isExpenseSummaryLoading = computed(() => this._isExpenseSummaryLoading());
  public readonly expenseSummaryError = computed(() => this._expenseSummaryError());
  public readonly total = computed(() => this._total());
  public readonly assignees = this._assignees.asReadonly();
  public readonly assigneesLoaded = this._assigneesLoaded.asReadonly();
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());

  constructor() {
    effect(() => {
      this.authService.currentUser();
      this.resetForAccountChange();
    });
  }

  public async loadDossiers(params: DossierPageRequest = {}): Promise<boolean> {
    this.resetForAccountChange();
    const query = new URLSearchParams({
      limit: String(params.limit ?? 50),
      offset: String(params.offset ?? 0),
    });
    if (params.search?.trim()) query.set('search', params.search.trim());
    if (params.dossierId) query.set('dossierId', params.dossierId);

    const result = await this.request<{ dossiers: Record<string, unknown>[]; total: number }>(`?${query}`);
    if (!this.isCurrentDataUser()) return false;
    if (!result.success || !result.data) {
      if (!result.preserveData) {
        this._dossiers.set([]);
        this._total.set(0);
      }
      this._error.set(result.error || 'Impossible de charger les dossiers.');
      return false;
    }

    this._dossiers.set((result.data.dossiers || []).map((row) => this.mapDossier(row)));
    this._total.set(Number(result.data.total) || 0);
    this._error.set(null);
    return true;
  }

  public async loadAssignees(): Promise<boolean> {
    const result = await this.request<{ assignees: Record<string, unknown>[] }>('/assignees');
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger les responsables.');
      return false;
    }
    this._assignees.set((result.data.assignees || []).map((row) => ({
      id: String(row['id'] ?? ''),
      firstName: String(row['first_name'] ?? ''),
      lastName: String(row['last_name'] ?? ''),
      email: String(row['email'] ?? ''),
    })));
    this._assigneesLoaded.set(true);
    return true;
  }

  public async assignDossier(id: string, assignedTo: string | null): Promise<DossierApiResult<void>> {
    const result = await this.request<{ assignedTo: string | null }>(
      `/${encodeURIComponent(id)}/assignment`,
      'PATCH',
      { assignedTo }
    );
    if (!result.success) return { success: false, error: result.error };
    this._dossiers.update((dossiers) => dossiers.map((dossier) => dossier.id === id
      ? { ...dossier, assignedTo: result.data?.assignedTo ?? null }
      : dossier));
    return { success: true };
  }

  public async loadAllDossiers(): Promise<boolean> {
    this.resetForAccountChange();
    const dossiers: Dossier[] = [];
    let offset = 0;
    let total = 0;

    do {
      const result = await this.request<{ dossiers: Record<string, unknown>[]; total: number }>(
        `?limit=100&offset=${offset}`
      );
      if (!this.isCurrentDataUser()) return false;
      if (!result.success || !result.data) {
        if (!result.preserveData) {
          this._dossiers.set([]);
          this._total.set(0);
        }
        this._error.set(result.error || 'Impossible de charger les dossiers.');
        return false;
      }

      const page = (result.data.dossiers || []).map((row) => this.mapDossier(row));
      dossiers.push(...page);
      total = Number(result.data.total) || 0;
      offset += page.length;

      if (page.length === 0) break;
    } while (offset < total && offset < 100000);

    if (offset < total) {
      this._error.set('La liste des dossiers dépasse la limite de chargement.');
      return false;
    }

    this._dossiers.set(dossiers);
    this._total.set(total);
    this._error.set(null);
    return true;
  }

  public async loadExpenseSummary(): Promise<boolean> {
    this.resetForAccountChange();
    this._isExpenseSummaryLoading.set(true);
    this._expenseSummaryError.set(null);
    try {
      const result = await this.request<{ summaries: DossierExpenseSummary[] }>('/expenses');
      if (!this.isCurrentDataUser()) return false;
      if (!result.success || !result.data) {
        this._expenseSummary.set([]);
        this._expenseSummaryError.set(result.error || 'Impossible de charger le rapport des dépenses.');
        return false;
      }

      this._expenseSummary.set((result.data.summaries || []).map((summary) => ({
        ...this.mapDossier(summary as unknown as Record<string, unknown>),
        expenseCount: Number(summary.expenseCount) || 0,
        totalExpenses: Number(summary.totalExpenses) || 0,
      })));
      return true;
    } finally {
      this._isExpenseSummaryLoading.set(false);
    }
  }

  public requestCreateModal(): void {
    this._createModalRequested.set(true);
  }

  public consumeCreateModalRequest(): boolean {
    if (!this._createModalRequested()) return false;
    this._createModalRequested.set(false);
    return true;
  }

  public async createDossier(input: CreateDossierInput): Promise<DossierApiResult<Dossier>> {
    const result = await this.request<{ dossier: Record<string, unknown> }>('', 'POST', input);
    if (!result.success || !result.data?.dossier) {
      return { success: false, error: result.error || 'Impossible de créer le dossier.' };
    }

    const dossier = this.mapDossier(result.data.dossier);
    this._dossiers.update((current) => [dossier, ...current.filter((item) => item.id !== dossier.id)]);
    this._total.update((current) => current + 1);
    this._error.set(null);
    return { success: true, data: dossier };
  }

  private resetForAccountChange(): void {
    const userId = this.authService.currentUser()?.id ?? null;
    if (this.dataUserId === userId) return;

    this.dataUserId = userId;
    this._dossiers.set([]);
    this._total.set(0);
    this._assignees.set([]);
    this._assigneesLoaded.set(false);
    this._expenseSummary.set([]);
    this._error.set(null);
    this._expenseSummaryError.set(null);
    this._createModalRequested.set(false);
  }

  private isCurrentDataUser(): boolean {
    return this.dataUserId === (this.authService.currentUser()?.id ?? null);
  }

  private async request<T>(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<DossierApiResult<T>> {
    this.resetForAccountChange();
    const requestedUserId = this.authService.currentUser()?.id ?? null;
    const token = this.authService.token();
    if (!token) {
      this.authService.handleUnauthorizedSession();
      return { success: false, error: 'Session expirée. Veuillez vous reconnecter.' };
    }

    this._isLoading.set(true);
    try {
      const url = `/api/dossiers${path}`;
      const sendRequest = (accessToken: string) => fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      let response = await sendRequest(token);
      if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) {
        return { success: false, error: 'La session a changé pendant la requête.' };
      }
      if (response.status === 401) {
        const refresh = await this.authService.refreshAccessTokenAfterUnauthorized();
        if (refresh.status === 'refreshed') {
          response = await sendRequest(refresh.accessToken);
        } else if (refresh.status === 'unavailable') {
          return {
            success: false,
            error: 'La vérification de session est temporairement indisponible. Réessayez.',
            preserveData: true,
          };
        }
      }

      const payload: unknown = await response.json().catch(() => null);
      if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) {
        return { success: false, error: 'La session a changé pendant la requête.' };
      }
      if (!response.ok) {
        if (response.status === 401) {
          this._dossiers.set([]);
          this._total.set(0);
          this._expenseSummary.set([]);
          this.authService.handleUnauthorizedSession();
          return { success: false, error: 'Session expirée. Veuillez vous reconnecter.' };
        }
        const action = method === 'GET'
          ? path === '/assignees'
            ? 'charger la liste des responsables'
            : path === '/expenses'
              ? 'charger le rapport des dépenses'
              : 'charger les dossiers'
          : method === 'POST'
            ? 'créer le dossier'
            : 'modifier le dossier';
        return {
          success: false,
          error: getApiErrorMessage(payload, `Impossible de ${action} (erreur HTTP ${response.status}).`),
        };
      }
      if (typeof payload !== 'object' || payload === null) {
        return { success: false, error: 'Le service Dossiers a renvoyé une réponse invalide.' };
      }
      return { success: true, data: payload as T };
    } catch (requestError: unknown) {
      console.warn('Erreur pendant la requête au service Dossiers:', requestError);
      const message = requestError instanceof TypeError
        ? 'Connexion au service Dossiers impossible. Vérifiez votre connexion puis réessayez.'
        : 'Impossible de vérifier la session ou de traiter la demande Dossiers. Réessayez.';
      return { success: false, error: message };
    } finally {
      this._isLoading.set(false);
    }
  }

  private mapDossier(row: Record<string, unknown>): Dossier {
    return {
      id: String(row['id'] ?? ''),
      prospectId: typeof row['prospectId'] === 'string'
        ? row['prospectId']
        : typeof row['prospect_id'] === 'string' ? row['prospect_id'] : null,
      opportunityId: typeof row['opportunityId'] === 'string'
        ? row['opportunityId']
        : typeof row['opportunity_id'] === 'string' ? row['opportunity_id'] : null,
      noDossier: String(row['noDossier'] ?? row['no_dossier'] ?? ''),
      client: typeof row['client'] === 'string' ? row['client'] : null,
      statut: String(row['statut'] ?? 'ouvert'),
      description: typeof row['description'] === 'string' ? row['description'] : null,
      createdBy: typeof row['createdBy'] === 'string'
        ? row['createdBy']
        : typeof row['created_by'] === 'string' ? row['created_by'] : null,
      assignedTo: typeof row['assignedTo'] === 'string'
        ? row['assignedTo']
        : typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null,
      createdAt: String(row['createdAt'] ?? row['created_at'] ?? ''),
      updatedAt: String(row['updatedAt'] ?? row['updated_at'] ?? ''),
    };
  }
}