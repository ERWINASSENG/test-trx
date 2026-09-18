import { TestBed } from '@angular/core/testing';
import { ExportService } from './export.service';
import { AuthService } from './auth.service';
import { CashierTransaction } from '../models/cashier-transaction.model';
import { signal } from '@angular/core';

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

  it('should return false if transactions list is empty', () => {
    const result = service.exportCashierTransactionsCsv([]);
    expect(result).toBeFalse();
  });

  it('should export with balance column when user is admin', () => {
    authServiceMock.currentUser.set({ role: 'admin' });
    let wasDownloaded = false;
    spyOn<ExportService, 'downloadCsvFile'>(service, 'downloadCsvFile' as never).and.callFake(() => {
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
    expect(result).toBeTrue();
    expect(wasDownloaded).toBeTrue();
  });

  it('should exclude balance column when user is comptable', () => {
    authServiceMock.currentUser.set({ role: 'comptable' });
    let capturedCsv = '';
    spyOn<ExportService, 'downloadCsvFile'>(service, 'downloadCsvFile' as never).and.callFake((csvContent: string) => {
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
    expect(result).toBeTrue();
    expect(capturedCsv).toContain('Statut');
    expect(capturedCsv).not.toContain('Solde courant (FCFA)');
  });
});
