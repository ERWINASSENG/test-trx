import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDropList,
  CdkDropListGroup,
} from '@angular/cdk/drag-drop';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  CRM_OPPORTUNITY_STAGES,
  CrmActivity,
  CrmActivityType,
  CrmClient,
  CrmDirection,
  CrmOpportunity,
  CrmOpportunityStage,
  CrmTransportMode,
} from '../../core/models/crm.model';
import type { QuoteStatus } from '../../core/models/quote.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { CrmService } from '../../core/services/crm.service';
import { ModuleControlPanel } from '../../shared/components/module-control-panel/module-control-panel';
import { getCountryFlagUrl } from '../../core/utils/country-flag.util';

export interface PipelineStageColumn {
  stage: CrmOpportunityStage;
  label: string;
  opportunities: CrmOpportunity[];
}

type CrmTab = 'pipeline' | 'clients' | 'activities' | 'campaigns';
export type ClientSortField = 'client' | 'country' | 'sector' | 'contact' | 'phone' | 'email' | 'status';
type CrmDialog = 'client' | 'opportunity' | 'activity' | 'campaign' | 'win' | 'dossier' | 'contact' | null;
interface OpportunityDraft {
  title: string;
  prospectId: string;
  transportMode: CrmTransportMode | '';
  direction: CrmDirection | '';
  origin: string;
  destination: string;
  goodsDescription: string;
  weightKg: string;
  volumeM3: string;
  incoterm: string;
  estimatedValue: string;
  currency: string;
  expectedCloseDate: string;
  notes: string;
}

const STAGE_LABELS: Record<CrmOpportunityStage, string> = {
  new: 'Nouveau',
  qualified: 'Qualifié',
  quote_preparation: 'Cotation à préparer',
  quote_sent: 'Cotation envoyée',
  negotiation: 'Négociation',
  won: 'Gagné',
  lost: 'Perdu',
};

const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  accepted: 'Acceptée',
  rejected: 'Refusée',
  expired: 'Expirée',
};

const CLIENT_STATUS_LABELS: Record<string, string> = {
  new: 'Nouveau',
  contacted: 'Contacté',
  qualified: 'Qualifié',
  converted: 'Client',
  lost: 'Perdu',
};

const ACTIVITY_LABELS: Record<CrmActivityType, string> = {
  call: 'Appel',
  email: 'E-mail à envoyer',
  meeting: 'Rendez-vous',
  task: 'Tâche',
};

const EMPTY_OPPORTUNITY: OpportunityDraft = {
  title: '',
  prospectId: '',
  transportMode: '',
  direction: '',
  origin: '',
  destination: '',
  goodsDescription: '',
  weightKg: '',
  volumeM3: '',
  incoterm: '',
  estimatedValue: '0',
  currency: 'XAF',
  expectedCloseDate: '',
  notes: '',
};

