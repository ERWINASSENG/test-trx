import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { Dossier, DossierExpenseSummary } from '../models/dossier.model';

export interface DossierPageRequest {
  limit?: number;
  offset?: number;
  search?: string;
}

export type CreateDossierInput = Pick<Dossier, 'noDossier'> &
  Partial<Pick<Dossier, 'client' | 'description' | 'prospectId'>>;

export interface DossierApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class DossierService {
  private readonly authService = inject(AuthService);

  private readonly _dossiers = signal<Dossier[]>([]);
  private readonly _total = signal(0);
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
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());

  public async loadDossiers(params: DossierPageRequest = {}): Promise<boolean> {
    const query = new URLSearchParams({
      limit: String(params.limit ?? 50),
      offset: String(params.offset ?? 0),
    });
    if (params.search?.trim()) query.set('search', params.search.trim());

    const result = await this.request<{ dossiers: Record<string, unknown>[]; total: number }>(`?${query}`);
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger les dossiers.');
      return false;
    }

    this._dossiers.set((result.data.dossiers || []).map((row) => this.mapDossier(row)));
    this._total.set(Number(result.data.total) || 0);
    this._error.set(null);
    return true;
  }

  public async loadAllDossiers(): Promise<boolean> {
    const dossiers: Dossier[] = [];
    let offset = 0;
    let total = 0;

    do {
      const result = await this.request<{ dossiers: Record<string, unknown>[]; total: number }>(
        `?limit=100&offset=${offset}`
      );
      if (!result.success || !result.data) {
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
    this._isExpenseSummaryLoading.set(true);
    this._expenseSummaryError.set(null);
    try {
      const result = await this.request<{ summaries: DossierExpenseSummary[] }>('/expenses');
      if (!result.success || !result.data) {
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

  private async request<T>(
    path: string,
    method = 'GET',
    body?: unknown
  ): Promise<DossierApiResult<T>> {
    const token = this.authService.token();
    if (!token) return { success: false, error: 'Session authentifiée introuvable.' };

    this._isLoading.set(true);
    try {
      const response = await fetch(`/api/dossiers${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => ({})) as T & { error?: string };
      if (!response.ok) {
        return { success: false, error: payload.error || `Erreur serveur (${response.status}).` };
      }
      return { success: true, data: payload };
    } catch {
      return { success: false, error: 'Le serveur Dossiers est injoignable.' };
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
      noDossier: String(row['noDossier'] ?? row['no_dossier'] ?? ''),
      client: typeof row['client'] === 'string' ? row['client'] : null,
      statut: String(row['statut'] ?? 'ouvert'),
      description: typeof row['description'] === 'string' ? row['description'] : null,
      createdBy: typeof row['createdBy'] === 'string'
        ? row['createdBy']
        : typeof row['created_by'] === 'string' ? row['created_by'] : null,
      createdAt: String(row['createdAt'] ?? row['created_at'] ?? ''),
      updatedAt: String(row['updatedAt'] ?? row['updated_at'] ?? ''),
    };
  }
}