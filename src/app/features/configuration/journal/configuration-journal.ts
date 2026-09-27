import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { JournalService } from '../../../core/services/journal.service';
import { Journal, JournalType } from '../../../core/models/journal.model';

@Component({
  selector: 'app-configuration-journal',
  imports: [ReactiveFormsModule, MatIconModule],
  templateUrl: './configuration-journal.html',
  styleUrl: './configuration-journal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class ConfigurationJournalComponent implements OnInit, OnDestroy {
  public readonly journalService = inject(JournalService);
  private readonly router = inject(Router);
  private readonly elementRef = inject(ElementRef);

  // Signaux réactifs pour la synchronisation des données et du layout Odoo
  public readonly searchQuery = this.journalService.searchQuery;
  public readonly pagedJournals = this.journalService.pagedJournals;
  public readonly selectedJournalsCount = this.journalService.selectedJournalsCount;
  public readonly isAllSelected = this.journalService.isAllSelected;
  public readonly paginationLabel = this.journalService.paginationLabel;
  public readonly hasPrevPage = this.journalService.hasPrevPage;
  public readonly hasNextPage = this.journalService.hasNextPage;
  public readonly totalJournalsCount = computed(() => this.journalService.journals().length);
  public readonly canCreateJournal = this.journalService.canCreateJournal;
  public readonly canManageJournals = this.journalService.canManageJournals;
  public readonly isManagerReadOnly = this.journalService.isManagerReadOnly;

  // États locaux de l'interface
  public readonly isActionsMenuOpen = signal<boolean>(false);
  public readonly isDeleting = signal<boolean>(false);
  public readonly isCreateModalOpen = signal<boolean>(false);
  public readonly isSubmitting = signal<boolean>(false);
  public readonly editingJournalId = signal<string | null>(null);
  public readonly isSavingEdit = signal<boolean>(false);

  // Formulaire d'édition en ligne
  public readonly editForm = new FormGroup({
    name: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    type: new FormControl<JournalType>('bank', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    sequence_prefix: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2), Validators.maxLength(6)],
    }),
    default_account: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

  // Formulaire Odoo de création d'un journal
  public readonly journalForm = new FormGroup({
    name: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
    type: new FormControl<JournalType>('bank', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    sequence_prefix: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2), Validators.maxLength(6)],
    }),
    default_account: new FormControl<string>('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

  public ngOnInit(): void {
    this.journalService.loadJournals();
  }

  public ngOnDestroy(): void {
    this.journalService.clearSelection();
  }

  public onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    if (this.isActionsMenuOpen()) {
      const actionsContainer = this.elementRef.nativeElement.querySelector('#journal-cp-actions-dropdown-container');
      if (actionsContainer && !actionsContainer.contains(target)) {
        this.closeActionsMenu();
      }
    }

    // Sauvegarde automatique lors d'un clic extérieur à la ligne en cours d'édition
    const currentEditId = this.editingJournalId();
    if (currentEditId) {
      const editRow = this.elementRef.nativeElement.querySelector(`#inline-edit-journal-${currentEditId}`);
      if (editRow && !editRow.contains(target)) {
        if (this.editForm.valid) {
          void this.saveEdit(currentEditId);
        } else {
          this.cancelEdit();
        }
      }
    }
  }

  public toggleActionsMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.isActionsMenuOpen.update((v) => !v);
  }

  public closeActionsMenu(): void {
    this.isActionsMenuOpen.set(false);
  }

  public onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.journalService.setSearchQuery(input?.value ?? '');
  }

  public onToggleSelect(id: string): void {
    this.journalService.toggleSelect(id);
  }

  public onToggleSelectAll(): void {
    this.journalService.toggleSelectAll(!this.isAllSelected());
  }

  public clearSelection(): void {
    this.journalService.clearSelection();
    this.closeActionsMenu();
  }

  public async onRowClick(journal: Journal): Promise<void> {
    if (this.canManageJournals()) {
      if (this.editingJournalId() !== journal.id) {
        // Sauvegarder la ligne précédente si déjà en édition
        const prevId = this.editingJournalId();
        if (prevId) {
          if (this.editForm.valid) {
            await this.saveEdit(prevId);
          } else {
            this.cancelEdit();
          }
        }
        this.startEdit(journal);
      }
    } else {
      this.journalService.toggleSelect(journal.id);
    }
  }

  public startEdit(journal: Journal, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    if (!this.canManageJournals()) return;

    this.editingJournalId.set(journal.id);
    this.editForm.reset({
      name: journal.name,
      type: journal.type,
      sequence_prefix: journal.sequence_prefix,
      default_account: journal.default_account,
    });
  }

  public cancelEdit(event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.editingJournalId.set(null);
    this.editForm.reset();
  }

  public async saveEdit(id: string, event?: Event): Promise<void> {
    if (event) {
      event.stopPropagation();
    }
    if (this.editForm.invalid || this.isSavingEdit()) return;

    const val = this.editForm.getRawValue();
    this.isSavingEdit.set(true);

    try {
      const updated = await this.journalService.updateJournal(id, {
        name: val.name,
        type: val.type,
        sequence_prefix: val.sequence_prefix,
        default_account: val.default_account,
      });

      if (updated) {
        this.editingJournalId.set(null);
      }
    } finally {
      this.isSavingEdit.set(false);
    }
  }

  public prevPage(): void {
    this.journalService.prevPage();
  }

  public nextPage(): void {
    this.journalService.nextPage();
  }

  public onExportAction(): void {
    const onlySelected = this.selectedJournalsCount() > 0;
    this.journalService.exportJournals(onlySelected);
    this.closeActionsMenu();
  }

  public async onDeleteSelectedAction(): Promise<void> {
    const count = this.selectedJournalsCount();
    if (count === 0) return;

    const confirmed = confirm(`Êtes-vous certain de vouloir supprimer les ${count} journal(s) sélectionné(s) ?`);
    if (!confirmed) return;

    this.isDeleting.set(true);
    try {
      await this.journalService.deleteSelectedJournals();
    } finally {
      this.isDeleting.set(false);
      this.closeActionsMenu();
    }
  }

  public openCreateModal(): void {
    this.journalForm.reset({
      name: '',
      type: 'bank',
      sequence_prefix: '',
      default_account: '',
    });
    this.isCreateModalOpen.set(true);
  }

  public closeCreateModal(): void {
    this.isCreateModalOpen.set(false);
  }

  public async submitCreateJournal(): Promise<void> {
    if (this.journalForm.invalid || this.isSubmitting()) return;

    this.isSubmitting.set(true);
    try {
      const val = this.journalForm.getRawValue();
      const created = await this.journalService.createJournal({
        name: val.name,
        type: val.type,
        sequence_prefix: val.sequence_prefix,
        default_account: val.default_account,
      });

      if (created) {
        this.closeCreateModal();
        // Bascule directe dans l'écran de caisse / saisie d'opérations configuré sur ce nouveau journal
        this.router.navigate(['/caisse'], { queryParams: { journalId: created.id } });
      }
    } finally {
      this.isSubmitting.set(false);
    }
  }

  public openJournalTransactions(journal: Journal): void {
    this.router.navigate(['/caisse'], { queryParams: { journalId: journal.id } });
  }

  public toggleActive(id: string): void {
    this.journalService.toggleActive(id);
  }
}
