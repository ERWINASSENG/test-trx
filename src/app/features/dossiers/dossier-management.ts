import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { DossierService } from '../../core/services/dossier.service';
import { ProspectService } from '../../core/services/prospect.service';
import { CreateDossierInput } from '../../core/services/dossier.service';
import { ModuleControlPanel } from '../../shared/components/module-control-panel/module-control-panel';

@Component({
  selector: 'app-dossier-management',
  imports: [A11yModule, ReactiveFormsModule, MatIconModule, ModuleControlPanel],
  templateUrl: './dossier-management.html',
  styleUrl: './dossier-management.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DossierManagementComponent {
  public readonly dossierService = inject(DossierService);
  public readonly prospectService = inject(ProspectService);
  private readonly accessControl = inject(AccessControlService);
  private readonly authService = inject(AuthService);

  public readonly searchDraft = signal('');
  public readonly searchTerm = signal('');
  public readonly prospectSearch = signal('');
  public readonly offset = signal(0);
  public readonly pageSize = 25;
  public readonly totalPages = computed(() => Math.max(1, Math.ceil(this.dossierService.total() / this.pageSize)));
  public readonly currentPage = computed(() => Math.floor(this.offset() / this.pageSize) + 1);
  public readonly canLinkProspect = computed(() => this.accessControl.hasPermission('prospects.read'));
  public readonly canCreate = computed(() => this.canLinkProspect() && (
    this.accessControl.hasPermission('cashier.create') ||
    (this.authService.currentRole() === 'manager' && this.accessControl.hasPermission('cashier.read'))
  )
  );

  public readonly isModalOpen = signal(false);
  public readonly isSaving = signal(false);
  public readonly feedback = signal<string | null>(null);
  public readonly formError = signal<string | null>(null);

  public readonly form = new FormGroup({
    noDossier: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(100)],
    }),
    description: new FormControl('', { nonNullable: true }),
    prospectId: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

  public constructor() {
    effect(() => {
      if (this.dossierService.consumeCreateModalRequest()) this.openCreate();
    });
    void this.loadPage();
    if (this.canLinkProspect()) void this.loadProspectOptions();
  }

  public async loadPage(): Promise<void> {
    await this.dossierService.loadDossiers({
      limit: this.pageSize,
      offset: this.offset(),
      search: this.searchTerm(),
    });
  }

  public async applyFilters(): Promise<void> {
    this.offset.set(0);
    this.searchTerm.set(this.searchDraft().trim());
    await this.loadPage();
  }

  public async goToPage(direction: -1 | 1): Promise<void> {
    const nextOffset = this.offset() + direction * this.pageSize;
    if (nextOffset < 0 || nextOffset >= this.dossierService.total()) return;
    this.offset.set(nextOffset);
    await this.loadPage();
  }

  public async loadProspectOptions(): Promise<void> {
    if (!this.canLinkProspect()) return;
    await this.prospectService.loadProspects({
      limit: 100,
      offset: 0,
      search: this.prospectSearch().trim(),
    });
  }

  public async searchProspects(): Promise<void> {
    await this.loadProspectOptions();
  }

  public openCreate(): void {
    if (!this.canCreate()) return;
    this.formError.set(null);
    this.form.reset({ noDossier: '', description: '', prospectId: '' });
    this.isModalOpen.set(true);
    if (this.canLinkProspect() && this.prospectService.prospects().length === 0) {
      void this.loadProspectOptions();
    }
  }

  public closeModal(): void {
    if (this.isSaving()) return;
    this.isModalOpen.set(false);
    this.formError.set(null);
  }

  public async saveDossier(): Promise<void> {
    if (this.form.invalid || this.isSaving() || !this.canCreate()) {
      this.form.markAllAsTouched();
      return;
    }

    const values = this.form.getRawValue();
    const input: CreateDossierInput = {
      noDossier: values.noDossier.trim(),
      description: values.description.trim() || null,
      prospectId: values.prospectId,
    };

    this.isSaving.set(true);
    this.formError.set(null);
    const result = await this.dossierService.createDossier(input);
    this.isSaving.set(false);

    if (!result.success) {
      this.formError.set(result.error || 'Impossible de créer le dossier.');
      return;
    }

    this.isModalOpen.set(false);
    this.feedback.set('Dossier créé.');
    await this.loadPage();
  }
}