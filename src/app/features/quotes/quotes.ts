import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { QuoteInput, QuoteService } from '../../core/services/quote.service';
import {
  QUOTE_COLUMN_TYPES,
  QUOTE_STATUSES,
  QuoteColumn,
  QuoteColumnType,
  QuoteRow,
  QuoteStatus,
  SalesQuote,
  SeaFreightDetails,
} from '../../core/models/quote.model';
import { ModuleControlPanel } from '../../shared/components/module-control-panel/module-control-panel';

const generateSecureUUID = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  accepted: 'Acceptée',
  rejected: 'Refusée',
  expired: 'Expirée',
};

const COLUMN_TYPE_LABELS: Record<QuoteColumnType, string> = {
  text: 'Texte',
  number: 'Nombre',
  amount: 'Montant',
  date: 'Date',
  checkbox: 'Case',
};

interface QuoteStatusColumn {
  status: QuoteStatus;
  quotes: SalesQuote[];
}

@Component({
  selector: 'app-quotes',
  imports: [DatePipe, MatIconModule, ModuleControlPanel, RouterLink],
  templateUrl: './quotes.html',
  styleUrls: ['./quotes.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuotesComponent {
  @Input() public linkedProspectId?: string;
  @Input() public linkedOpportunityId?: string;

  public readonly quoteService = inject(QuoteService);
  private readonly accessControl = inject(AccessControlService);
  private readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  public readonly statuses = QUOTE_STATUSES;
  public readonly columnTypes = QUOTE_COLUMN_TYPES;
  public readonly pageSize = 12;

  public readonly view = signal<'list' | 'kanban'>('list');
  public readonly quoteSearch = signal('');
  public readonly focusedQuoteId = signal<string | null>(null);
  public readonly statusFilter = signal<string>('');
  public readonly pageIndex = signal(0);

  public readonly currentUserId = computed(() => this.authService.currentUser()?.id || null);
  public readonly canCreate = computed(() => this.accessControl.hasPermission('quotes.create'));
  public readonly canUpdate = computed(() => this.accessControl.hasPermission('quotes.update'));
  public readonly canDelete = computed(() => this.accessControl.hasPermission('quotes.delete'));
  public readonly canAssign = computed(() => this.accessControl.hasPermission('quotes.assign'));
  public readonly canSaveTemplate = computed(() => this.accessControl.hasPermission('quotes.templates.create'));
  public readonly canDeleteTemplate = computed(() => this.accessControl.hasPermission('quotes.templates.delete'));

  public readonly totalColumnOptions = computed(() =>
    this.columns().filter((column) => column.type === 'amount')
  );

  public readonly filteredQuotes = computed(() => {
    const query = this.quoteSearch().trim().toLocaleLowerCase('fr');
    const quotes = this.quoteService.quotes();
    const quoteId = this.focusedQuoteId();
    if (quoteId) return quotes.filter((quote) => quote.id === quoteId);
    if (!query) return quotes;
    return quotes.filter((quote) =>
      quote.quoteNumber.toLocaleLowerCase('fr').includes(query) ||
      quote.title.toLocaleLowerCase('fr').includes(query) ||
      (quote.prospectName && quote.prospectName.toLocaleLowerCase('fr').includes(query)) ||
      (quote.contactName && quote.contactName.toLocaleLowerCase('fr').includes(query)) ||
      (quote.dossierNumber && quote.dossierNumber.toLocaleLowerCase('fr').includes(query)) ||
      (quote.assignedToName && quote.assignedToName.toLocaleLowerCase('fr').includes(query)) ||
      (quote.seaFreight?.portOfLoading && quote.seaFreight.portOfLoading.toLocaleLowerCase('fr').includes(query)) ||
      (quote.seaFreight?.portOfDischarge && quote.seaFreight.portOfDischarge.toLocaleLowerCase('fr').includes(query))
    );
  });

  public readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredQuotes().length / this.pageSize))
  );
  public readonly displayedQuotes = computed(() => {
    const start = this.pageIndex() * this.pageSize;
    return this.filteredQuotes().slice(start, start + this.pageSize);
  });
  public readonly statusColumns = computed<QuoteStatusColumn[]>(() =>
    this.statuses.map((status) => ({
      status,
      quotes: this.displayedQuotes().filter((quote) => quote.status === status),
    }))
  );
  public readonly paginationLabel = computed(() => {
    const total = this.filteredQuotes().length;
    if (total === 0) return '0 résultat(s)';
    const first = this.pageIndex() * this.pageSize + 1;
    return `${first}–${Math.min(first + this.pageSize - 1, total)} sur ${total}`;
  });
  public readonly canPrevPage = computed(() => this.pageIndex() > 0);
  public readonly canNextPage = computed(() => (this.pageIndex() + 1) * this.pageSize < this.filteredQuotes().length);

  public readonly draftTotal = computed(() => {
    const totalId = this.totalColumnId();
    return this.rows().reduce((sum, row) => {
      const value = row[totalId];
      return sum + (typeof value === 'number' ? value : 0);
    }, 0);
  });

  // États du formulaire modal Fiche Maritime Transimex
  public readonly isEditorOpen = signal(false);
  public readonly editingId = signal<string | null>(null);
  public readonly isSaving = signal(false);
  public readonly error = signal<string | null>(null);
  public readonly feedback = signal<string | null>(null);

  // Informations générales
  public readonly clientSearch = signal('');
  public readonly prospectId = signal('');
  public readonly contactId = signal('');
  public readonly opportunityId = signal<string | null>(null);
  public readonly assignedTo = signal('');
  public readonly title = signal('Cotation Fret Maritime Transimex');
  public readonly currency = signal('XAF');
  public readonly status = signal<QuoteStatus>('draft');
  public readonly validUntil = signal('');

  // 1. Informations client (Maritime)
  public readonly seaContactName = signal('');
  public readonly seaPhone = signal('');
  public readonly seaEmail = signal('');
  public readonly seaAddress = signal('');

  // 2. Détails expédition
  public readonly seaGoodsType = signal('');
  public readonly seaGoodsDescription = signal('');
  public readonly seaGrossWeightKg = signal<number | null>(null);
  public readonly seaTotalVolumeM3 = signal<number | null>(null);
  public readonly seaPackagesCount = signal<number | null>(null);
  public readonly seaPackagingType = signal('');

  // 3. Itinéraire
  public readonly seaPortOfLoading = signal('');
  public readonly seaPortOfDischarge = signal('');
  public readonly seaIncoterm = signal('');
  public readonly seaNeedInlandTransport = signal(false);
  public readonly seaEstimatedDepartureDate = signal<string | null>(null);
  public readonly seaEstimatedArrivalDate = signal<string | null>(null);

  // 4. Type de service
  public readonly serviceFcl = signal(false);
  public readonly serviceLcl = signal(false);
  public readonly serviceRoro = signal(false);
  public readonly serviceBreakBulk = signal(false);
  public readonly serviceOther = signal('');

  // 5. Documents disponibles
  public readonly docCommercialInvoice = signal(false);
  public readonly docPackingList = signal(false);
  public readonly docCertificateOfOrigin = signal(false);
  public readonly docMsdsTechnicalSheet = signal(false);
  public readonly docOther = signal('');

  // 6. Services additionnels requis
  public readonly addonCustomsClearance = signal(false);
  public readonly addonCargoInsurance = signal(false);
  public readonly addonWarehousing = signal(false);
  public readonly addonPortHandling = signal(false);
  public readonly addonTracking = signal(false);

  // 7. Chiffrage dynamique
  public readonly columns = signal<QuoteColumn[]>([]);
  public readonly rows = signal<QuoteRow[]>([]);
  public readonly totalColumnId = signal('');
  public readonly columnLabelDraft = signal('');
  public readonly columnTypeDraft = signal<QuoteColumnType>('amount');

  // Modèle partagé & Création rapide de prospect
  public readonly saveTemplate = signal(false);
  public readonly templateName = signal('');
  public readonly selectedTemplateId = signal('');
  public readonly showNewProspect = signal(false);
  public readonly newProspectContact = signal('');
  public readonly newProspectEmail = signal('');
  public readonly newProspectPhone = signal('');
  public readonly isCreatingProspect = signal(false);

  public constructor() {
    this.focusedQuoteId.set(this.route.snapshot.queryParamMap.get('quoteId'));
    const search = this.route.snapshot.queryParamMap.get('search');
    if (search) this.searchQuotes(search);
    void this.load().then(async () => {
      const prospectId = this.route.snapshot.queryParamMap.get('prospectId') || this.linkedProspectId;
      const opportunityId = this.route.snapshot.queryParamMap.get('opportunityId') || this.linkedOpportunityId;
      const contactId = this.route.snapshot.queryParamMap.get('contactId');
      if (!prospectId || !this.canCreate()) return;
      const prospect = this.quoteService.prospects().find((item) => item.id === prospectId);
      if (!prospect) {
        this.error.set('La société liée à la demande CRM est introuvable ou inaccessible.');
        return;
      }
      this.openCreate();
      await this.onProspectSelected(prospect.id);
      this.opportunityId.set(opportunityId || null);
      if (contactId) {
        if (this.quoteService.contacts().some((contact) => contact.id === contactId)) this.onContactSelected(contactId);
        else this.error.set('Le contact demandé ne correspond pas à la société sélectionnée.');
      }
    });
  }

  public async load(): Promise<void> {
    const tasks: Promise<boolean>[] = [
      this.quoteService.loadQuotes(this.statusFilter()),
      this.quoteService.loadProspects(),
      this.quoteService.loadTemplates(),
    ];
    if (this.canAssign()) tasks.push(this.quoteService.loadAssignees());
    await Promise.all(tasks);
    this.pageIndex.update((page) => Math.min(page, this.pageCount() - 1));
  }

  public async filterByStatus(value: string): Promise<void> {
    this.statusFilter.set(value);
    this.pageIndex.set(0);
    await this.quoteService.loadQuotes(value);
  }

  public searchQuotes(value: string): void {
    this.quoteSearch.set(value);
    this.pageIndex.set(0);
  }

  public previousPage(): void {
    if (this.canPrevPage()) this.pageIndex.update((page) => page - 1);
  }

  public nextPage(): void {
    if (this.canNextPage()) this.pageIndex.update((page) => page + 1);
  }

  public statusLabel(status: QuoteStatus): string {
    return STATUS_LABELS[status];
  }

  public statusClass(status: QuoteStatus): string {
    return `status-${status}`;
  }

  public columnTypeLabel(type: QuoteColumnType): string {
    return COLUMN_TYPE_LABELS[type];
  }

  public formatAmount(amount: number, currency: string): string {
    return `${new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount)} ${currency}`;
  }

  public prospectLabel(prospectId: string): string {
    const prospect = this.quoteService.prospects().find((candidate) => candidate.id === prospectId);
    return prospect?.companyName || prospect?.name || 'Client non défini';
  }

  public assigneeLabel(assigneeId: string | null): string {
    if (!assigneeId) return 'Non attribué';
    const assignee = this.quoteService.assignees().find((candidate) => candidate.id === assigneeId);
    return assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() || assignee.email : 'Commercial indisponible';
  }

  public onClientSearchInput(val: string): void {
    this.clientSearch.set(val);
  }

  public async onProspectSelected(selectedId: string): Promise<void> {
    this.prospectId.set(selectedId);
    this.contactId.set('');
    await this.quoteService.loadContacts(selectedId);
    if (!selectedId) return;
    const prospect = this.quoteService.prospects().find((candidate) => candidate.id === selectedId);
    if (prospect) {
      this.clientSearch.set(prospect.companyName || prospect.name);
      if (prospect.contactName && !this.seaContactName()) this.seaContactName.set(prospect.contactName);
      if (prospect.phone && !this.seaPhone()) this.seaPhone.set(prospect.phone);
      if (prospect.email && !this.seaEmail()) this.seaEmail.set(prospect.email);
    }
  }

  public onContactSelected(selectedId: string): void {
    this.contactId.set(selectedId);
    const contact = this.quoteService.contacts().find((candidate) => candidate.id === selectedId);
    if (!contact) return;
    this.seaContactName.set(contact.fullName);
    if (contact.phone) this.seaPhone.set(contact.phone);
    if (contact.email) this.seaEmail.set(contact.email);
  }

  public openCreate(): void {
    if (!this.canCreate()) return;
    this.editingId.set(null);
    this.error.set(null);
    this.prospectId.set('');
    this.contactId.set('');
    this.opportunityId.set(this.linkedOpportunityId || null);
    this.clientSearch.set('');
    this.assignedTo.set(this.canAssign() ? '' : (this.currentUserId() || ''));
    this.title.set('Cotation Fret Maritime Transimex');
    this.currency.set('XAF');
    this.status.set('draft');
    this.validUntil.set('');

    // Réinitialisation des champs maritimes
    this.seaContactName.set('');
    this.seaPhone.set('');
    this.seaEmail.set('');
    this.seaAddress.set('');
    this.seaGoodsType.set('');
    this.seaGoodsDescription.set('');
    this.seaGrossWeightKg.set(null);
    this.seaTotalVolumeM3.set(null);
    this.seaPackagesCount.set(null);
    this.seaPackagingType.set('');
    this.seaPortOfLoading.set('Douala Port (CMDLA)');
    this.seaPortOfDischarge.set('');
    this.seaIncoterm.set('FOB');
    this.seaNeedInlandTransport.set(false);
    this.seaEstimatedDepartureDate.set(null);
    this.seaEstimatedArrivalDate.set(null);

    this.serviceFcl.set(false);
    this.serviceLcl.set(false);
    this.serviceRoro.set(false);
    this.serviceBreakBulk.set(false);
    this.serviceOther.set('');

    this.docCommercialInvoice.set(false);
    this.docPackingList.set(false);
    this.docCertificateOfOrigin.set(false);
    this.docMsdsTechnicalSheet.set(false);
    this.docOther.set('');

    this.addonCustomsClearance.set(false);
    this.addonCargoInsurance.set(false);
    this.addonWarehousing.set(false);
    this.addonPortHandling.set(false);
    this.addonTracking.set(false);

    // Initialisation des colonnes de chiffrage adaptées au maritime
    const colDesignation: QuoteColumn = { id: generateSecureUUID(), label: 'Désignation de la prestation', type: 'text' };
    const colUnite: QuoteColumn = { id: generateSecureUUID(), label: 'Unité / Conteneur', type: 'text' };
    const colMontant: QuoteColumn = { id: generateSecureUUID(), label: 'Montant HT', type: 'amount' };
    this.columns.set([colDesignation, colUnite, colMontant]);
    this.totalColumnId.set(colMontant.id);
    this.rows.set([
      { [colDesignation.id]: 'Fret maritime de base', [colUnite.id]: '1 x 40\' HC', [colMontant.id]: 0 },
      { [colDesignation.id]: 'Surcharge BAF / CAF', [colUnite.id]: 'Forfait', [colMontant.id]: 0 },
      { [colDesignation.id]: 'Manutention portuaire & Débarquement', [colUnite.id]: 'Unité', [colMontant.id]: 0 },
    ]);

    this.saveTemplate.set(false);
    this.templateName.set('');
    this.selectedTemplateId.set('');
    this.showNewProspect.set(false);
    this.isEditorOpen.set(true);
  }

  public openEdit(quote: SalesQuote): void {
    if (!this.canUpdate()) return;
    this.editingId.set(quote.id);
    this.error.set(null);
    this.prospectId.set(quote.prospectId);
    this.contactId.set(quote.contactId || '');
    void this.quoteService.loadContacts(quote.prospectId);
    this.opportunityId.set(quote.opportunityId || null);
    this.clientSearch.set(quote.prospectName || this.prospectLabel(quote.prospectId));
    this.assignedTo.set(quote.assignedTo || '');
    this.title.set(quote.title);
    this.currency.set(quote.currency);
    this.status.set(quote.status);
    this.validUntil.set(quote.validUntil || '');

    const sf = quote.seaFreight;
    this.seaContactName.set(sf?.contactName || '');
    this.seaPhone.set(sf?.phone || '');
    this.seaEmail.set(sf?.email || '');
    this.seaAddress.set(sf?.address || '');
    this.seaGoodsType.set(sf?.goodsType || '');
    this.seaGoodsDescription.set(sf?.goodsDescription || '');
    this.seaGrossWeightKg.set(sf?.grossWeightKg ?? null);
    this.seaTotalVolumeM3.set(sf?.totalVolumeM3 ?? null);
    this.seaPackagesCount.set(sf?.packagesCount ?? null);
    this.seaPackagingType.set(sf?.packagingType || '');
    this.seaPortOfLoading.set(sf?.portOfLoading || '');
    this.seaPortOfDischarge.set(sf?.portOfDischarge || '');
    this.seaIncoterm.set(sf?.incoterm || '');
    this.seaNeedInlandTransport.set(sf?.needInlandTransport ?? false);
    this.seaEstimatedDepartureDate.set(sf?.estimatedDepartureDate || null);
    this.seaEstimatedArrivalDate.set(sf?.estimatedArrivalDate || null);

    this.serviceFcl.set(sf?.serviceTypes?.fcl ?? false);
    this.serviceLcl.set(sf?.serviceTypes?.lcl ?? false);
    this.serviceRoro.set(sf?.serviceTypes?.roro ?? false);
    this.serviceBreakBulk.set(sf?.serviceTypes?.breakBulk ?? false);
    this.serviceOther.set(sf?.serviceTypes?.other || '');

    this.docCommercialInvoice.set(sf?.availableDocuments?.commercialInvoice ?? false);
    this.docPackingList.set(sf?.availableDocuments?.packingList ?? false);
    this.docCertificateOfOrigin.set(sf?.availableDocuments?.certificateOfOrigin ?? false);
    this.docMsdsTechnicalSheet.set(sf?.availableDocuments?.msdsTechnicalSheet ?? false);
    this.docOther.set(sf?.availableDocuments?.other || '');

    this.addonCustomsClearance.set(sf?.additionalServices?.customsClearance ?? false);
    this.addonCargoInsurance.set(sf?.additionalServices?.cargoInsurance ?? false);
    this.addonWarehousing.set(sf?.additionalServices?.warehousing ?? false);
    this.addonPortHandling.set(sf?.additionalServices?.portHandling ?? false);
    this.addonTracking.set(sf?.additionalServices?.tracking ?? false);

    this.columns.set(quote.columns.map((column) => ({ ...column })));
    this.rows.set(quote.rows.map((row) => ({ ...row })));
    this.totalColumnId.set(quote.totalColumnId);

    this.saveTemplate.set(false);
    this.templateName.set('');
    this.selectedTemplateId.set('');
    this.showNewProspect.set(false);
    this.isEditorOpen.set(true);
  }

  public closeEditor(): void {
    if (this.isSaving() || this.isCreatingProspect()) return;
    this.isEditorOpen.set(false);
  }

  public toggleNewProspect(): void {
    this.showNewProspect.update((visible) => !visible);
  }

  public addColumn(): void {
    const label = this.columnLabelDraft().trim();
    if (!label) {
      this.error.set('Saisissez un nom pour la nouvelle colonne.');
      return;
    }
    const column: QuoteColumn = {
      id: generateSecureUUID(),
      label,
      type: this.columnTypeDraft(),
    };
    this.columns.update((columns) => [...columns, column]);
    this.rows.update((rows) => rows.map((row) => ({
      ...row,
      [column.id]: column.type === 'checkbox' ? false : null,
    })));
    if (column.type === 'amount' && !this.totalColumnId()) {
      this.totalColumnId.set(column.id);
    }
    this.columnLabelDraft.set('');
    this.error.set(null);
  }

  public removeColumn(columnId: string): void {
    if (this.columns().length <= 1) return;
    this.columns.update((columns) => columns.filter((column) => column.id !== columnId));
    this.rows.update((rows) => rows.map((row) => {
      const remaining: QuoteRow = {};
      for (const [id, value] of Object.entries(row)) {
        if (id !== columnId) remaining[id] = value;
      }
      return remaining;
    }));
    if (this.totalColumnId() === columnId) {
      this.totalColumnId.set(this.columns().find((column) => column.type === 'amount')?.id || '');
    }
  }

  public addRow(): void {
    const row = Object.fromEntries(this.columns().map((column) => [
      column.id,
      column.type === 'checkbox' ? false : null,
    ])) as QuoteRow;
    this.rows.update((rows) => [...rows, row]);
  }

  public removeRow(rowIndex: number): void {
    this.rows.update((rows) => rows.filter((_row, index) => index !== rowIndex));
  }

  public updateCell(rowIndex: number, column: QuoteColumn, event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    let value: string | number | boolean | null;
    if (column.type === 'checkbox' && target instanceof HTMLInputElement) {
      value = target.checked;
    } else if (column.type === 'amount' || column.type === 'number') {
      value = target.value.trim() === '' ? null : Number(target.value);
    } else {
      value = target.value || null;
    }
    this.rows.update((rows) => rows.map((row, index) =>
      index === rowIndex ? { ...row, [column.id]: value } : row
    ));
  }

  public cellValue(row: QuoteRow, column: QuoteColumn): string | number | boolean {
    const value = row[column.id];
    return value === null || value === undefined ? '' : value;
  }

  public applyTemplate(templateId: string): void {
    this.selectedTemplateId.set(templateId);
    const template = this.quoteService.templates().find((candidate) => candidate.id === templateId);
    if (!template) return;
    this.columns.set(template.columns.map((column) => ({ ...column })));
    this.totalColumnId.set(template.totalColumnId);
    const row = Object.fromEntries(template.columns.map((column) => [
      column.id,
      column.type === 'checkbox' ? false : null,
    ])) as QuoteRow;
    this.rows.set([row]);
    this.error.set(null);
  }

  public filteredProspects() {
    const query = this.clientSearch().trim().toLocaleLowerCase('fr');
    const prospects = this.quoteService.prospects();
    if (!query) return prospects;
    return prospects.filter((prospect) =>
      `${prospect.companyName || prospect.name} ${prospect.contactName || ''}`.toLocaleLowerCase('fr').includes(query)
    );
  }

  public async createProspect(): Promise<void> {
    const companyName = this.clientSearch().trim();
    if (companyName.length < 2) {
      this.error.set('Saisissez le nom de la société (au moins 2 caractères).');
      return;
    }
    this.isCreatingProspect.set(true);
    this.error.set(null);
    const result = await this.quoteService.createProspect({
      companyName,
      contactName: this.newProspectContact().trim() || this.seaContactName().trim() || undefined,
      email: this.newProspectEmail().trim().toLowerCase() || this.seaEmail().trim().toLowerCase() || undefined,
      phone: this.newProspectPhone().trim() || this.seaPhone().trim() || undefined,
      ...(this.canAssign() && this.assignedTo() ? { assignedTo: this.assignedTo() } : {}),
    });
    this.isCreatingProspect.set(false);
    if (!result.success || !result.data) {
      this.error.set(result.error || 'Impossible d’enregistrer le client.');
      return;
    }
    this.prospectId.set(result.data.id);
    this.clientSearch.set(result.data.companyName || result.data.name);
    this.showNewProspect.set(false);
    this.newProspectContact.set('');
    this.newProspectEmail.set('');
    this.newProspectPhone.set('');
  }

  public async saveQuote(): Promise<void> {
    if (this.isSaving()) return;

    // Si aucun prospectId n'est sélectionné mais qu'un nom de société est saisi, on le crée
    if (!this.prospectId() && this.clientSearch().trim().length >= 2) {
      await this.createProspect();
    }

    if (!this.prospectId()) {
      this.error.set('Veuillez renseigner et sélectionner le nom de la société cliente.');
      return;
    }
    if (this.columns().length === 0 || !this.totalColumnOptions().some((column) => column.id === this.totalColumnId())) {
      this.error.set('Configurez au moins une colonne de type montant pour calculer le total de la cotation.');
      return;
    }
    if (this.rows().length === 0) {
      this.error.set('Ajoutez au moins une ligne de chiffrage maritime.');
      return;
    }
    if (this.canAssign() && !this.assignedTo()) {
      this.error.set('Veuillez affecter un commercial à cette cotation maritime.');
      return;
    }
    if (this.saveTemplate() && this.templateName().trim().length < 2) {
      this.error.set('Indiquez un nom de modèle partagé ou décochez cette option.');
      return;
    }

    const seaFreightPayload: SeaFreightDetails = {
      contactName: this.seaContactName().trim() || undefined,
      phone: this.seaPhone().trim() || undefined,
      email: this.seaEmail().trim() || undefined,
      address: this.seaAddress().trim() || undefined,
      goodsType: this.seaGoodsType().trim() || undefined,
      goodsDescription: this.seaGoodsDescription().trim() || undefined,
      grossWeightKg: this.seaGrossWeightKg(),
      totalVolumeM3: this.seaTotalVolumeM3(),
      packagesCount: this.seaPackagesCount(),
      packagingType: this.seaPackagingType().trim() || undefined,
      portOfLoading: this.seaPortOfLoading().trim() || undefined,
      portOfDischarge: this.seaPortOfDischarge().trim() || undefined,
      incoterm: this.seaIncoterm().trim() || undefined,
      needInlandTransport: this.seaNeedInlandTransport(),
      estimatedDepartureDate: this.seaEstimatedDepartureDate(),
      estimatedArrivalDate: this.seaEstimatedArrivalDate(),
      serviceTypes: {
        fcl: this.serviceFcl(),
        lcl: this.serviceLcl(),
        roro: this.serviceRoro(),
        breakBulk: this.serviceBreakBulk(),
        other: this.serviceOther().trim() || undefined,
      },
      availableDocuments: {
        commercialInvoice: this.docCommercialInvoice(),
        packingList: this.docPackingList(),
        certificateOfOrigin: this.docCertificateOfOrigin(),
        msdsTechnicalSheet: this.docMsdsTechnicalSheet(),
        other: this.docOther().trim() || undefined,
      },
      additionalServices: {
        customsClearance: this.addonCustomsClearance(),
        cargoInsurance: this.addonCargoInsurance(),
        warehousing: this.addonWarehousing(),
        portHandling: this.addonPortHandling(),
        tracking: this.addonTracking(),
      },
    };

    const input: QuoteInput = {
      prospectId: this.prospectId(),
      ...(this.opportunityId() ? { opportunityId: this.opportunityId() } : {}),
      contactId: this.contactId() || null,
      ...(this.assignedTo() ? { assignedTo: this.assignedTo() } : {}),
      title: this.title().trim(),
      currency: this.currency().trim().toUpperCase(),
      columns: this.columns(),
      rows: this.rows(),
      totalColumnId: this.totalColumnId(),
      status: this.status(),
      validUntil: this.validUntil() || null,
      seaFreight: seaFreightPayload,
    };

    this.isSaving.set(true);
    this.error.set(null);
    const quoteId = this.editingId();
    const result = quoteId
      ? await this.quoteService.updateQuote(quoteId, input)
      : await this.quoteService.createQuote(input);

    if (!result.success) {
      this.isSaving.set(false);
      this.error.set(result.error || 'Impossible d’enregistrer la cotation maritime.');
      return;
    }

    if (this.saveTemplate() && !quoteId) {
      await this.quoteService.createTemplate({
        name: this.templateName().trim(),
        columns: this.columns(),
        totalColumnId: this.totalColumnId(),
      });
    }

    await this.load();
    this.isSaving.set(false);
    this.isEditorOpen.set(false);
    this.feedback.set(quoteId ? 'Cotation maritime mise à jour avec succès.' : 'Fiche de cotation maritime enregistrée avec succès.');
    setTimeout(() => this.feedback.set(null), 15000);
  }

  public async deleteQuote(quote: SalesQuote): Promise<void> {
    if (!this.canDelete()) return;
    const confirmed = confirm(`Confirmez-vous la suppression de la cotation ${quote.quoteNumber} ?`);
    if (!confirmed) return;
    const result = await this.quoteService.deleteQuote(quote.id);
    if (!result.success) {
      this.error.set(result.error || 'Impossible de supprimer la cotation.');
      return;
    }
    await this.load();
    this.feedback.set(`Cotation ${quote.quoteNumber} supprimée.`);
    setTimeout(() => this.feedback.set(null), 15000);
  }

  public async deleteTemplate(template: { id: string; name: string }): Promise<void> {
    if (!this.canDeleteTemplate()) return;
    const confirmed = confirm(`Supprimer le modèle ${template.name} ?`);
    if (!confirmed) return;
    await this.quoteService.deleteTemplate(template.id);
    await this.quoteService.loadTemplates();
  }
}
