import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ActivatedRoute } from '@angular/router';
import {
  QUOTE_COLUMN_TYPES,
  QUOTE_STATUSES,
  QuoteColumn,
  QuoteColumnType,
  QuoteRow,
  QuoteStatus,
  QuoteTemplate,
  SalesQuote,
} from '../../core/models/quote.model';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { QuoteInput, QuoteService } from '../../core/services/quote.service';
import { ModuleControlPanel } from '../../shared/components/module-control-panel/module-control-panel';
import { generateSecureUUID } from '../../core/utils/crypto.utils';

const COLUMN_TYPE_LABELS: Record<QuoteColumnType, string> = {
  text: 'Texte',
  number: 'Nombre',
  amount: 'Montant',
  date: 'Date',
  checkbox: 'Case à cocher',
};

const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Brouillon',
  sent: 'Envoyée',
  accepted: 'Acceptée',
  rejected: 'Refusée',
  expired: 'Expirée',
};

interface QuoteStatusColumn {
  status: QuoteStatus;
  quotes: SalesQuote[];
}

@Component({
  selector: 'app-quotes',
  imports: [DatePipe, FormsModule, MatIconModule, ModuleControlPanel],
  templateUrl: './quotes.html',
  styleUrl: './quotes.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QuotesComponent {
  public readonly quoteService = inject(QuoteService);
  private readonly accessControl = inject(AccessControlService);
  private readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly linkedProspectId = this.route.snapshot.queryParamMap.get('prospectId');
  private readonly linkedOpportunityId = this.route.snapshot.queryParamMap.get('opportunityId');

  public readonly columnTypes = QUOTE_COLUMN_TYPES;
  public readonly statuses = QUOTE_STATUSES;
  public readonly statusFilter = signal('');
  public readonly quoteSearch = signal('');
  public readonly view = signal<'list' | 'kanban'>('list');
  public readonly pageIndex = signal(0);
  public readonly pageSize = 25;
  public readonly canCreate = computed(() => this.accessControl.hasPermission('quotes.create'));
  public readonly canUpdate = computed(() => this.accessControl.hasPermission('quotes.update'));
  public readonly canDelete = computed(() => this.accessControl.hasPermission('quotes.delete'));
  public readonly canAssign = computed(() => this.accessControl.hasPermission('quotes.assign'));
  public readonly canSaveTemplate = computed(() => this.accessControl.hasPermission('quotes.templates.create'));
  public readonly canDeleteTemplate = computed(() => this.accessControl.hasPermission('quotes.templates.delete'));
  public readonly currentUserId = computed(() => this.authService.currentUser()?.id || '');
  public readonly totalColumnOptions = computed(() =>
    this.columns().filter((column) => column.type === 'amount')
  );
  public readonly filteredQuotes = computed(() => {
    const query = this.quoteSearch().trim().toLocaleLowerCase('fr');
    const quotes = this.quoteService.quotes();
    if (!query) return quotes;
    return quotes.filter((quote) => [
      quote.quoteNumber,
      quote.prospectName || this.prospectLabel(quote.prospectId),
      quote.title,
      quote.assignedToName || this.assigneeLabel(quote.assignedTo),
      this.statusLabel(quote.status),
    ].some((value) => value.toLocaleLowerCase('fr').includes(query)));
  });
  public readonly pageCount = computed(() => Math.max(1, Math.ceil(this.filteredQuotes().length / this.pageSize)));
  public readonly displayedQuotes = computed(() =>
    this.filteredQuotes().slice(this.pageIndex() * this.pageSize, (this.pageIndex() + 1) * this.pageSize)
  );
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

  public readonly isEditorOpen = signal(false);
  public readonly editingId = signal<string | null>(null);
  public readonly isSaving = signal(false);
  public readonly error = signal<string | null>(null);
  public readonly feedback = signal<string | null>(null);
  public readonly clientSearch = signal('');
  public readonly prospectId = signal('');
  public readonly opportunityId = signal<string | null>(null);
  public readonly assignedTo = signal('');
  public readonly title = signal('Cotation client');
  public readonly currency = signal('XAF');
  public readonly status = signal<QuoteStatus>('draft');
  public readonly validUntil = signal('');
  public readonly columns = signal<QuoteColumn[]>([]);
  public readonly rows = signal<QuoteRow[]>([]);
  public readonly totalColumnId = signal('');
  public readonly columnLabelDraft = signal('');
  public readonly columnTypeDraft = signal<QuoteColumnType>('text');
  public readonly saveTemplate = signal(false);
  public readonly templateName = signal('');
  public readonly selectedTemplateId = signal('');
  public readonly showNewProspect = signal(false);
  public readonly newProspectCompany = signal('');
  public readonly newProspectContact = signal('');
  public readonly newProspectEmail = signal('');
  public readonly newProspectPhone = signal('');
  public readonly isCreatingProspect = signal(false);

  public constructor() {
    void this.load().then(() => {
      const prospectId = this.linkedProspectId;
      if (!prospectId || !this.linkedOpportunityId || !this.canCreate()) return;
      const prospect = this.quoteService.prospects().find((item) => item.id === prospectId);
      if (!prospect) return;
      this.openCreate();
      this.prospectId.set(prospect.id);
      this.clientSearch.set(prospect.companyName || prospect.name);
      this.opportunityId.set(this.linkedOpportunityId);
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
    return prospect?.companyName || prospect?.name || 'Choisir un client';
  }

  public assigneeLabel(assigneeId: string | null): string {
    if (!assigneeId) return 'Non attribué';
    const assignee = this.quoteService.assignees().find((candidate) => candidate.id === assigneeId);
    return assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() || assignee.email : 'Commercial indisponible';
  }

  public openCreate(): void {
    if (!this.canCreate()) return;
    this.editingId.set(null);
    this.error.set(null);
    this.prospectId.set('');
    this.opportunityId.set(this.linkedOpportunityId);
    this.clientSearch.set('');
    this.assignedTo.set(this.canAssign() ? '' : this.currentUserId());
    this.title.set('Cotation client');
    this.currency.set('XAF');
    this.status.set('draft');
    this.validUntil.set('');
    const description: QuoteColumn = { id: generateSecureUUID(), label: 'Désignation', type: 'text' };
    const amount: QuoteColumn = { id: generateSecureUUID(), label: 'Montant', type: 'amount' };
    this.columns.set([description, amount]);
    this.totalColumnId.set(amount.id);
    this.rows.set([{ [description.id]: null, [amount.id]: null }]);
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
    this.opportunityId.set(quote.opportunityId || null);
    this.assignedTo.set(quote.assignedTo || '');
    this.title.set(quote.title);
    this.currency.set(quote.currency);
    this.status.set(quote.status);
    this.validUntil.set(quote.validUntil || '');
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
    if (column.type === 'amount' && !this.totalColumnId()) this.totalColumnId.set(column.id);
    this.columnLabelDraft.set('');
    this.error.set(null);
  }

  public removeColumn(columnId: string): void {
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
    if (column.type === 'checkbox' && target instanceof HTMLInputElement) value = target.checked;
    else if (column.type === 'amount' || column.type === 'number') {
      value = target.value.trim() === '' ? null : Number(target.value);
    } else value = target.value || null;
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
    const companyName = this.newProspectCompany().trim();
    if (companyName.length < 2) {
      this.error.set('Le nom du client doit comporter au moins deux caractères.');
      return;
    }
    this.isCreatingProspect.set(true);
    this.error.set(null);
    const result = await this.quoteService.createProspect({
      companyName,
      contactName: this.newProspectContact().trim() || undefined,
      email: this.newProspectEmail().trim().toLowerCase() || undefined,
      phone: this.newProspectPhone().trim() || undefined,
      ...(this.canAssign() && this.assignedTo() ? { assignedTo: this.assignedTo() } : {}),
    });
    this.isCreatingProspect.set(false);
    if (!result.success || !result.data) {
      this.error.set(result.error || 'Impossible de créer le client.');
      return;
    }
    this.prospectId.set(result.data.id);
    this.clientSearch.set(result.data.companyName || result.data.name);
    this.showNewProspect.set(false);
    this.newProspectCompany.set('');
    this.newProspectContact.set('');
    this.newProspectEmail.set('');
    this.newProspectPhone.set('');
  }

  public async saveQuote(): Promise<void> {
    if (this.isSaving()) return;
    if (!this.prospectId()) {
      this.error.set('Sélectionnez un client avant d’enregistrer la cotation.');
      return;
    }
    if (this.columns().length === 0 || !this.totalColumnOptions().some((column) => column.id === this.totalColumnId())) {
      this.error.set('Ajoutez une colonne de type montant et sélectionnez-la pour calculer le total.');
      return;
    }
    if (this.rows().length === 0) {
      this.error.set('Ajoutez au moins une ligne à la cotation.');
      return;
    }
    if (this.canAssign() && !this.assignedTo()) {
      this.error.set('Choisissez le commercial auquel attribuer cette cotation.');
      return;
    }
    if (this.saveTemplate() && this.templateName().trim().length < 2) {
      this.error.set('Indiquez un nom de modèle partagé ou décochez cette option.');
      return;
    }
    const input: QuoteInput = {
      prospectId: this.prospectId(),
      ...(this.opportunityId() ? { opportunityId: this.opportunityId() } : {}),
      ...(this.assignedTo() ? { assignedTo: this.assignedTo() } : {}),
      title: this.title().trim(),
      currency: this.currency().trim().toUpperCase(),
      columns: this.columns(),
      rows: this.rows(),
      totalColumnId: this.totalColumnId(),
      status: this.status(),
      validUntil: this.validUntil() || null,
    };
    this.isSaving.set(true);
    this.error.set(null);
    const quoteId = this.editingId();
    const result = quoteId
      ? await this.quoteService.updateQuote(quoteId, input)
      : await this.quoteService.createQuote(input);
    if (!result.success) {
      this.isSaving.set(false);
      this.error.set(result.error || 'Impossible d’enregistrer la cotation.');
      return;
    }

    let templateError: string | undefined;
    if (this.saveTemplate() && !quoteId) {
      const templateResult = await this.quoteService.createTemplate({
        name: this.templateName().trim(),
        columns: this.columns(),
        totalColumnId: this.totalColumnId(),
      });
      if (!templateResult.success) templateError = templateResult.error || 'Le modèle partagé n’a pas pu être enregistré.';
    }
    this.isSaving.set(false);
    this.isEditorOpen.set(false);
    this.feedback.set(templateError
      ? `Cotation enregistrée, mais le modèle n’a pas pu être créé : ${templateError}`
      : quoteId ? 'Cotation mise à jour.' : 'Cotation créée.');
    await this.load();
  }

  public async deleteQuote(quote: SalesQuote): Promise<void> {
    if (!this.canDelete() || !confirm(`Supprimer la cotation ${quote.quoteNumber} ?`)) return;
    const result = await this.quoteService.deleteQuote(quote.id);
    if (!result.success) {
      this.feedback.set(result.error || 'Impossible de supprimer cette cotation.');
      return;
    }
    this.feedback.set('Cotation supprimée.');
    await this.load();
  }

  public async deleteTemplate(template: QuoteTemplate): Promise<void> {
    if (!confirm(`Supprimer le modèle partagé « ${template.name} » ?`)) return;
    const result = await this.quoteService.deleteTemplate(template.id);
    if (!result.success) {
      this.error.set(result.error || 'Impossible de supprimer le modèle.');
      return;
    }
    await this.quoteService.loadTemplates();
    if (this.selectedTemplateId() === template.id) this.selectedTemplateId.set('');
  }
}
