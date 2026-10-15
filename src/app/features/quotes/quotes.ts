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
  QuoteCellValue,
  QuoteColumn,
  QuoteColumnType,
  QuoteRow,
  QuoteStatus,
  SalesQuote,
  SeaFreightDetails,
} from '../../core/models/quote.model';
import { ModuleControlPanel } from '../../shared/components/module-control-panel/module-control-panel';
import { ModuleDataTable } from '../../shared/components/module-data-table/module-data-table';

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

export type QuoteSortField =
  | 'quoteNumber'
  | 'prospect'
  | 'title'
  | 'assignedTo'
  | 'totalAmount'
  | 'validUntil'
  | 'status';

@Component({
  selector: 'app-quotes',
  imports: [DatePipe, MatIconModule, ModuleControlPanel, ModuleDataTable, RouterLink],
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

  // Tri style Caisse (Odoo Tree View)
  public readonly sortField = signal<QuoteSortField | null>(null);
  public readonly sortDirection = signal<'asc' | 'desc'>('asc');

  // Sélection style Caisse (Odoo Checkboxes)
  public readonly selectedQuoteIds = signal<Set<string>>(new Set());

  public readonly currentUserId = computed(() => this.authService.currentUser()?.id || null);
  public readonly canCreate = computed(() => this.accessControl.hasPermission('quotes.create'));
  public readonly canUpdate = computed(() => this.accessControl.hasPermission('quotes.update'));
  public readonly canDelete = computed(() => this.accessControl.hasPermission('quotes.delete'));
  public readonly canAssign = computed(() => this.accessControl.hasPermission('quotes.assign'));
  public readonly canSaveTemplate = computed(() => this.accessControl.hasPermission('quotes.templates.create'));
  public readonly canDeleteTemplate = computed(() => this.accessControl.hasPermission('quotes.templates.delete'));
  public readonly canSelect = computed(() => this.canDelete() || this.canUpdate());

  public readonly totalColumnOptions = computed(() =>
    this.columns().filter((column) => column.type === 'amount')
  );

  public readonly filteredProspects = computed(() => this.quoteService.prospects());

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

  public readonly sortedQuotes = computed(() => {
    const quotes = [...this.filteredQuotes()];
    const field = this.sortField();
    const direction = this.sortDirection();
    if (!field) return quotes;

    return quotes.sort((a, b) => {
      let valA: string | number = '';
      let valB: string | number = '';

      switch (field) {
        case 'quoteNumber':
          valA = a.quoteNumber || '';
          valB = b.quoteNumber || '';
          break;
        case 'prospect':
          valA = a.prospectName || this.prospectLabel(a.prospectId) || '';
          valB = b.prospectName || this.prospectLabel(b.prospectId) || '';
          break;
        case 'title':
          valA = a.title || '';
          valB = b.title || '';
          break;
        case 'assignedTo':
          valA = a.assignedToName || this.assigneeLabel(a.assignedTo) || '';
          valB = b.assignedToName || this.assigneeLabel(b.assignedTo) || '';
          break;
        case 'totalAmount':
          valA = a.totalAmount ?? 0;
          valB = b.totalAmount ?? 0;
          break;
        case 'validUntil':
          valA = a.validUntil ? new Date(a.validUntil).getTime() : 0;
          valB = b.validUntil ? new Date(b.validUntil).getTime() : 0;
          break;
        case 'status':
          valA = a.status || '';
          valB = b.status || '';
          break;
      }

      if (typeof valA === 'number' && typeof valB === 'number') {
        return direction === 'asc' ? valA - valB : valB - valA;
      }
      const comp = String(valA).localeCompare(String(valB), 'fr', { sensitivity: 'base' });
      return direction === 'asc' ? comp : -comp;
    });
  });

  public readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.sortedQuotes().length / this.pageSize))
  );

  public readonly displayedQuotes = computed(() => {
    const start = this.pageIndex() * this.pageSize;
    return this.sortedQuotes().slice(start, start + this.pageSize);
  });

  public readonly statusColumns = computed<QuoteStatusColumn[]>(() =>
    this.statuses.map((status) => ({
      status,
      quotes: this.displayedQuotes().filter((quote) => quote.status === status),
    }))
  );

  public readonly isAllSelected = computed(() => {
    const displayed = this.displayedQuotes();
    if (displayed.length === 0) return false;
    const selected = this.selectedQuoteIds();
    return displayed.every((q) => selected.has(q.id));
  });

  public readonly selectedCount = computed(() => this.selectedQuoteIds().size);

  public readonly paginationLabel = computed(() => {
    const total = this.sortedQuotes().length;
    if (total === 0) return '0 résultat(s)';
    const first = this.pageIndex() * this.pageSize + 1;
    return `${first}–${Math.min(first + this.pageSize - 1, total)} sur ${total}`;
  });

  public readonly canPrevPage = computed(() => this.pageIndex() > 0);
  public readonly canNextPage = computed(() => (this.pageIndex() + 1) * this.pageSize < this.sortedQuotes().length);

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

  public toggleSort(field: QuoteSortField): void {
    if (this.sortField() === field) {
      this.sortDirection.update((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortField.set(field);
      this.sortDirection.set('asc');
    }
    this.pageIndex.set(0);
  }

  public isSelected(quoteId: string): boolean {
    return this.selectedQuoteIds().has(quoteId);
  }

  public onToggleSelect(quoteId: string): void {
    this.selectedQuoteIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(quoteId)) {
        next.delete(quoteId);
      } else {
        next.add(quoteId);
      }
      return next;
    });
  }

  public onToggleSelectAll(): void {
    const displayed = this.displayedQuotes();
    const currentlyAll = this.isAllSelected();
    this.selectedQuoteIds.update((prev) => {
      const next = new Set(prev);
      if (currentlyAll) {
        for (const q of displayed) next.delete(q.id);
      } else {
        for (const q of displayed) next.add(q.id);
      }
      return next;
    });
  }

  public clearSelection(): void {
    this.selectedQuoteIds.set(new Set());
  }

  public async deleteSelectedQuotes(): Promise<void> {
    if (!this.canDelete()) return;
    const count = this.selectedQuoteIds().size;
    if (count === 0) return;
    const confirmed = confirm(`Confirmez-vous la suppression des ${count} cotation(s) sélectionnée(s) ?`);
    if (!confirmed) return;

    this.isSaving.set(true);
    for (const id of this.selectedQuoteIds()) {
      await this.quoteService.deleteQuote(id);
    }
    this.clearSelection();
    await this.load();
    this.isSaving.set(false);
    this.feedback.set(`${count} cotation(s) supprimée(s) avec succès.`);
    setTimeout(() => this.feedback.set(null), 15000);
  }

  public async filterByStatus(value: string): Promise<void> {
    this.statusFilter.set(value);
    this.pageIndex.set(0);
    this.clearSelection();
    await this.quoteService.loadQuotes(value);
  }

  public searchQuotes(value: string): void {
    this.quoteSearch.set(value);
    this.pageIndex.set(0);
    this.clearSelection();
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

  public toggleNewProspect(): void {
    this.showNewProspect.update((v) => !v);
  }

  public async createProspect(): Promise<void> {
    const contact = this.newProspectContact().trim();
    if (!contact) return;
    this.isCreatingProspect.set(true);
    const result = await this.quoteService.createProspect({
      companyName: contact,
      contactName: contact,
      email: this.newProspectEmail().trim() || undefined,
      phone: this.newProspectPhone().trim() || undefined,
    });
    this.isCreatingProspect.set(false);
    if (result.success && result.data) {
      this.onProspectSelected(result.data.id);
      this.showNewProspect.set(false);
      this.newProspectContact.set('');
      this.newProspectEmail.set('');
      this.newProspectPhone.set('');
    }
  }

  public openCreate(): void {
    this.editingId.set(null);
    this.error.set(null);
    this.prospectId.set(this.linkedProspectId || '');
    this.contactId.set('');
    this.opportunityId.set(this.linkedOpportunityId || null);
    this.clientSearch.set('');
    this.assignedTo.set(this.canAssign() ? '' : (this.currentUserId() || ''));
    this.title.set('Cotation Fret Maritime Transimex');
    this.currency.set('XAF');
    this.status.set('draft');
    this.validUntil.set('');

    // Réinitialisation maritime
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

    // Initialisation dynamique par défaut
    this.initializeDefaultColumns();
    this.selectedTemplateId.set('');
    this.saveTemplate.set(false);
    this.templateName.set('');
    this.showNewProspect.set(false);
    this.error.set(null);
    this.isEditorOpen.set(true);
  }

  public openEdit(quote: SalesQuote): void {
    this.editingId.set(quote.id);
    this.error.set(null);
    this.contactId.set(quote.contactId || '');
    void this.quoteService.loadContacts(quote.prospectId);
    this.title.set(quote.title);
    this.currency.set(quote.currency);
    this.status.set(quote.status);
    this.validUntil.set(quote.validUntil ? quote.validUntil.substring(0, 10) : '');
    this.prospectId.set(quote.prospectId);
    this.clientSearch.set(quote.prospectName || this.prospectLabel(quote.prospectId));
    this.opportunityId.set(quote.opportunityId ?? null);
    this.assignedTo.set(quote.assignedTo || '');

    // Données maritimes
    const sea = quote.seaFreight;
    this.seaContactName.set(sea?.contactName || '');
    this.seaPhone.set(sea?.phone || '');
    this.seaEmail.set(sea?.email || '');
    this.seaAddress.set(sea?.address || '');
    this.seaGoodsType.set(sea?.goodsType || '');
    this.seaGoodsDescription.set(sea?.goodsDescription || '');
    this.seaGrossWeightKg.set(sea?.grossWeightKg ?? null);
    this.seaTotalVolumeM3.set(sea?.totalVolumeM3 ?? null);
    this.seaPackagesCount.set(sea?.packagesCount ?? null);
    this.seaPackagingType.set(sea?.packagingType || '');
    this.seaPortOfLoading.set(sea?.portOfLoading || '');
    this.seaPortOfDischarge.set(sea?.portOfDischarge || '');
    this.seaIncoterm.set(sea?.incoterm || '');
    this.seaNeedInlandTransport.set(!!sea?.needInlandTransport);
    this.seaEstimatedDepartureDate.set(sea?.estimatedDepartureDate ? sea.estimatedDepartureDate.substring(0, 10) : null);
    this.seaEstimatedArrivalDate.set(sea?.estimatedArrivalDate ? sea.estimatedArrivalDate.substring(0, 10) : null);

    this.serviceFcl.set(!!sea?.serviceTypes?.fcl);
    this.serviceLcl.set(!!sea?.serviceTypes?.lcl);
    this.serviceRoro.set(!!sea?.serviceTypes?.roro);
    this.serviceBreakBulk.set(!!sea?.serviceTypes?.breakBulk);
    this.serviceOther.set(sea?.serviceTypes?.other || '');

    this.docCommercialInvoice.set(!!sea?.availableDocuments?.commercialInvoice);
    this.docPackingList.set(!!sea?.availableDocuments?.packingList);
    this.docCertificateOfOrigin.set(!!sea?.availableDocuments?.certificateOfOrigin);
    this.docMsdsTechnicalSheet.set(!!sea?.availableDocuments?.msdsTechnicalSheet);
    this.docOther.set(sea?.availableDocuments?.other || '');

    this.addonCustomsClearance.set(!!sea?.additionalServices?.customsClearance);
    this.addonCargoInsurance.set(!!sea?.additionalServices?.cargoInsurance);
    this.addonWarehousing.set(!!sea?.additionalServices?.warehousing);
    this.addonPortHandling.set(!!sea?.additionalServices?.portHandling);
    this.addonTracking.set(!!sea?.additionalServices?.tracking);

    // Chiffrage
    this.columns.set(quote.columns.map((c) => ({ ...c })));
    this.rows.set(quote.rows.map((r) => ({ ...r })));
    this.totalColumnId.set(quote.totalColumnId || (quote.columns.find((c) => c.type === 'amount')?.id || ''));

    this.selectedTemplateId.set('');
    this.saveTemplate.set(false);
    this.templateName.set('');
    this.showNewProspect.set(false);
    this.error.set(null);
    this.isEditorOpen.set(true);
  }

  public closeEditor(): void {
    this.isEditorOpen.set(false);
    this.error.set(null);
  }

  public initializeDefaultColumns(): void {
    const colDesignation: QuoteColumn = { id: generateSecureUUID(), label: 'Rubrique / Prestation', type: 'text' };
    const colQty: QuoteColumn = { id: generateSecureUUID(), label: 'Quantité', type: 'number' };
    const colUnitPrice: QuoteColumn = { id: generateSecureUUID(), label: 'Prix Unitaire (XAF)', type: 'amount' };
    const colTotal: QuoteColumn = { id: generateSecureUUID(), label: 'Total HT', type: 'amount' };

    this.columns.set([colDesignation, colQty, colUnitPrice, colTotal]);
    this.totalColumnId.set(colTotal.id);

    const row1: QuoteRow = {
      id: generateSecureUUID(),
      [colDesignation.id]: 'Fret maritime standard (Port de départ -> Douala)',
      [colQty.id]: 1,
      [colUnitPrice.id]: 1500000,
      [colTotal.id]: 1500000,
    };
    const row2: QuoteRow = {
      id: generateSecureUUID(),
      [colDesignation.id]: 'Manutention portuaire & Débarquement',
      [colQty.id]: 1,
      [colUnitPrice.id]: 250000,
      [colTotal.id]: 250000,
    };
    const row3: QuoteRow = {
      id: generateSecureUUID(),
      [colDesignation.id]: 'Formalités douanières & Transit import',
      [colQty.id]: 1,
      [colUnitPrice.id]: 300000,
      [colTotal.id]: 300000,
    };
    this.rows.set([row1, row2, row3]);
  }

  public onTemplateChange(templateId: string): void {
    this.selectedTemplateId.set(templateId);
    if (!templateId) return;
    const template = this.quoteService.templates().find((candidate) => candidate.id === templateId);
    if (!template) return;
    this.columns.set(template.columns.map((c) => ({ ...c })));
    this.totalColumnId.set(template.totalColumnId);
    this.rows.set([this.createEmptyRow(template.columns)]);
  }

  public applyTemplate(templateId: string): void {
    this.onTemplateChange(templateId);
  }

  public addColumn(): void {
    const label = this.columnLabelDraft().trim();
    if (!label) return;
    const newCol: QuoteColumn = {
      id: generateSecureUUID(),
      label,
      type: this.columnTypeDraft(),
    };
    this.columns.update((cols) => [...cols, newCol]);
    if (newCol.type === 'amount' && !this.totalColumnId()) {
      this.totalColumnId.set(newCol.id);
    }
    this.columnLabelDraft.set('');
  }

  public removeColumn(columnId: string): void {
    this.columns.update((cols) => cols.filter((c) => c.id !== columnId));
    this.rows.update((currentRows) =>
      currentRows.map((r) => {
        const copy = { ...r };
        delete copy[columnId];
        return copy;
      })
    );
    if (this.totalColumnId() === columnId) {
      const nextAmount = this.columns().find((c) => c.type === 'amount');
      this.totalColumnId.set(nextAmount ? nextAmount.id : '');
    }
  }

  public addRow(): void {
    const emptyRow = this.createEmptyRow(this.columns());
    this.rows.update((current) => [...current, emptyRow]);
  }

  public removeRow(rowIndex: number): void {
    this.rows.update((current) => current.filter((_, idx) => idx !== rowIndex));
  }

  public cellValue(row: QuoteRow, column: QuoteColumn): unknown {
    return row[column.id] ?? '';
  }

  public updateCell(rowIndex: number, column: QuoteColumn, event: Event): void {
    const target = event.target as HTMLInputElement;
    let val: unknown = target.value;
    if (column.type === 'checkbox') {
      val = target.checked;
    } else if (column.type === 'number' || column.type === 'amount') {
      val = target.value === '' ? 0 : Number(target.value);
    }
    this.rows.update((current) => {
      const updated = [...current];
      const targetRow = { ...updated[rowIndex] };
      targetRow[column.id] = val as QuoteCellValue;
      updated[rowIndex] = targetRow;
      return updated;
    });
  }

  private createEmptyRow(columns: QuoteColumn[]): QuoteRow {
    const row: QuoteRow = { id: generateSecureUUID() };
    for (const column of columns) {
      if (column.type === 'amount' || column.type === 'number') {
        row[column.id] = 0;
      } else if (column.type === 'checkbox') {
        row[column.id] = false;
      } else {
        row[column.id] = '';
      }
    }
    return row;
  }

  public async saveQuote(): Promise<void> {
    if (!this.title().trim()) {
      this.error.set('Veuillez renseigner un intitulé pour la cotation.');
      return;
    }
    if (!this.prospectId()) {
      this.error.set('Veuillez sélectionner un prospect/client destinataire.');
      return;
    }
    if (this.columns().length === 0) {
      this.error.set('Veuillez définir au moins une colonne de chiffrage.');
      return;
    }

    const seaFreightPayload: SeaFreightDetails = {
      contactName: this.seaContactName().trim() || undefined,
      phone: this.seaPhone().trim() || undefined,
      email: this.seaEmail().trim() || undefined,
      address: this.seaAddress().trim() || undefined,
      goodsType: this.seaGoodsType().trim() || undefined,
      goodsDescription: this.seaGoodsDescription().trim() || undefined,
      grossWeightKg: this.seaGrossWeightKg() ?? undefined,
      totalVolumeM3: this.seaTotalVolumeM3() ?? undefined,
      packagesCount: this.seaPackagesCount() ?? undefined,
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
    this.selectedQuoteIds.update((prev) => {
      const next = new Set(prev);
      next.delete(quote.id);
      return next;
    });
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
