import { DestroyRef, Injectable, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';
import type { QuoteStatus } from '../models/quote.model';
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
  generateDefaultDossierNumber,
  generateDefaultDossierDescription,
} from '../models/crm.model';
import { AuthService } from './auth.service';
import { getApiErrorMessage } from '../utils/api-error.util';

export interface CrmResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export type UpdateOpportunityInput = Partial<CrmOpportunityInput> & {
  stage?: CrmOpportunityStage;
  wonReason?: 'accepted_quote' | 'signed_contract' | null;
  contractReference?: string | null;
  assignedTo?: string | null;
};

@Injectable({ providedIn: 'root' })
export class CrmService {
  private readonly authService = inject(AuthService);
  private readonly supabaseService = inject(SupabaseService);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);
  private crmRealtimeChannel: RealtimeChannel | null = null;
  private refreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private dataUserId: string | null | undefined;
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

  constructor() {
    effect(() => {
      const user = this.authService.currentUser();
      this.resetForAccountChange();
      if (user && isPlatformBrowser(this.platformId)) {
        this.setupRealtime();
      } else {
        this.teardownRealtime();
      }
    });

    this.destroyRef.onDestroy(() => {
      this.teardownRealtime();
    });
  }

  public setupRealtime(): void {
    if (!isPlatformBrowser(this.platformId) || this.crmRealtimeChannel) return;
    const client = this.supabaseService.supabase;
    if (!client) return;
    try {
      this.crmRealtimeChannel = client
        .channel('crm:sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_opportunities' }, () => {
          this.scheduleDebouncedReload();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sales_quotes' }, () => {
          this.scheduleDebouncedReload();
        })
        .subscribe();
    } catch (err) {
      console.warn('Realtime CRM indisponible:', err);
    }
  }

  public teardownRealtime(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
    if (this.crmRealtimeChannel) {
      const client = this.supabaseService.supabase;
      if (client) void client.removeChannel(this.crmRealtimeChannel);
      this.crmRealtimeChannel = null;
    }
  }

  private scheduleDebouncedReload(): void {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => {
      if (this.authService.currentUser() && !this._isLoading()) {
        void this.load();
      }
    }, 400);

  }

  public async load(): Promise<boolean> {
    this.resetForAccountChange();
    const result = await this.request<CrmOverview>('/overview', 'GET', undefined, true);
    if (!this.isCurrentDataUser()) return false;
    if (!result.success || !result.data) {
      this._clients.set([]);
      this._contacts.set([]);
      this._opportunities.set([]);
      this._activities.set([]);
      this._campaigns.set([]);
      this._canManageTeam.set(false);
      this._error.set(result.error || 'Impossible de charger le CRM.');
      return false;
    }
    const payload = result.data;
    this._clients.set(
      Array.isArray(payload.clients)
        ? payload.clients.map((client) => this.mapClient(client as unknown as Record<string, unknown>))
        : []
    );
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

  /**
   * Met à jour l'étape d'une opportunité de façon optimiste (immédiate dans l'UI style Trello/Odoo)
   * avec rollback automatique si la requête serveur échoue.
   */
  public async updateOpportunityStageOptimistic(
    id: string,
    newStage: CrmOpportunityStage
  ): Promise<CrmResult<CrmOpportunity>> {
    const previous = this._opportunities().find((item) => item.id === id);
    if (!previous) return { success: false, error: 'Opportunité introuvable.' };
    const previousStage = previous.stage;
    const previousQuoteStatus = previous.quoteStatus;

    let optimisticQuoteStatus = previous.quoteStatus;
    if (newStage === 'quote_sent') {
      optimisticQuoteStatus = 'sent';
    } else if (newStage === 'negotiation') {
      if (previous.quoteStatus === 'draft') optimisticQuoteStatus = 'sent';
    } else if (newStage === 'won') {
      optimisticQuoteStatus = 'accepted';
    } else if (newStage === 'lost') {
      optimisticQuoteStatus = 'rejected';
    } else if (newStage === 'quote_preparation') {
      if (previous.quoteNumber) optimisticQuoteStatus = 'draft';
    }

    // 1. Mise à jour locale immédiate dans le signal pour supprimer tout temps d'attente visuel
    this._opportunities.update((items) =>
      items.map((item) => (item.id === id ? { ...item, stage: newStage, quoteStatus: optimisticQuoteStatus } : item))
    );

    // 2. Persistance asynchrone sur le serveur
    const result = await this.mutate<{ opportunity: Record<string, unknown> }>(
      `/opportunities/${encodeURIComponent(id)}`,
      'PATCH',
      { stage: newStage }
    );

    // 3. Rollback en cas d'erreur réseau ou de rejet serveur
    if (!result.success) {
      this._opportunities.update((items) =>
        items.map((item) => (item.id === id ? { ...item, stage: previousStage, quoteStatus: previousQuoteStatus } : item))
      );
      return { success: false, error: result.error };
    }

    if (result.data?.opportunity) {
      const serverOpp = result.data.opportunity;
      this._opportunities.update((items) =>
        items.map((item) => {
          if (item.id !== id) return item;
          return {
            ...item,
            stage: (serverOpp['stage'] as CrmOpportunityStage) || newStage,
            quoteStatus: (serverOpp['quoteStatus'] as QuoteStatus) ?? item.quoteStatus,
            quoteNumber: (serverOpp['quoteNumber'] as string) ?? item.quoteNumber,
            quoteId: (serverOpp['quoteId'] as string) ?? item.quoteId,
          };
        })
      );
    }

    const updated = this._opportunities().find((item) => item.id === id);
    return updated ? { success: true, data: updated } : { success: true };
  }

  public async updateOpportunity(
    id: string,
    input: UpdateOpportunityInput
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

  /**
   * Génère automatiquement un dossier d'exploitation lié à une opportunité gagnée
   */
  public async autoGenerateDossier(opportunity: CrmOpportunity): Promise<CrmResult<{ id: string; no_dossier: string }>> {
    const noDossier = generateDefaultDossierNumber();
    const description = generateDefaultDossierDescription(opportunity);
    return this.createDossier(opportunity.id, { noDossier, description });
  }

  public getOpportunityById(id: string): CrmOpportunity | null {
    return this._opportunities().find((item) => item.id === id) || null;
  }

  public getClientById(id: string): CrmClient | null {
    return this._clients().find((item) => item.id === id) || null;
  }

  public getActivitiesByOpportunity(opportunityId: string): CrmActivity[] {
    return this._activities().filter((item) => item.opportunityId === opportunityId);
  }

  public getActivitiesByClient(clientId: string): CrmActivity[] {
    return this._activities().filter((item) => item.prospectId === clientId);
  }

  public getOpportunitiesByClient(clientId: string): CrmOpportunity[] {
    return this._opportunities().filter((item) => item.prospectId === clientId);
  }

  private async mutate<T>(path: string, method: string, body: unknown): Promise<CrmResult<T>> {
    return this.request<T>(path, method, body);
  }

  private resetForAccountChange(): void {
    const userId = this.authService.currentUser()?.id ?? null;
    if (this.dataUserId === userId) return;

    this.dataUserId = userId;
    this._clients.set([]);
    this._contacts.set([]);
    this._opportunities.set([]);
    this._activities.set([]);
    this._campaigns.set([]);
    this._canManageTeam.set(false);
    this._error.set(null);
  }

  private isCurrentDataUser(): boolean {
    return this.dataUserId === (this.authService.currentUser()?.id ?? null);
  }

  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
    showLoading = false
  ): Promise<CrmResult<T>> {
    this.resetForAccountChange();
    const requestedUserId = this.authService.currentUser()?.id ?? null;
    const token = this.authService.token();
    if (!token) {
      this.authService.handleUnauthorizedSession();
      return { success: false, error: 'Session expirée. Veuillez vous reconnecter.' };
    }
    const action = method === 'GET'
      ? 'charger les données CRM'
      : path.includes('/prepare')
        ? 'préparer l’audience de la campagne'
        : path.endsWith('/dossier')
          ? 'créer le dossier depuis le CRM'
          : path.includes('/contacts')
            ? 'créer le contact'
            : path.includes('/opportunities')
              ? method === 'POST' ? 'créer l’opportunité' : 'modifier l’opportunité'
              : path.includes('/activities')
                ? method === 'POST' ? 'créer la tâche' : 'modifier la tâche'
                : path.includes('/campaigns')
                  ? 'créer la campagne'
                  : 'enregistrer le client';
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
  
      const payload: unknown = await response.json().catch(() => null);
      if ((this.authService.currentUser()?.id ?? null) !== requestedUserId) {
        return { success: false, error: 'La session a changé pendant la requête.' };
      }
      if (!response.ok) {
        return {
          success: false,
          error: getApiErrorMessage(payload, `Impossible de ${action} (erreur HTTP ${response.status}).`),
        };
      }
      if (typeof payload !== 'object' || payload === null) {
        return { success: false, error: 'Le service CRM a renvoyé une réponse invalide.' };
      }
      return { success: true, data: payload as T };
    } catch (requestError: unknown) {
      console.warn('Erreur pendant la requête au service CRM:', requestError);
      const message = requestError instanceof TypeError
        ? `Connexion au service CRM impossible pour ${action}. Vérifiez votre connexion puis réessayez.`
        : `Impossible de traiter la demande CRM pour ${action}. Réessayez.`;
      return { success: false, error: message };
    } finally {
      if (showLoading) this._isLoading.set(false);
    }
  }

  private mapClient(row: Record<string, unknown>): CrmClient {
    const rawNotes = String(row['notes'] ?? '');
    let country: string | null = typeof row['country'] === 'string' && row['country'].trim()
      ? row['country'].trim()
      : null;
    let contactRole: string | null = typeof row['contactRole'] === 'string' && row['contactRole'].trim()
      ? row['contactRole'].trim()
      : typeof row['contact_role'] === 'string' && row['contact_role'].trim()
        ? row['contact_role'].trim()
        : null;

    if (!country && rawNotes) {
      if (rawNotes.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(rawNotes) as { country?: string; contactRole?: string };
          if (typeof parsed.country === 'string' && parsed.country.trim()) country = parsed.country.trim();
          if (typeof parsed.contactRole === 'string' && parsed.contactRole.trim() && !contactRole) {
            contactRole = parsed.contactRole.trim();
          }
        } catch {
          country = rawNotes.trim();
        }
      } else {
        country = rawNotes.trim();
      }
    }

    const source = typeof row['source'] === 'string' && row['source'].trim() ? row['source'].trim() : null;
    const sector = typeof row['sector'] === 'string' && row['sector'].trim()
      ? row['sector'].trim()
      : source;

    return {
      id: String(row['id'] ?? ''),
      name: String(row['name'] ?? ''),
      companyName: typeof row['companyName'] === 'string' ? row['companyName']
        : typeof row['company_name'] === 'string' ? row['company_name'] : null,
      contactName: typeof row['contactName'] === 'string' ? row['contactName']
        : typeof row['contact_name'] === 'string' ? row['contact_name'] : null,
      contactRole,
      email: typeof row['email'] === 'string' ? row['email'] : null,
      phone: typeof row['phone'] === 'string' ? row['phone'] : null,
      country,
      sector,
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
