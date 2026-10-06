import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { CreateProspectInput, Prospect, ProspectAssignee, ProspectStatus, UpdateProspectInput } from '../models/prospect.model';

export interface ProspectPageRequest {
  limit?: number;
  offset?: number;
  search?: string;
  status?: ProspectStatus | '';
}

export interface ProspectApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class ProspectService {
  private readonly authService = inject(AuthService);

  private readonly _prospects = signal<Prospect[]>([]);
  private readonly _assignees = signal<ProspectAssignee[]>([]);
  private readonly _total = signal(0);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  public readonly prospects = computed(() => this._prospects());
  public readonly assignees = computed(() => this._assignees());
  public readonly total = computed(() => this._total());
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());

  public async loadProspects(params: ProspectPageRequest = {}): Promise<boolean> {
    const query = new URLSearchParams({
      limit: String(params.limit ?? 25),
      offset: String(params.offset ?? 0),
    });
    if (params.search?.trim()) query.set('search', params.search.trim());
    if (params.status) query.set('status', params.status);

    const result = await this.request<{ prospects: Record<string, unknown>[]; total: number }>(`?${query}`);
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger les prospects.');
      return false;
    }

    this._prospects.set(result.data.prospects.map((row) => this.mapProspect(row)));
    this._total.set(result.data.total);
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
    this._error.set(null);
    return true;
  }

  public createProspect(input: CreateProspectInput): Promise<ProspectApiResult<Prospect>> {
    return this.mutate('', 'POST', input);
  }

  public updateProspect(id: string, input: UpdateProspectInput): Promise<ProspectApiResult<Prospect>> {
    return this.mutate(`/${encodeURIComponent(id)}`, 'PATCH', input);
  }

  public deleteProspect(id: string): Promise<ProspectApiResult<{ deleted: boolean }>> {
    return this.mutate(`/${encodeURIComponent(id)}`, 'DELETE');
  }

  private async mutate<T>(path: string, method: string, body?: unknown): Promise<ProspectApiResult<T>> {
    return this.request<T>(path, method, body);
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<ProspectApiResult<T>> {
    const token = this.authService.token();
    if (!token) return { success: false, error: 'Session authentifiée introuvable.' };

    this._isLoading.set(true);
    try {
      const response = await fetch(`/api/prospects${path}`, {
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
      return { success: false, error: 'Le serveur Prospects est injoignable.' };
    } finally {
      this._isLoading.set(false);
    }
  }

  private mapProspect(row: Record<string, unknown>): Prospect {
    const rawValue = row['estimated_value'];
    const parsedValue = rawValue === null || rawValue === undefined || rawValue === '' ? null : Number(rawValue);
    const rawNotes = String(row['notes'] ?? '');
    let country: string | null = typeof row['country'] === 'string' ? row['country'] : null;
    let contactRole: string | null = typeof row['contact_role'] === 'string' ? row['contact_role'] : null;

    if (rawNotes.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(rawNotes) as { country?: string; contactRole?: string };
        if (typeof parsed.country === 'string' && !country) country = parsed.country || null;
        if (typeof parsed.contactRole === 'string' && !contactRole) contactRole = parsed.contactRole || null;
      } catch {
        if (!country) country = rawNotes || null;
      }
    } else if (!country && rawNotes) {
      country = rawNotes;
    }

    const source = typeof row['source'] === 'string' ? row['source'] : null;
    return {
      id: String(row['id'] ?? ''),
      name: String(row['name'] ?? ''),
      companyName: typeof row['company_name'] === 'string' ? row['company_name'] : null,
      contactName: typeof row['contact_name'] === 'string' ? row['contact_name'] : null,
      contactRole,
      country,
      sector: typeof row['sector'] === 'string' ? row['sector'] : source,
      email: typeof row['email'] === 'string' ? row['email'] : null,
      phone: typeof row['phone'] === 'string' ? row['phone'] : null,
      source,
      status: row['status'] as ProspectStatus,
      assignedTo: typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null,
      estimatedValue: parsedValue !== null && Number.isFinite(parsedValue) ? parsedValue : null,
      currency: String(row['currency'] ?? 'XAF'),
      nextFollowUp: typeof row['next_follow_up'] === 'string' ? row['next_follow_up'] : null,
      notes: rawNotes,
      createdBy: typeof row['created_by'] === 'string' ? row['created_by'] : null,
      createdAt: String(row['created_at'] ?? ''),
      updatedAt: String(row['updated_at'] ?? ''),
    };
  }
}
