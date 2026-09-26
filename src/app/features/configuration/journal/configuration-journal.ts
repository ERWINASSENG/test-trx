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

  // États locaux de l'interface
  public readonly isActionsMenuOpen = signal<boolean>(false);
  public readonly isDeleting = signal<boolean>(false);
  public readonly isCreateModalOpen = signal<boolean>(false);
  public readonly isSubmitting = signal<boolean>(false);

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
    if (!this.isActionsMenuOpen()) return;
    const target = event.target as HTMLElement;
    const actionsContainer = this.elementRef.nativeElement.querySelector('#journal-cp-actions-dropdown-container');
    if (actionsContainer && !actionsContainer.contains(target)) {
      this.closeActionsMenu();
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

  public onRowClick(journal: Journal): void {
    this.journalService.toggleSelect(journal.id);
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
      const success = await this.journalService.createJournal({
        name: val.name,
        type: val.type,
        sequence_prefix: val.sequence_prefix,
        default_account: val.default_account,
      });

      if (success) {
        this.closeCreateModal();
      }
    } finally {
      this.isSubmitting.set(false);
    }
  }

  public toggleActive(id: string): void {
    this.journalService.toggleActive(id);
  }
}
