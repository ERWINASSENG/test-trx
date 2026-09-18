import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { CashierImportModal } from './cashier-import-modal.component';
import { ImportService, ParsedImportRow } from '../../../core/services/import.service';

describe('CashierImportModal', () => {
  let component: CashierImportModal;
  let importServiceMock: {
    parseExcelOrCsvFile: ReturnType<typeof vi.fn>;
    downloadExcelTemplate: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    importServiceMock = {
      parseExcelOrCsvFile: vi.fn(),
      downloadExcelTemplate: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ImportService, useValue: importServiceMock },
      ],
    });

    component = runInInjectionContext(injector, () => new CashierImportModal());
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should reject unsupported file extensions', async () => {
    const invalidFile = new File(['content'], 'document.pdf', { type: 'application/pdf' });
    await component.processFile(invalidFile);

    expect(component.errors().length).toBeGreaterThan(0);
    expect(component.errors()[0].message).toContain('Format de fichier non supporté');
    expect(component.validRows().length).toBe(0);
  });

  it('should call parseExcelOrCsvFile for valid .xlsx files', async () => {
    const sampleRows: ParsedImportRow[] = [
      {
        date: '15/09/2026',
        libelle: 'Frais de transport',
        montant: -10000,
        category: 'sortie',
        status: 'draft',
      },
    ];

    importServiceMock.parseExcelOrCsvFile.mockResolvedValue({
      validRows: sampleRows,
      errors: [],
      totalRows: 1,
    });

    const validFile = new File(['dummy'], 'ecritures.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    await component.processFile(validFile);

    expect(importServiceMock.parseExcelOrCsvFile).toHaveBeenCalledWith(validFile);
    expect(component.validRows().length).toBe(1);
    expect(component.errors().length).toBe(0);
  });

  it('should emit dismissModal on cancel', () => {
    let dismissed = false;
    component.dismissModal.subscribe(() => {
      dismissed = true;
    });

    component.onCancel();
    expect(dismissed).toBe(true);
  });

  it('should emit importConfirmed with valid rows', () => {
    const sampleRows: ParsedImportRow[] = [
      {
        date: '15/09/2026',
        libelle: 'Test',
        montant: -5000,
        category: 'sortie',
        status: 'draft',
      },
    ];

    component.validRows.set(sampleRows);

    let emittedRows: ParsedImportRow[] | null = null;
    component.importConfirmed.subscribe((rows) => {
      emittedRows = rows;
    });

    component.confirmImport();
    expect(emittedRows).toEqual(sampleRows);
  });
});
