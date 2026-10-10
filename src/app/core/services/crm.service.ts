import { Injectable, computed, inject, signal } from '@angular/core';
import {
  CrmActivity,
  CrmCampaign,
  CrmClient,
  CrmClientInput,
  CrmContact,
  CrmOpportunity,
  CrmOpportunityInput,
  CrmOpportunityStage,
  CrmActivityInput,
  CrmOverview,
} from '../models/crm.model';
import { AuthService } from './auth.service';

export interface CrmResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class CrmService {
  private readonly authService = inject(AuthService);
  private readonly _clients = signal<CrmClient[]>([]);
  private readonly _contacts = signal<CrmContact[]>([]);
  private readonly _opportunities = signal<CrmOpportunity[]>([]);
  private readonly _activities = signal<CrmActivity[]>([]);
  private readonly _campaigns = signal<CrmCampaign[]>([]);
  private readonly _canManageTeam = signal(false);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  public readonly clients = computed(() => this._clients());
  public readonly contacts = computed(() => this._contacts());
  public readonly opportunities = computed(() => this._opportunities());
  public readonly activities = computed(() => this._activities());
  public readonly campaigns = computed(() => this._campaigns());
  public readonly canManageTeam = computed(() => this._canManageTeam());
  public readonly isLoading = computed(() => this._isLoading());
  public readonly error = computed(() => this._error());

  public async load(): Promise<boolean> {
    const result = await this.request<CrmOverview>('/overview', 'GET', undefined, true);
    if (!result.success || !result.data) {
      this._error.set(result.error || 'Impossible de charger le CRM.');
      return false;
    }
    const payload = result.data;
    this._clients.set(Array.isArray(payload.clients) ? payload.clients : []);
    this._contacts.set(Array.isArray(payload.contacts) ? payload.contacts : []);
    this._opportunities.set(Array.isArray(payload.opportunities) ? payload.opportunities : []);
    this._activities.set(Array.isArray(payload.activities) ? payload.activities : []);
    this._campaigns.set(Array.isArray(payload.campaigns) ? payload.campaigns : []);
    this._canManageTeam.set(payload.canManageTeam === true);
    this._error.set(null);
    return true;
  }

  public async createClient(input: CrmClientInput): Promise<CrmResult<CrmClient>> {
    const result = await this.mutate<{ client: Record<string, unknown> }>('/clients', 'POST', input);
    if (!result.success || !result.data?.client) return { success: false, error: result.error };
    const client = this.mapClient(result.data.client);
    this._clients.update((clients) => [client, ...clients.filter((item) => item.id !== client.id)]);
    return { success: true, data: client };
  }

  public async createContact(
    prospectId: string,
    input: { fullName: string; jobTitle: string; email: string; phone: string }
  ): Promise<CrmResult<CrmContact>> {
    const result = await this.mutate<{ contact: Record<string, unknown> }>(
      `/clients/${encodeURIComponent(prospectId)}/contacts`,
      'POST',
      input
    );
    if (!result.success || !result.data?.contact) return { success: false, error: result.error };
    const contact = this.mapContact(result.data.contact);
    this._contacts.update((contacts) => [contact, ...contacts]);
    return { success: true, data: contact };
  }

  public async createOpportunity(input: CrmOpportunityInput): Promise<CrmResult<CrmOpportunity>> {
    const result = await this.mutate<{ opportunity: Record<string, unknown> }>('/opportunities', 'POST', input);
    if (!result.success || !result.data?.opportunity) return { success: false, error: result.error };
    await this.load();
    const opportunity = this._opportunities().find((item) => item.id === String(result.data?.opportunity['id']));
    return opportunity
      ? { success: true, data: opportunity }
      : { success: false, error: 'L’opportunité a été créée, mais son actualisation a échoué.' };
  }

  public async updateOpportunity(
    id: string,
    input: {
      stage?: CrmOpportunityStage;
      wonReason?: 'signed_contract' | null;
      contractReference?: string | null;
    }
  ): Promise<CrmResult<CrmOpportunity>> {
    const result = await this.mutate<{ opportunity: Record<string, unknown> }>(
      `/opportunities/${encodeURIComponent(id)}`,
      'PATCH',
      input
    );
    if (!result.success) return { success: false, error: result.error };
    if (!await this.load()) return { success: false, error: this._error() || 'L’opportunité a été mise à jour, mais son actualisation a échoué.' };
    const opportunity = this._opportunities().find((item) => item.id === id);
    return opportunity
      ? { success: true, data: opportunity }
      : { success: false, error: 'L’opportunité a été mise à jour, mais son actualisation a échoué.' };
  }

  public async createActivity(input: CrmActivityInput): Promise<CrmResult<CrmActivity>> {
    const result = await this.mutate<{ activity: Record<string, unknown> }>('/activities', 'POST', input);
    if (!result.success || !result.data?.activity) return { success: false, error: result.error };
    if (!await this.load()) return { success: false, error: this._error() || 'La tâche a été créée, mais son actualisation a échoué.' };
    const activity = this._activities().find((item) => item.id === String(result.data?.activity['id']));
    return activity
      ? { success: true, data: activity }
      : { success: false, error: 'La tâche a été créée, mais son actualisation a échoué.' };
  }

