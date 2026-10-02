import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { DatePipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AccessControlService } from '../../core/services/access-control.service';
import { ProspectService } from '../../core/services/prospect.service';
import { CreateProspectInput, Prospect, ProspectStatus } from '../../core/models/prospect.model';

type ProspectsView = 'list' | 'kanban';

@Component({
  selector: 'app-prospects',
  imports: [A11yModule, ReactiveFormsModule, MatIconModule, DatePipe],
  templateUrl: './prospects.html',
  styleUrl: './prospects.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProspectsComponent {
  public readonly prospectService = inject(ProspectService);
  private readonly accessControl = inject(AccessControlService);

  public readonly statuses: { value: ProspectStatus; label: string }[] = [
    { value: 'new', label: 'Nouveau' },
    { value: 'contacted', label: 'Contacté' },
    { value: 'qualified', label: 'Qualifié' },
    { value: 'converted', label: 'Converti' },
    { value: 'lost', label: 'Perdu' },
  ];
  public readonly statusFilter = signal<ProspectStatus | ''>('');
  public readonly searchDraft = signal('');
  public readonly searchTerm = signal('');
  public readonly view = signal<ProspectsView>('list');
  public readonly offset = signal(0);
  public readonly pageSize = 25;
  public readonly totalPages = computed(() => Math.max(1, Math.ceil(this.prospectService.total() / this.pageSize)));
  public readonly currentPage = computed(() => Math.floor(this.offset() / this.pageSize) + 1);
  public readonly canCreate = computed(() => this.accessControl.hasPermission('prospects.create'));
  public readonly canUpdate = computed(() => this.accessControl.hasPermission('prospects.update'));
  public readonly canDelete = computed(() => this.accessControl.hasPermission('prospects.delete'));
  public readonly statusColumns = computed(() => this.statuses.map((status) => ({
    ...status,
    prospects: this.prospectService.prospects().filter((prospect) => prospect.status === status.value),
  })));

  public readonly isModalOpen = signal(false);
  public readonly editingId = signal<string | null>(null);
  public readonly feedback = signal<string | null>(null);
  public readonly formError = signal<string | null>(null);
  public readonly isSaving = signal(false);

  public readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(2), Validators.maxLength(200)] }),
    companyName: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
    contactName: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
    email: new FormControl('', { nonNullable: true, validators: [Validators.email, Validators.maxLength(320)] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(40)] }),
    source: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    status: new FormControl<ProspectStatus>('new', { nonNullable: true, validators: [Validators.required] }),
    assignedTo: new FormControl('', { nonNullable: true }),
    estimatedValue: new FormControl<number | null>(null, { validators: [Validators.min(0)] }),
    currency: new FormControl('XAF', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^[A-Za-z]{3}$/)] }),
    nextFollowUp: new FormControl('', { nonNullable: true }),
    notes: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(10000)] }),
  });

  public constructor() {
    void this.loadPage();
    void this.prospectService.loadAssignees();
  }

  public async loadPage(): Promise<void> {
    await this.prospectService.loadProspects({
      limit: this.pageSize,
      offset: this.offset(),
      search: this.searchTerm(),
      status: this.statusFilter(),
    });
  }

  public async applyFilters(): Promise<void> {
    this.offset.set(0);
    this.searchTerm.set(this.searchDraft().trim());
    await this.loadPage();
  }

  public async changeStatusFilter(value: string): Promise<void> {
    this.statusFilter.set(value as ProspectStatus | '');
    this.offset.set(0);
    await this.loadPage();
  }

  public async goToPage(direction: -1 | 1): Promise<void> {
    const nextOffset = this.offset() + direction * this.pageSize;
    if (nextOffset < 0 || nextOffset >= this.prospectService.total()) return;
    this.offset.set(nextOffset);
    await this.loadPage();
  }

  public openCreate(): void {
    if (!this.canCreate()) return;
    this.editingId.set(null);
    this.formError.set(null);
    this.form.reset({
      name: '', companyName: '', contactName: '', email: '', phone: '', source: '',
      status: 'new', assignedTo: '', estimatedValue: null, currency: 'XAF', nextFollowUp: '', notes: '',
    });
    this.isModalOpen.set(true);
  }

  public openEdit(prospect: Prospect): void {
    if (!this.canUpdate()) return;
    this.editingId.set(prospect.id);
    this.formError.set(null);
    this.form.reset({
      name: prospect.name,
      companyName: prospect.companyName || '',
      contactName: prospect.contactName || '',
      email: prospect.email || '',
      phone: prospect.phone || '',
      source: prospect.source || '',
      status: prospect.status,
      assignedTo: prospect.assignedTo || '',
      estimatedValue: prospect.estimatedValue,
      currency: prospect.currency,
      nextFollowUp: prospect.nextFollowUp || '',
      notes: prospect.notes,
    });
    this.isModalOpen.set(true);
  }

  public closeModal(): void {
    if (this.isSaving()) return;
    this.isModalOpen.set(false);
    this.editingId.set(null);
  }

  public async saveProspect(): Promise<void> {
    if (this.form.invalid || this.isSaving()) {
      this.form.markAllAsTouched();
      return;
    }
    const values = this.form.getRawValue();
    const input: CreateProspectInput = {
      name: values.name.trim(),
      companyName: values.companyName.trim() || null,
      contactName: values.contactName.trim() || null,
      email: values.email.trim().toLowerCase() || null,
      phone: values.phone.trim() || null,
      source: values.source.trim() || null,
      status: values.status,
      assignedTo: values.assignedTo || null,
      estimatedValue: values.estimatedValue,
      currency: values.currency.trim().toUpperCase(),
      nextFollowUp: values.nextFollowUp || null,
      notes: values.notes.trim(),
    };

    this.isSaving.set(true);
    this.formError.set(null);
    const editingId = this.editingId();
    const result = editingId
      ? await this.prospectService.updateProspect(editingId, input)
      : await this.prospectService.createProspect(input);
    this.isSaving.set(false);

    if (!result.success) {
      this.formError.set(result.error || 'Impossible d’enregistrer le prospect.');
      return;
    }

    this.closeModal();
    this.feedback.set(editingId ? 'Prospect mis à jour.' : 'Prospect créé.');
    await this.loadPage();
  }

  public async deleteProspect(prospect: Prospect): Promise<void> {
    if (!this.canDelete() || !confirm(`Supprimer le prospect « ${prospect.name} » ?`)) return;
    const result = await this.prospectService.deleteProspect(prospect.id);
    if (!result.success) {
      this.feedback.set(result.error || 'Impossible de supprimer ce prospect.');
      return;
    }
    this.feedback.set('Prospect supprimé.');
    if (this.prospectService.prospects().length === 1 && this.offset() > 0) this.offset.update((value) => value - this.pageSize);
    await this.loadPage();
  }

  public statusLabel(status: ProspectStatus): string {
    return this.statuses.find((candidate) => candidate.value === status)?.label || status;
  }

  public statusClass(status: ProspectStatus): string {
    const classes: Record<ProspectStatus, string> = {
      new: 'status-new', contacted: 'status-contacted', qualified: 'status-qualified',
      converted: 'status-converted', lost: 'status-lost',
    };
    return classes[status];
  }

  public assigneeName(id: string | null): string {
    if (!id) return 'Non attribué';
    const assignee = this.prospectService.assignees().find((candidate) => candidate.id === id);
    return assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() || assignee.email : 'Responsable indisponible';
  }

  public formatValue(value: number | null, currency: string): string {
    if (value === null) return '—';
    return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(value)} ${currency}`;
  }
}
