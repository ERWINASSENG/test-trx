import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import {
  ImportError,
  ImportService,
  ParsedImportRow,
} from '../../../core/services/import.service';

@Component({
  selector: 'app-cashier-import-modal',
  imports: [MatIconModule],
  templateUrl: './cashier-import-modal.component.html',
  styleUrl: './cashier-import-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CashierImportModal {
  private readonly importService = inject(ImportService);

  public readonly fileInputRef = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  // Événements émis vers le composant parent
  public readonly dismissModal = output<void>();
  public readonly importConfirmed = output<ParsedImportRow[]>();

  // États réactifs avec Angular 19 Signals
  public readonly isDragging = signal<boolean>(false);
  public readonly isParsing = signal<boolean>(false);
  public readonly selectedFileName = signal<string | null>(null);
  public readonly validRows = signal<ParsedImportRow[]>([]);
  public readonly errors = signal<ImportError[]>([]);
  public readonly hasParsed = signal<boolean>(false);

  public onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  public onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  public onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void this.processFile(files[0]);
    }
  }

  public onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      void this.processFile(input.files[0]);
    }
  }

  public triggerFileInput(): void {
    this.fileInputRef()?.nativeElement.click();
  }

  public async processFile(file: File): Promise<void> {
    const validExtensions = ['.xlsx', '.xls', '.csv'];
    const lowerName = file.name.toLowerCase();
    const isExtensionValid = validExtensions.some((ext) => lowerName.endsWith(ext));

    if (!isExtensionValid) {
      this.errors.set([
        {
          row: 0,
          message: 'Format de fichier non supporté. Veuillez sélectionner un fichier Excel (.xlsx, .xls) ou CSV.',
        },
      ]);
      this.selectedFileName.set(file.name);
      this.hasParsed.set(true);
      return;
    }

    this.selectedFileName.set(file.name);
    this.isParsing.set(true);
    this.errors.set([]);
    this.validRows.set([]);

    try {
      const result = await this.importService.parseExcelOrCsvFile(file);
      this.validRows.set(result.validRows);
      this.errors.set(result.errors);
      this.hasParsed.set(true);
    } catch {
      this.errors.set([
        {
          row: 0,
          message: 'Impossible de lire le fichier. Veuillez vérifier qu’il n’est pas corrompu ou protégé par mot de passe.',
        },
      ]);
      this.hasParsed.set(true);
    } finally {
      this.isParsing.set(false);
    }
  }

  public downloadTemplate(): void {
    this.importService.downloadExcelTemplate();
  }

  public resetSelection(): void {
    this.selectedFileName.set(null);
    this.validRows.set([]);
    this.errors.set([]);
    this.hasParsed.set(false);
    const input = this.fileInputRef()?.nativeElement;
    if (input) {
      input.value = '';
    }
  }

  public confirmImport(): void {
    const rows = this.validRows();
    if (rows.length > 0) {
      this.importConfirmed.emit(rows);
    }
  }

  public onCancel(): void {
    this.dismissModal.emit();
  }

  public onBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.onCancel();
    }
  }

  public formatCurrency(amount: number): string {
    const formatted = Math.abs(amount).toLocaleString('fr-FR');
    return amount < 0 ? `-${formatted} FCFA` : `${formatted} FCFA`;
  }
}
