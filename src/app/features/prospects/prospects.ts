import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AccessControlService } from '../../core/services/access-control.service';
import { ProspectService } from '../../core/services/prospect.service';
import { CreateProspectInput, Prospect, ProspectStatus } from '../../core/models/prospect.model';
import { ModuleControlPanel } from '../../shared/components/module-control-panel/module-control-panel';
import { getCountryFlagUrl } from '../../core/utils/country-flag.util';

type ProspectsView = 'list' | 'kanban';
export type ProspectSortField = 'client' | 'country' | 'sector' | 'contact' | 'phone' | 'email' | 'assignee' | 'status';
export type SortDirection = 'asc' | 'desc';

@Component({
  selector: 'app-prospects',
  imports: [A11yModule, ReactiveFormsModule, MatIconModule, ModuleControlPanel],
  templateUrl: './prospects.html',
  styleUrl: './prospects.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProspectsComponent {
  public readonly prospectService = inject(ProspectService);
  private readonly accessControl = inject(AccessControlService);
  private readonly destroyRef = inject(DestroyRef);
  private feedbackTimeout: ReturnType<typeof setTimeout> | null = null;

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

  // État du tri sur le tableau des prospects
  public readonly sortField = signal<ProspectSortField | null>(null);
  public readonly sortDirection = signal<SortDirection>('asc');

  public toggleSort(field: ProspectSortField): void {
    if (this.sortField() === field) {
      if (this.sortDirection() === 'asc') {
        this.sortDirection.set('desc');
      } else {
        this.sortField.set(null);
        this.sortDirection.set('asc');
      }
    } else {
      this.sortField.set(field);
      this.sortDirection.set('asc');
    }
  }

  public getSortIcon(field: ProspectSortField): string {
    if (this.sortField() !== field) return 'unfold_more';
    return this.sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  public getAriaSort(field: ProspectSortField): 'ascending' | 'descending' | 'none' {
    if (this.sortField() !== field) return 'none';
    return this.sortDirection() === 'asc' ? 'ascending' : 'descending';
  }

  public readonly sortedProspects = computed(() => {
    const list = this.prospectService.prospects();
    const field = this.sortField();
    if (!field) return list;

    const direction = this.sortDirection();
    const multiplier = direction === 'asc' ? 1 : -1;

    return [...list].sort((a, b) => {
      let valA = '';
      let valB = '';

      switch (field) {
        case 'client':
          valA = a.companyName || a.name || '';
          valB = b.companyName || b.name || '';
          break;
        case 'country':
          valA = a.country || a.notes || '';
          valB = b.country || b.notes || '';
          break;
        case 'sector':
          valA = a.sector || a.source || '';
          valB = b.sector || b.source || '';
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
        case 'assignee':
          valA = this.assigneeName(a.assignedTo);
          valB = this.assigneeName(b.assignedTo);
          break;
        case 'status':
          valA = this.statusLabel(a.status);
          valB = this.statusLabel(b.status);
          break;
      }

      return valA.localeCompare(valB, 'fr', { sensitivity: 'base', numeric: true }) * multiplier;
    });
  });

  public readonly statusColumns = computed(() => this.statuses.map((status) => ({
    ...status,
    prospects: this.sortedProspects().filter((prospect) => prospect.status === status.value),
  })));

  // Gestion de la sélection par case à cocher
  public readonly selectedIds = signal<Set<string>>(new Set());
  public readonly isAllSelected = computed(() => {
    const list = this.sortedProspects();
    if (list.length === 0) return false;
    const selected = this.selectedIds();
    return list.every((prospect) => selected.has(prospect.id));
  });

  public readonly isModalOpen = signal(false);
  public readonly editingId = signal<string | null>(null);
  public readonly feedback = signal<string | null>(null);
  public readonly formError = signal<string | null>(null);
  public readonly isSaving = signal(false);

  public readonly form = new FormGroup({
    companyName: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(2), Validators.maxLength(200)] }),
    contactName: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(200)] }),
    contactRole: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(150)] }),
    country: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    sector: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(100)] }),
    phone: new FormControl('', { nonNullable: true, validators: [Validators.maxLength(40)] }),
    email: new FormControl('', { nonNullable: true, validators: [Validators.email, Validators.maxLength(320)] }),
    assignedTo: new FormControl<string | null>(null),
  });

  public constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.feedbackTimeout) {
        clearTimeout(this.feedbackTimeout);
        this.feedbackTimeout = null;
      }
    });
    void this.loadPage();
    void this.prospectService.loadAssignees();
  }

  public showFeedback(message: string): void {
    if (this.feedbackTimeout) {
      clearTimeout(this.feedbackTimeout);
      this.feedbackTimeout = null;
    }
    this.feedback.set(message);
    this.feedbackTimeout = setTimeout(() => {
      this.feedback.set(null);
      this.feedbackTimeout = null;
    }, 10000);
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

  public toggleSelectAll(): void {
    const current = this.selectedIds();
    const list = this.sortedProspects();
    if (this.isAllSelected()) {
      this.selectedIds.set(new Set());
    } else {
      const next = new Set(current);
      for (const item of list) {
        next.add(item.id);
      }
      this.selectedIds.set(next);
    }
  }

  public toggleSelect(id: string): void {
    const current = new Set(this.selectedIds());
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    this.selectedIds.set(current);
  }

  public isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  public getCountryFlag(country: string | null | undefined): string | null {
    return getCountryFlagUrl(country);
  }

  public getMonogram(name: string | null | undefined): string {
    if (!name) return 'PR';
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

  public getDisplayStatus(status: ProspectStatus): { label: string; class: string } {
    if (status === 'converted' || status === 'qualified') {
      return { label: 'Actif', class: 'status-badge-active' };
    }
    if (status === 'lost') {
      return { label: 'Perdu', class: 'status-badge-lost' };
    }
    return { label: 'Prospect', class: 'status-badge-prospect' };
  }

  public openCreate(): void {
    if (!this.canCreate()) return;
    this.editingId.set(null);
    this.formError.set(null);
    this.form.reset({
      companyName: '',
      contactName: '',
      contactRole: '',
      country: '',
      sector: '',
      phone: '',
      email: '',
      assignedTo: null,
    });
    this.isModalOpen.set(true);
  }

  public openEdit(prospect: Prospect): void {
    if (!this.canUpdate()) return;
    this.editingId.set(prospect.id);
    this.formError.set(null);
    this.form.reset({
      companyName: prospect.companyName || prospect.name || '',
      contactName: prospect.contactName || '',
      contactRole: prospect.contactRole || '',
      country: prospect.country || '',
      sector: prospect.sector || prospect.source || '',
      phone: prospect.phone || '',
      email: prospect.email || '',
      assignedTo: prospect.assignedTo || null,
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
    const companyName = values.companyName.trim();
    const contactName = values.contactName.trim() || null;
    const contactRole = values.contactRole.trim() || null;
    const country = values.country.trim() || null;
    const sector = values.sector.trim() || null;
    const assignedTo = values.assignedTo && typeof values.assignedTo === 'string' && values.assignedTo.trim()
      ? values.assignedTo.trim()
      : null;

    const input: CreateProspectInput = {
      name: companyName || contactName || 'Prospect',
      companyName: companyName || null,
      contactName,
      contactRole,
      country,
      sector,
      source: sector,
      notes: JSON.stringify({ country: country || '', contactRole: contactRole || '' }),
      phone: values.phone.trim() || null,
      email: values.email.trim().toLowerCase() || null,
      assignedTo,
      status: 'new',
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
    this.showFeedback(editingId ? 'Prospect mis à jour.' : 'Prospect créé.');
    await this.loadPage();
  }

  public async deleteProspect(prospect: Prospect): Promise<void> {
    if (!this.canDelete() || !confirm(`Supprimer le prospect « ${prospect.name} » ?`)) return;
    const result = await this.prospectService.deleteProspect(prospect.id);
    if (!result.success) {
      this.showFeedback(result.error || 'Impossible de supprimer ce prospect.');
      return;
    }
    this.showFeedback('Prospect supprimé.');
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