  public async updateActivityStatus(
    id: string,
    status: CrmActivity['status']
  ): Promise<CrmResult<CrmActivity>> {
    const result = await this.mutate<{ activity: Record<string, unknown> }>(
      `/activities/${encodeURIComponent(id)}`,
      'PATCH',
      { status }
    );
    if (!result.success) return { success: false, error: result.error };
    if (!await this.load()) return { success: false, error: this._error() || 'La tâche a été mise à jour, mais son actualisation a échoué.' };
    const activity = this._activities().find((item) => item.id === id);
    return activity ? { success: true, data: activity }
      : { success: false, error: 'La tâche a été mise à jour, mais son actualisation a échoué.' };
  }

  public async createCampaign(input: {
    name: string;
    startsAt: string | null;
    endsAt: string | null;
    notes: string | null;
    filters: {
      statuses: string[];
      countries: string[];
      transportModes: string[];
      assignedTo: string | null;
    };
  }): Promise<CrmResult<CrmCampaign>> {
    const result = await this.mutate<{ campaign: Record<string, unknown> }>('/campaigns', 'POST', input);
    if (!result.success || !result.data?.campaign) return { success: false, error: result.error };
    if (!await this.load()) return { success: false, error: this._error() || 'La campagne a été créée, mais son actualisation a échoué.' };
    const campaign = this._campaigns().find((item) => item.id === String(result.data?.campaign['id']));
    return campaign ? { success: true, data: campaign }
      : { success: false, error: 'La campagne a été créée, mais son actualisation a échoué.' };
  }

  public async prepareCampaign(id: string): Promise<CrmResult<{ audienceCount: number; sent: boolean }>> {
    const result = await this.mutate<{ audienceCount: number; sent: boolean }>(
      `/campaigns/${encodeURIComponent(id)}/prepare`,
      'POST',
      {}
    );
    if (!result.success) return result;
    if (!await this.load()) {
      return { success: false, error: this._error() || 'L’audience a été préparée, mais son actualisation a échoué.' };
    }
    return result;
  }

  public async createDossier(
    opportunityId: string,
    input: { noDossier: string; description: string }
  ): Promise<CrmResult<{ id: string; no_dossier: string }>> {
    const result = await this.mutate<{ dossier: { id: string; no_dossier: string } }>(
      `/opportunities/${encodeURIComponent(opportunityId)}/dossier`,
      'POST',
      input
    );
    if (!result.success) return { success: false, error: result.error };
    if (!await this.load()) {
      return { success: false, error: this._error() || 'Le dossier a été créé, mais son actualisation a échoué.' };
    }
    return result.data?.dossier
      ? { success: true, data: result.data.dossier }
      : { success: false, error: 'Le dossier a été créé, mais son actualisation a échoué.' };
  }

  private async mutate<T>(path: string, method: string, body: unknown): Promise<CrmResult<T>> {
    return this.request<T>(path, method, body);
  }

  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
    showLoading = false
  ): Promise<CrmResult<T>> {
    const token = this.authService.token();
    if (!token) {
      this.authService.handleUnauthorizedSession();
      return { success: false, error: 'Session expirée. Veuillez vous reconnecter.' };
    }
    if (showLoading) this._isLoading.set(true);
    try {
      const response = await fetch(`/api/crm${path}`, {
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
      return { success: false, error: 'Le serveur CRM Commercial est injoignable.' };
    } finally {
      if (showLoading) this._isLoading.set(false);
    }
  }

  private mapClient(row: Record<string, unknown>): CrmClient {
    return {
      id: String(row['id'] ?? ''),
      name: String(row['name'] ?? ''),
      companyName: typeof row['companyName'] === 'string' ? row['companyName']
        : typeof row['company_name'] === 'string' ? row['company_name'] : null,
      contactName: typeof row['contactName'] === 'string' ? row['contactName']
        : typeof row['contact_name'] === 'string' ? row['contact_name'] : null,
      contactRole: typeof row['contactRole'] === 'string' ? row['contactRole']
        : typeof row['contact_role'] === 'string' ? row['contact_role'] : null,
      email: typeof row['email'] === 'string' ? row['email'] : null,
      phone: typeof row['phone'] === 'string' ? row['phone'] : null,
      country: typeof row['country'] === 'string' ? row['country'] : null,
      sector: typeof row['sector'] === 'string' ? row['sector'] : null,
      status: String(row['status'] ?? 'new'),
      assignedTo: typeof row['assignedTo'] === 'string' ? row['assignedTo']
        : typeof row['assigned_to'] === 'string' ? row['assigned_to'] : null,
    };
  }

  private mapContact(row: Record<string, unknown>): CrmContact {
    return {
      id: String(row['id'] ?? ''),
      prospectId: String(row['prospectId'] ?? row['prospect_id'] ?? ''),
      fullName: String(row['fullName'] ?? row['full_name'] ?? ''),
      jobTitle: typeof row['jobTitle'] === 'string' ? row['jobTitle']
        : typeof row['job_title'] === 'string' ? row['job_title'] : null,
      email: typeof row['email'] === 'string' ? row['email'] : null,
      phone: typeof row['phone'] === 'string' ? row['phone'] : null,
      isPrimary: row['isPrimary'] === true || row['is_primary'] === true,
    };
  }
}