@Component({
  selector: 'app-crm-commercial',
  imports: [
    DatePipe,
    FormsModule,
    MatIconModule,
    ModuleControlPanel,
    RouterLink,
    CdkDropListGroup,
    CdkDropList,
    CdkDrag,
  ],
  templateUrl: './crm.html',
  styleUrl: './crm.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CrmComponent {
  public readonly crmService = inject(CrmService);
  private readonly accessControl = inject(AccessControlService);
  private readonly route = inject(ActivatedRoute);

  public readonly tabs: { id: CrmTab; label: string }[] = [
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'clients', label: 'Clients' },
    { id: 'activities', label: 'Tâches & relances' },
    { id: 'campaigns', label: 'Campagnes' },
  ];
  public readonly stages = CRM_OPPORTUNITY_STAGES;
  public readonly activityTypes = Object.entries(ACTIVITY_LABELS) as [CrmActivityType, string][];
  public readonly clientStatuses = Object.entries(CLIENT_STATUS_LABELS) as [string, string][];
  public readonly tab = signal<CrmTab>('pipeline');
  public readonly search = signal('');
  public readonly page = signal(1);
  private readonly pageSize = 80;
  public readonly dialog = signal<CrmDialog>(null);
  public readonly feedback = signal<string | null>(null);
  public readonly formError = signal<string | null>(null);
  public readonly isSaving = signal(false);
  public readonly selectedClientId = signal<string | null>(null);
  public readonly focusedContactId = signal<string | null>(null);
  public readonly focusedOpportunityId = signal<string | null>(null);
  public readonly focusedActivityId = signal<string | null>(null);
  public readonly dialogOpportunityId = signal<string | null>(null);
  public readonly editingOpportunityId = signal<string | null>(null);
  public readonly opportunityDraft = signal<OpportunityDraft>({ ...EMPTY_OPPORTUNITY });
  public readonly clientDraft = signal({
    companyName: '',
    contactName: '',
    contactRole: '',
    email: '',
    phone: '',
    country: '',
    sector: '',
  });
  public readonly contactDraft = signal({ fullName: '', jobTitle: '', email: '', phone: '' });
  public readonly activityDraft = signal({
    prospectId: '',
    opportunityId: '',
    contactId: '',
    activityType: 'call' as CrmActivityType,
    title: '',
    dueAt: '',
    notes: '',
  });
  public readonly campaignDraft = signal({
    name: '',
    startsAt: '',
    endsAt: '',
    countries: '',
    statuses: [] as string[],
    transportModes: [] as string[],
    notes: '',
  });
  public readonly contractReference = signal('');
  public readonly dossierDraft = signal({ noDossier: '', description: '' });
  public readonly canCreate = computed(() => this.accessControl.hasPermission('crm.create'));
  public readonly canUpdate = computed(() => this.accessControl.hasPermission('crm.update'));
  public readonly canManageCampaigns = computed(() => this.accessControl.hasPermission('crm.campaigns.manage'));
  public readonly filteredOpportunities = computed(() => {
    const query = this.search().trim().toLocaleLowerCase('fr');
    const rows = this.crmService.opportunities();
    const opportunityId = this.focusedOpportunityId();
    if (opportunityId) return rows.filter((row) => row.id === opportunityId);
    if (!query) return rows;
    return rows.filter((row) => [
      row.title,
      row.client.companyName || row.client.name,
      row.client.contactName || '',
      row.origin || '',
      row.destination || '',
      row.quoteNumber || '',
    ].some((value) => value.toLocaleLowerCase('fr').includes(query)));
  });
  public readonly stageColumns = computed(() => this.stages.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    opportunities: this.filteredOpportunities().filter((opportunity) => opportunity.stage === stage),
  })));
  public readonly filteredClients = computed(() => {
    const query = this.search().trim().toLocaleLowerCase('fr');
    const clients = this.crmService.clients().filter((client) => client.status === 'converted');
    if (!query) return clients;
    return clients.filter((client) =>
      `${client.companyName || client.name} ${client.contactName || ''} ${client.country || ''} ${client.email || ''}`
        .toLocaleLowerCase('fr').includes(query)
    );
  });
  public readonly filteredActivities = computed(() => {
    const focusedId = this.focusedActivityId();
    if (focusedId) {
      return this.crmService.activities().filter((activity) => activity.id === focusedId);
    }
    const query = this.search().trim().toLocaleLowerCase('fr');
    const activities = this.crmService.activities();
    if (!query) return activities;
    return activities.filter((activity) =>
      `${activity.title} ${activity.clientName} ${activity.contactName || ''} ${this.activityLabel(activity.activityType)}`
        .toLocaleLowerCase('fr').includes(query)
    );
  });
  public readonly filteredCampaigns = computed(() => {
    const query = this.search().trim().toLocaleLowerCase('fr');
    const campaigns = this.crmService.campaigns();
    if (!query) return campaigns;
    return campaigns.filter((campaign) =>
      `${campaign.name} ${campaign.notes || ''} ${campaign.filters.countries.join(' ')}`
        .toLocaleLowerCase('fr').includes(query)
    );
  });
  public readonly resultCount = computed(() => {
    switch (this.tab()) {
      case 'pipeline': return this.filteredOpportunities().length;
      case 'clients': return this.filteredClients().length;
      case 'activities': return this.filteredActivities().length;
      case 'campaigns': return this.filteredCampaigns().length;
    }
  });
  public readonly pageCount = computed(() => Math.max(1, Math.ceil(this.resultCount() / this.pageSize)));
  public readonly currentPage = computed(() => Math.min(this.page(), this.pageCount()));
  public readonly pageStart = computed(() =>
    this.resultCount() === 0 ? 0 : (this.currentPage() - 1) * this.pageSize + 1
  );
  public readonly pageEnd = computed(() => Math.min(this.currentPage() * this.pageSize, this.resultCount()));
  public readonly paginationLabel = computed(() => {
    const pad = (value: number) => (value < 10 ? `0${value}` : `${value}`);
    return `${pad(this.pageStart())}-${pad(this.pageEnd())} / ${pad(this.resultCount())}`;
  });
  public readonly currentTabLabel = computed(() =>
    this.tabs.find((item) => item.id === this.tab())?.label ?? 'Pipeline'
  );
  public readonly visibleOpportunities = computed(() => this.pageItems(this.filteredOpportunities()));
  public readonly visibleClients = computed(() => this.pageItems(this.filteredClients()));
  public readonly visibleActivities = computed(() => this.pageItems(this.filteredActivities()));
  public readonly visibleCampaigns = computed(() => this.pageItems(this.filteredCampaigns()));
  public readonly canCreateCurrentItem = computed(() =>
    this.tab() === 'campaigns' ? this.canManageCampaigns() : this.canCreate()
  );
  public readonly pendingActivities = computed(() =>
    this.crmService.activities().filter((activity) => activity.status === 'pending')
  );
  public readonly openOpportunityCount = computed(() =>
    this.filteredOpportunities().filter((opportunity) => opportunity.stage !== 'won' && opportunity.stage !== 'lost').length
  );
  public readonly openPipelineValue = computed(() =>
    this.filteredOpportunities()
      .filter((opportunity) => opportunity.stage !== 'won' && opportunity.stage !== 'lost')
      .reduce((sum, opportunity) => sum + opportunity.estimatedValue, 0)
  );
  public readonly selectedClient = computed(() =>
    this.crmService.clients().find((client) => client.id === this.selectedClientId()) || null
  );
  public readonly selectedClientContacts = computed(() =>
    this.crmService.contacts().filter((contact) => contact.prospectId === this.selectedClientId())
  );

  // Gestion du tri et de la sélection du tableau Clients (style Odoo)
  public readonly clientSortField = signal<ClientSortField>('client');
  public readonly clientSortDirection = signal<'asc' | 'desc'>('asc');
  public readonly selectedClientIds = signal<Set<string>>(new Set());

  public toggleClientSort(field: ClientSortField): void {
    if (this.clientSortField() === field) {
      this.clientSortDirection.update((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      this.clientSortField.set(field);
      this.clientSortDirection.set('asc');
    }
  }

  public getClientSortIcon(field: ClientSortField): string {
    if (this.clientSortField() !== field) return 'unfold_more';
    return this.clientSortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  public getClientAriaSort(field: ClientSortField): 'ascending' | 'descending' | 'none' {
    if (this.clientSortField() !== field) return 'none';
    return this.clientSortDirection() === 'asc' ? 'ascending' : 'descending';
  }

  public readonly sortedClients = computed(() => {
    const list = this.visibleClients();
    const field = this.clientSortField();
    if (!field) return list;

    const multiplier = this.clientSortDirection() === 'asc' ? 1 : -1;

    return [...list].sort((a, b) => {
      let valA = '';
      let valB = '';

      switch (field) {
        case 'client':
          valA = a.companyName || a.name || '';
          valB = b.companyName || b.name || '';
          break;
        case 'country':
          valA = a.country || '';
          valB = b.country || '';
          break;
        case 'sector':
          valA = a.sector || '';
          valB = b.sector || '';
          break;
        case 'contact':
          valA = a.contactName || '';
          valB = b.contactName || '';
          break;
        case 'phone':
          valA = a.phone || '';
          valB = b.phone || '';
          break;
        case 'email':
          valA = a.email || '';
          valB = b.email || '';
          break;
        case 'status':
          valA = this.getDisplayStatus(a.status).label;
          valB = this.getDisplayStatus(b.status).label;
          break;
      }

      return valA.localeCompare(valB, 'fr', { sensitivity: 'base', numeric: true }) * multiplier;
    });
  });

  public readonly isAllClientsSelected = computed(() => {
    const list = this.sortedClients();
    if (list.length === 0) return false;
    const selected = this.selectedClientIds();
    return list.every((client) => selected.has(client.id));
  });

  public toggleSelectAllClients(): void {
    const current = this.selectedClientIds();
    const list = this.sortedClients();
    if (this.isAllClientsSelected()) {
      this.selectedClientIds.set(new Set());
    } else {
      const next = new Set(current);
      for (const item of list) {
        next.add(item.id);
      }
      this.selectedClientIds.set(next);
    }
  }

  public toggleSelectClient(id: string): void {
    const current = new Set(this.selectedClientIds());
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    this.selectedClientIds.set(current);
  }

  public isClientSelected(id: string): boolean {
    return this.selectedClientIds().has(id);
  }

  public constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const requestedTab = params.get('view');
      const nextTab = this.tabs.find((item) => item.id === requestedTab)?.id ?? 'pipeline';
      this.focusedOpportunityId.set(params.get('opportunityId'));
      this.focusedActivityId.set(params.get('activityId'));
      this.selectedClientId.set(params.get('prospectId'));
      this.focusedContactId.set(params.get('contactId'));
      if (this.tab() !== nextTab) {
        this.tab.set(nextTab);
        this.search.set('');
        this.page.set(1);
      }
    });
    void this.crmService.load();
  }

  public setSearch(value: string): void {
    this.search.set(value);
    this.page.set(1);
  }

  public previousPage(): void {
    this.page.set(Math.max(1, this.currentPage() - 1));
  }

  public nextPage(): void {
    this.page.set(Math.min(this.pageCount(), this.currentPage() + 1));
  }

  private pageItems<T>(items: T[]): T[] {
    const start = (this.currentPage() - 1) * this.pageSize;
    return items.slice(start, start + this.pageSize);
  }

  public setOpportunity<K extends keyof OpportunityDraft>(key: K, value: OpportunityDraft[K]): void {
    this.opportunityDraft.update((draft) => ({ ...draft, [key]: value }));
  }

  public setClientField(key: keyof ReturnType<typeof this.clientDraft>, value: string): void {
    this.clientDraft.update((draft) => ({ ...draft, [key]: value }));
  }

  public setActivityField(key: keyof ReturnType<typeof this.activityDraft>, value: string): void {
    this.activityDraft.update((draft) => key === 'prospectId'
      ? { ...draft, prospectId: value, opportunityId: '', contactId: '' }
      : { ...draft, [key]: value });
  }

  public setCampaignField(key: 'name' | 'startsAt' | 'endsAt' | 'countries' | 'notes', value: string): void {
    this.campaignDraft.update((draft) => ({ ...draft, [key]: value }));
  }

  public setContactField(key: keyof ReturnType<typeof this.contactDraft>, value: string): void {
    this.contactDraft.update((draft) => ({ ...draft, [key]: value }));
  }

  public setDossierField(key: 'noDossier' | 'description', value: string): void {
    this.dossierDraft.update((draft) => ({ ...draft, [key]: value }));
  }

  public stageLabel(stage: CrmOpportunityStage): string {
    return STAGE_LABELS[stage];
  }

  public quoteStatusLabel(status: QuoteStatus): string {
    return QUOTE_STATUS_LABELS[status];
  }

  public stageClass(stage: CrmOpportunityStage): string {
    return `stage-${stage.replaceAll('_', '-')}`;
  }

  public clientStatusLabel(status: string): string {
    return CLIENT_STATUS_LABELS[status] || status;
  }

  public getCountryFlag(country: string | null | undefined): string | null {
    return getCountryFlagUrl(country);
  }

  public getMonogram(name: string | null | undefined): string {
    if (!name) return 'CL';
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 1) {
      return words[0].slice(0, 2).toUpperCase();
    }
    if (words.length === 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return (words[0][0] + words[1][0] + words[2][0]).toUpperCase().slice(0, 3);
  }

  public getAvatarBg(name: string | null | undefined): string {
    const palettes = [
      '#0a3d62', '#1e3799', '#0c2461', '#1e272e',
      '#079992', '#38ada9', '#0097e6', '#273c75',
    ];
    let hash = 0;
    const str = name || 'transmex';
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % palettes.length;
    return palettes[index];
  }

  public getDisplayStatus(status: string | null | undefined): { label: string; class: string } {
    if (status === 'converted' || status === 'qualified') {
      return { label: 'Actif', class: 'status-badge-active' };
    }
    if (status === 'lost') {
      return { label: 'Perdu', class: 'status-badge-lost' };
    }
    return { label: 'Prospect', class: 'status-badge-prospect' };
  }

  public activityLabel(type: CrmActivityType): string {
    return ACTIVITY_LABELS[type];
  }

  public clientName(client: CrmClient): string {
    return client.companyName || client.name;
  }

  public modeLabel(mode: string | null): string {
    return mode === 'air' ? 'Aérien' : mode === 'sea' ? 'Maritime' : 'Transport à préciser';
  }

  public directionLabel(direction: string | null): string {
    return direction === 'import' ? 'Import' : direction === 'export' ? 'Export' : '';
  }

  public formatAmount(amount: number, currency: string): string {
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
  }

  public openNewDialog(): void {
    switch (this.tab()) {
      case 'pipeline':
        this.openOpportunityDialog();
        break;
      case 'clients':
        this.openClientDialog();
        break;
      case 'activities':
        this.openActivityDialog();
        break;
      case 'campaigns':
        this.openCampaignDialog();
        break;
    }
  }

  public openClientDialog(): void {
    if (!this.canCreate()) return;
    this.clientDraft.set({ companyName: '', contactName: '', contactRole: '', email: '', phone: '', country: '', sector: '' });
    this.openDialog('client');
  }

  public openOpportunityDialog(target?: string | CrmOpportunity): void {
    if (typeof target === 'object' && target !== null) {
      if (!this.canUpdate()) return;
      this.editingOpportunityId.set(target.id);
      this.opportunityDraft.set({
        prospectId: target.prospectId,
        title: target.title,
        transportMode: target.transportMode || '',
        direction: target.direction || '',
        origin: target.origin || '',
        destination: target.destination || '',
        goodsDescription: target.goodsDescription || '',
        weightKg: target.weightKg !== null && target.weightKg !== undefined ? String(target.weightKg) : '',
        volumeM3: target.volumeM3 !== null && target.volumeM3 !== undefined ? String(target.volumeM3) : '',
        incoterm: target.incoterm || '',
        estimatedValue: target.estimatedValue ? String(target.estimatedValue) : '',
        currency: target.currency || 'XAF',
        expectedCloseDate: target.expectedCloseDate || '',
        notes: target.notes || '',
      });
      this.openDialog('opportunity');
      return;
    }

    if (!this.canCreate()) return;
    this.editingOpportunityId.set(null);
    this.opportunityDraft.set({ ...EMPTY_OPPORTUNITY, prospectId: target || '' });
    this.openDialog('opportunity');
  }

  public openActivityDialog(opportunity?: CrmOpportunity): void {
    if (!this.canCreate() || this.crmService.clients().length === 0) return;
    this.activityDraft.set({
      prospectId: opportunity?.prospectId || this.crmService.clients()[0].id,
      opportunityId: opportunity?.id || '',
      contactId: '',
      activityType: 'call',
      title: '',
      dueAt: '',
      notes: '',
    });
    this.openDialog('activity');
  }

  public openCampaignDialog(): void {
    if (!this.canManageCampaigns()) return;
    this.campaignDraft.set({ name: '', startsAt: '', endsAt: '', countries: '', statuses: [], transportModes: [], notes: '' });
    this.openDialog('campaign');
  }

  public openContactDialog(client: CrmClient): void {
    if (!this.canCreate()) return;
    this.selectedClientId.set(client.id);
    this.contactDraft.set({ fullName: '', jobTitle: '', email: '', phone: '' });
    this.openDialog('contact');
  }

  public openWinDialog(opportunity: CrmOpportunity): void {
    if (!this.canUpdate()) return;
    this.dialogOpportunityId.set(opportunity.id);
    this.contractReference.set('');
    this.formError.set(null);
    this.dialog.set('win');
  }

  public openDossierDialog(opportunity: CrmOpportunity): void {
    if (!this.canCreate() || opportunity.stage !== 'won' || opportunity.dossierNumber) return;
    this.dialogOpportunityId.set(opportunity.id);
    this.dossierDraft.set({ noDossier: '', description: '' });
    this.openDialog('dossier');
  }

  public closeDialog(): void {
    if (this.isSaving()) return;
    this.dialog.set(null);
    this.editingOpportunityId.set(null);
    this.formError.set(null);
  }

  public async saveClient(): Promise<void> {
    const draft = this.clientDraft();
    if (draft.companyName.trim().length < 2) {
      this.formError.set('Saisissez le nom de la société.');
      return;
    }
    const result = await this.save(() => this.crmService.createClient(draft));
    if (result) {
      this.feedback.set('Société enregistrée dans le fichier clients/prospects.');
      this.selectedClientId.set(result.id);
    }
  }

  public async saveContact(): Promise<void> {
    const clientId = this.selectedClientId();
    const draft = this.contactDraft();
    if (!clientId || draft.fullName.trim().length < 2) {
      this.formError.set('Saisissez le nom du contact.');
      return;
    }
    const result = await this.save(() => this.crmService.createContact(clientId, draft));
    if (result) this.feedback.set('Contact ajouté à la société.');
  }

  public async saveOpportunity(): Promise<void> {
    const draft = this.opportunityDraft();
    if (!draft.prospectId || draft.title.trim().length < 2) {
      this.formError.set('Sélectionnez une société et donnez un titre à l’opportunité.');
      return;
    }
    const editId = this.editingOpportunityId();
    if (editId) {
      const result = await this.save(() => this.crmService.updateOpportunity(editId, {
        prospectId: draft.prospectId,
        title: draft.title.trim(),
        transportMode: draft.transportMode || null,
        direction: draft.direction || null,
        origin: draft.origin.trim() || null,
        destination: draft.destination.trim() || null,
        goodsDescription: draft.goodsDescription.trim() || null,
        weightKg: draft.weightKg ? Number(draft.weightKg) : null,
        volumeM3: draft.volumeM3 ? Number(draft.volumeM3) : null,
        incoterm: draft.incoterm.trim() || null,
        estimatedValue: Number(draft.estimatedValue || 0),
        currency: draft.currency || 'XAF',
        expectedCloseDate: draft.expectedCloseDate || null,
        notes: draft.notes.trim() || null,
      }));
      if (result) this.feedback.set('Opportunité mise à jour avec succès.');
      return;
    }

    const result = await this.save(() => this.crmService.createOpportunity({
      prospectId: draft.prospectId,
      title: draft.title.trim(),
      transportMode: draft.transportMode || null,
      direction: draft.direction || null,
      origin: draft.origin.trim() || null,
      destination: draft.destination.trim() || null,
      goodsDescription: draft.goodsDescription.trim() || null,
      weightKg: draft.weightKg ? Number(draft.weightKg) : null,
      volumeM3: draft.volumeM3 ? Number(draft.volumeM3) : null,
      incoterm: draft.incoterm.trim() || null,
      estimatedValue: Number(draft.estimatedValue || 0),
      currency: draft.currency,
      expectedCloseDate: draft.expectedCloseDate || null,
      notes: draft.notes.trim() || null,
    }));
    if (result) this.feedback.set('Opportunité ajoutée au pipeline.');
  }

  public onOpportunityDrop(event: CdkDragDrop<PipelineStageColumn, PipelineStageColumn, CrmOpportunity>): void {
    if (event.previousContainer === event.container) {
      return;
    }
    const targetStage = event.container.data.stage;
    const opportunity = event.item.data;
    if (!opportunity || opportunity.stage === targetStage) {
      return;
    }
    void this.changeStage(opportunity, targetStage);
  }

  public async changeStage(opportunity: CrmOpportunity, stage: CrmOpportunityStage): Promise<void> {
    if (!this.canUpdate() || stage === opportunity.stage) return;
    if (opportunity.stage === 'won') {
      this.setFeedback('Une opportunité gagnée ne peut pas être déplacée vers une autre étape.');
      return;
    }
    if (stage === 'won') {
      this.openWinDialog(opportunity);
      return;
    }
    const result = await this.crmService.updateOpportunityStageOptimistic(opportunity.id, stage);
    this.setFeedback(result.success ? `Étape mise à jour : ${this.stageLabel(stage)}.` : result.error);
  }

  public async confirmWon(): Promise<void> {
    const id = this.dialogOpportunityId();
    const reference = this.contractReference().trim();
    if (!id || !reference) {
      this.formError.set('Saisissez la référence du contrat signé.');
      return;
    }
    const result = await this.save(() => this.crmService.updateOpportunity(id, {
      stage: 'won',
      wonReason: 'signed_contract',
      contractReference: reference,
    }));
    if (result) this.feedback.set('Opportunité gagnée après confirmation du contrat signé.');
  }

  public async saveActivity(): Promise<void> {
    const draft = this.activityDraft();
    if (!draft.prospectId || draft.title.trim().length < 2) {
      this.formError.set('Choisissez une société et saisissez l’objet du rappel.');
      return;
    }
    const result = await this.save(() => this.crmService.createActivity({
      prospectId: draft.prospectId,
      ...(draft.opportunityId ? { opportunityId: draft.opportunityId } : {}),
      ...(draft.contactId ? { contactId: draft.contactId } : {}),
      activityType: draft.activityType,
      title: draft.title,
      dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null,
      notes: draft.notes || null,
    }));
    if (result) this.feedback.set('Rappel ajouté à votre liste de tâches.');
  }

  public async completeActivity(activity: CrmActivity): Promise<void> {
    if (!this.canUpdate() || activity.status !== 'pending') return;
    const result = await this.crmService.updateActivityStatus(activity.id, 'completed');
    this.setFeedback(result.success ? 'Tâche terminée.' : result.error);
  }

  public toggleCampaignStatus(status: string): void {
    this.campaignDraft.update((draft) => ({
      ...draft,
      statuses: draft.statuses.includes(status)
        ? draft.statuses.filter((item) => item !== status)
        : [...draft.statuses, status],
    }));
  }

  public toggleCampaignMode(mode: string): void {
    this.campaignDraft.update((draft) => ({
      ...draft,
      transportModes: draft.transportModes.includes(mode)
        ? draft.transportModes.filter((item) => item !== mode)
        : [...draft.transportModes, mode],
    }));
  }

  public async saveCampaign(): Promise<void> {
    const draft = this.campaignDraft();
    if (draft.name.trim().length < 2) {
      this.formError.set('Saisissez le nom de la campagne.');
      return;
    }
    const result = await this.save(() => this.crmService.createCampaign({
      name: draft.name,
      startsAt: draft.startsAt || null,
      endsAt: draft.endsAt || null,
      notes: draft.notes || null,
      filters: {
        statuses: draft.statuses,
        countries: draft.countries.split(',').map((country) => country.trim()).filter(Boolean),
        transportModes: draft.transportModes,
        assignedTo: null,
      },
    }));
    if (result) this.feedback.set('Campagne planifiée. Aucun message n’a été envoyé.');
  }

  public async prepareCampaign(campaignId: string): Promise<void> {
    const result = await this.crmService.prepareCampaign(campaignId);
    this.setFeedback(result.success
      ? `Ciblage préparé pour ${result.data?.audienceCount ?? 0} société(s). Aucun e-mail ou SMS n’a été envoyé.`
      : result.error);
  }

  public async saveDossier(): Promise<void> {
    const id = this.dialogOpportunityId();
    const draft = this.dossierDraft();
    if (!id || !draft.noDossier.trim()) {
      this.formError.set('Saisissez le numéro du dossier après vérification.');
      return;
    }
    const result = await this.save(() => this.crmService.createDossier(id, draft));
    if (result) this.feedback.set(`Dossier ${result.no_dossier} créé et lié à l’opportunité.`);
  }

  private openDialog(dialog: Exclude<CrmDialog, null>): void {
    this.formError.set(null);
    this.dialog.set(dialog);
  }

  private async save<T extends { id?: string }>(
    operation: () => Promise<{ success: boolean; data?: T; error?: string }>
  ): Promise<T | null> {
    if (this.isSaving()) return null;
    this.isSaving.set(true);
    this.formError.set(null);
    const result = await operation();
    this.isSaving.set(false);
    if (!result.success || !result.data) {
      this.formError.set(result.error || 'Impossible d’enregistrer les modifications.');
      return null;
    }
    this.dialog.set(null);
    return result.data;
  }

  private setFeedback(message: string | undefined): void {
    if (message) this.feedback.set(message);
  }
}
