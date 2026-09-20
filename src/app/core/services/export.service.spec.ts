import { TestBed } from '@angular/core/testing';
import { ExportService } from './export.service';
import { AuthService } from './auth.service';
import { CashierTransaction } from '../models/cashier-transaction.model';
import { signal } from '@angular/core';
import { vi } from 'vitest';

describe('ExportService', () => {
  let service: ExportService;
  let authServiceMock: { currentUser: ReturnType<typeof signal<{ role: string } | null>> };

  beforeEach(() => {
    authServiceMock = {
      currentUser: signal<{ role: string } | null>({ role: 'admin' }),
    };

    TestBed.configureTestingModule({
      providers: [
        ExportService,
        { provide: AuthService, useValue: authServiceMock },
      ],
    });

    service = TestBed.inject(ExportService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should escape CSV values with quotes and double quotes', () => {
    expect(service.escapeCsv('Texte')).toBe('"Texte"');
    expect(service.escapeCsv('Guillemet "Test"')).toBe('"Guillemet ""Test"""');
    expect(service.escapeCsv('')).toBe('""');
  });

  it('should neutralize spreadsheet formulas in CSV values', () => {
    expect(service.escapeCsv('=HYPERLINK("https://example.com")')).toBe('"\'=HYPERLINK(""https://example.com"")"');
    expect(service.escapeCsv('+SUM(1,2)')).toBe('"\'+SUM(1,2)"');
    expect(service.escapeCsv('@cmd')).toBe('"\'@cmd"');
  });

  it('should return false if transactions list is empty', () => {
    const result = service.exportCashierTransactionsCsv([]);
    expect(result).toBe(false);
  });

  it('should export with balance column when user is admin', () => {
    authServiceMock.currentUser.set({ role: 'admin' });
    let wasDownloaded = false;
    vi.spyOn(service as unknown as { downloadCsvFile: () => void }, 'downloadCsvFile').mockImplementation(() => {
      wasDownloaded = true;
    });

    const testItem: CashierTransaction = {
      id: 'id-1',
      date: '2026-09-15',
      libelle: 'Operation',
      service: 'TRANSIT',
      montant: 1000,
      soldeApres: 1000,
      category: 'entree',
      status: 'posted',
    };

    const result = service.exportCashierTransactionsCsv([testItem]);
    expect(result).toBe(true);
    expect(wasDownloaded).toBe(true);
  });

  it('should exclude balance column when user is comptable', () => {
    authServiceMock.currentUser.set({ role: 'comptable' });
    let capturedCsv = '';
    vi.spyOn(service as unknown as { downloadCsvFile: (csvContent: string) => void }, 'downloadCsvFile').mockImplementation((csvContent: string) => {
      capturedCsv = csvContent;
    });

    const testItem: CashierTransaction = {
      id: 'id-1',
      date: '2026-09-15',
      libelle: 'Operation',
      service: 'TRANSIT',
      montant: 1000,
      soldeApres: 1000,
      category: 'entree',
      status: 'posted',
    };

    const result = service.exportCashierTransactionsCsv([testItem]);
    expect(result).toBe(true);
    expect(capturedCsv).toContain('Statut');
    expect(capturedCsv).not.toContain('Solde courant (FCFA)');
  });
});
