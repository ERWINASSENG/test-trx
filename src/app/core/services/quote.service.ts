import { Injectable, computed, inject, signal } from '@angular/core';
import {
  QuoteAssignee,
  QuoteColumn,
  QuoteRow,
  QuoteStatus,
  QuoteTemplate,
  SalesQuote,
} from '../models/quote.model';
import { Prospect } from '../models/prospect.model';
import { AuthService } from './auth.service';

export interface QuoteInput {
  prospectId: string;
  opportunityId?: string | null;
  assignedTo?: string;
  title: string;
  currency: string;
  columns: QuoteColumn[];
  rows: QuoteRow[];
  totalColumnId: string;
  status: QuoteStatus;
  validUntil: string | null;
}

export interface QuoteApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class QuoteService {
  private readonly authService = inject(AuthService);
  private readonly _quotes = signal<SalesQuote[]>([]);
  private readonly _prospects = signal<Prospect[]>([]);
  private readonly _assignees = signal<QuoteAssignee[]>([]);
  private readonly _templates = signal<QuoteTemplate[]>([]);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  public readonly quotes = computed(() => this._quotes());
  public readonly prospects = computed(() => this._prospects());
  public readonly assignees = computed(() => this._assignees());
  public readonly templates = computed(() => this._templates());
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());

  public async loadQuotes(status = ''): Promise<boolean> {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    const result = await this.request<{ quotes: Record<string, unknown>[] }>(
      `/api/quotes${query.size ? `?${query.toString()}` : ''}`,
      'GET',
      undefined,
      true
    );
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger les cotations.');
      return false;
    }
    this._quotes.set((result.data.quotes || []).map((row) => this.mapQuote(row)));
    this._error.set(null);
    return true;
  }

  public async loadProspects(): Promise<boolean> {
    const result = await this.request<{ prospects: Record<string, unknown>[] }>('/api/quotes/prospects');
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger les clients.');
      return false;
    }
    this._prospects.set((result.data.prospects || []).map((row) => ({
      id: String(row['id'] ?? ''),
      name: String(row['name'] ?? ''),
      companyName: typeof row['company_name'] === 'string' ? row['company_name'] : null,
      contactName: typeof row['contact_name'] === 'string' ? row['contact_name'] : null,
      contactRole: null,
      email: typeof row['email'] === 'string' ? row['email'] : null,
      phone: typeof row['phone'] === 'string' ? row['phone'] : null,
      source: null,
      status: String(row['status'] ?? 'new') as Prospect['status'],
      assignedTo: typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null,
      estimatedValue: null,
      currency: 'XAF',
      nextFollowUp: null,
      notes: '',
      createdBy: null,
      createdAt: '',
      updatedAt: '',
    })));
    this._error.set(null);
    return true;
  }

  public async loadAssignees(): Promise<boolean> {
    const result = await this.request<{ assignees: Record<string, unknown>[] }>('/api/quotes/assignees');
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger les commerciaux.');
      return false;
    }
    this._assignees.set((result.data.assignees || []).map((row) => ({
      id: String(row['id'] ?? ''),
      firstName: String(row['first_name'] ?? ''),
      lastName: String(row['last_name'] ?? ''),
      email: String(row['email'] ?? ''),
    })));
    this._error.set(null);
    return true;
  }

  public async loadTemplates(): Promise<boolean> {
    const result = await this.request<{ templates: Record<string, unknown>[] }>('/api/quotes/templates');
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger les modèles.');
      return false;
    }
    this._templates.set((result.data.templates || []).map((row) => this.mapTemplate(row)));
    this._error.set(null);
    return true;
  }

  public async createQuote(input: QuoteInput): Promise<QuoteApiResult<SalesQuote>> {
    return this.mutate<{ quote: Record<string, unknown> }>('/api/quotes', 'POST', input)
      .then((result) => result.success && result.data
        ? { success: true, data: this.mapQuote(result.data.quote) }
        : { success: false, error: result.error });
  }

  public async updateQuote(id: string, input: QuoteInput): Promise<QuoteApiResult<SalesQuote>> {
    return this.mutate<{ quote: Record<string, unknown> }>(`/api/quotes/${encodeURIComponent(id)}`, 'PATCH', input)
      .then((result) => result.success && result.data
        ? { success: true, data: this.mapQuote(result.data.quote) }
        : { success: false, error: result.error });
  }

  public deleteQuote(id: string): Promise<QuoteApiResult<{ deleted: boolean }>> {
    return this.mutate(`/api/quotes/${encodeURIComponent(id)}`, 'DELETE');
  }

  public async createProspect(input: {
    companyName: string;
    contactName?: string;
    email?: string;
    phone?: string;
    assignedTo?: string;
  }): Promise<QuoteApiResult<Prospect>> {
    const result = await this.mutate<{ prospect: Record<string, unknown> }>('/api/quotes/prospects', 'POST', input);
    if (!result.success || !result.data) return { success: false, error: result.error };
    const row = result.data.prospect;
    const prospect = this._prospects()[0] && String(this._prospects()[0].id) === String(row['id'])
      ? this._prospects()[0]
      : {
        id: String(row['id'] ?? ''),
        name: String(row['name'] ?? input.companyName),
        companyName: typeof row['company_name'] === 'string' ? row['company_name'] : input.companyName,
        contactName: typeof row['contact_name'] === 'string' ? row['contact_name'] : null,
        email: typeof row['email'] === 'string' ? row['email'] : null,
        phone: typeof row['phone'] === 'string' ? row['phone'] : null,
        status: String(row['status'] ?? 'new') as Prospect['status'],
        assignedTo: typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null,
        contactRole: null,
        source: null,
        estimatedValue: null,
        currency: 'XAF',
        nextFollowUp: null,
        notes: '',
        createdBy: null,
        createdAt: '',
        updatedAt: '',
      };
    this._prospects.update((prospects) => [prospect, ...prospects.filter((item) => item.id !== prospect.id)]);
    return { success: true, data: prospect };
  }

  public async createTemplate(input: {
    name: string;
    columns: QuoteColumn[];
    totalColumnId: string;
  }): Promise<QuoteApiResult<QuoteTemplate>> {
    const result = await this.mutate<{ template: Record<string, unknown> }>('/api/quotes/templates', 'POST', input);
    return result.success && result.data
      ? { success: true, data: this.mapTemplate(result.data.template) }
      : { success: false, error: result.error };
  }

  public deleteTemplate(id: string): Promise<QuoteApiResult<{ deleted: boolean }>> {
    return this.mutate(`/api/quotes/templates/${encodeURIComponent(id)}`, 'DELETE');
  }

  private async mutate<T>(path: string, method: string, body?: unknown): Promise<QuoteApiResult<T>> {
    return this.request<T>(path, method, body);
  }

  private async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    showLoading = false
  ): Promise<QuoteApiResult<T>> {
    const token = this.authService.token();
    if (!token) return { success: false, error: 'Session authentifiée introuvable.' };

    if (showLoading) this._isLoading.set(true);
    try {
      const response = await fetch(path, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json().catch(() => ({})) as T & { error?: string };
      if (!response.ok) return { success: false, error: payload.error || `Erreur serveur (${response.status}).` };
      return { success: true, data: payload };
    } catch {
      return { success: false, error: 'Le serveur Cotations est injoignable.' };
    } finally {
      if (showLoading) this._isLoading.set(false);
    }
  }

  private mapQuote(row: Record<string, unknown>): SalesQuote {
    return {
      id: String(row['id'] ?? ''),
      quoteNumber: String(row['quoteNumber'] ?? row['quote_number'] ?? ''),
      prospectId: String(row['prospectId'] ?? row['prospect_id'] ?? ''),
      opportunityId: typeof row['opportunityId'] === 'string' ? row['opportunityId']
        : typeof row['opportunity_id'] === 'string' ? row['opportunity_id'] : null,
      prospectName: String(row['prospectName'] ?? ''),
      assignedTo: typeof row['assignedTo'] === 'string' ? row['assignedTo']
        : typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null,
      assignedToName: typeof row['assignedToName'] === 'string' ? row['assignedToName'] : null,
      createdBy: typeof row['createdBy'] === 'string' ? row['createdBy']
        : typeof row['created_by'] === 'string' ? row['created_by'] : null,
      title: String(row['title'] ?? 'Cotation'),
      currency: String(row['currency'] ?? 'XAF'),
      columns: Array.isArray(row['columns']) ? row['columns'] as QuoteColumn[] : [],
      rows: Array.isArray(row['rows']) ? row['rows'] as QuoteRow[] : [],
      totalColumnId: String(row['totalColumnId'] ?? row['total_column_id'] ?? ''),
      totalAmount: Number(row['totalAmount'] ?? row['total_amount'] ?? 0),
      status: String(row['status'] ?? 'draft') as QuoteStatus,
      validUntil: typeof row['validUntil'] === 'string' ? row['validUntil']
        : typeof row['valid_until'] === 'string' ? row['valid_until'] : null,
      createdAt: String(row['createdAt'] ?? row['created_at'] ?? ''),
      updatedAt: String(row['updatedAt'] ?? row['updated_at'] ?? ''),
    };
  }

  private mapTemplate(row: Record<string, unknown>): QuoteTemplate {
    return {
      id: String(row['id'] ?? ''),
      name: String(row['name'] ?? ''),
      columns: Array.isArray(row['columns']) ? row['columns'] as QuoteColumn[] : [],
      totalColumnId: String(row['totalColumnId'] ?? row['total_column_id'] ?? ''),
      createdBy: typeof row['createdBy'] === 'string' ? row['createdBy']
        : typeof row['created_by'] === 'string' ? row['created_by'] : null,
      createdAt: String(row['createdAt'] ?? row['created_at'] ?? ''),
      updatedAt: String(row['updatedAt'] ?? row['updated_at'] ?? ''),
    };
  }
}
