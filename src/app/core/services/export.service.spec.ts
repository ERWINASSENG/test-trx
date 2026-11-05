import { TestBed } from '@angular/core/testing';
import { ExportService } from './export.service';
import { AuthService } from './auth.service';
import { CashierTransaction } from '../models/cashier-transaction.model';
import { SalesQuote } from '../models/quote.model';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import jsPDF from 'jspdf';

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

  describe('CSV Export', () => {
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

  describe('PDF Export for Quotes (Cotations Maritimes)', () => {
    const createPdfDocumentSpy = () => {
      const doc = new jsPDF();
      const saveSpy = vi.fn();
      Object.defineProperty(doc, 'save', {
        configurable: true,
        value: (filename?: string) => {
          saveSpy(filename);
          return doc;
        },
      });
      const addPageSpy = vi.spyOn(doc, 'addPage');
      vi.spyOn(
        service as unknown as { createPdfDocument: () => jsPDF },
        'createPdfDocument'
      ).mockReturnValue(doc);
      return { saveSpy, addPageSpy };
    };

    const mockQuote: SalesQuote = {
      id: 'quote-101',
      quoteNumber: 'COT-2026-001',
      prospectId: 'prospect-101',
      title: 'Acheminement Conteneur 40ft Douala',
      status: 'sent',
      prospectName: 'Cameroun Trading SARL',
      assignedTo: 'user-101',
      contactName: 'M. Jean Nguemo',
      createdBy: 'user-101',
      totalAmount: 1850000,
      currency: 'FCFA',
      totalColumnId: 'total',
      createdAt: '2026-10-01T10:00:00Z',
      validUntil: '2026-10-31T23:59:59Z',
      assignedToName: 'Marc Dupont',
      updatedAt: '2026-10-01T10:00:00Z',
      seaFreight: {
        portOfLoading: 'Le Havre (France)',
        portOfDischarge: 'Douala (Cameroun)',
        incoterm: 'CIF',
        goodsType: 'Pièces détachées industrielles',
        goodsDescription: 'Colis métalliques sur palettes',
        grossWeightKg: 14500,
        totalVolumeM3: 42,
        packagesCount: 18,
        contactName: 'M. Jean Nguemo',
        email: 'j.nguemo@camtrading.cm',
        phone: '+237 699 00 11 22',
      },
      columns: [
        { id: 'prestation', label: 'Rubrique tarifaire', type: 'text' },
        { id: 'qty', label: 'Quantité', type: 'number' },
        { id: 'unit_price', label: 'Tarif Unitaire', type: 'amount' },
        { id: 'total', label: 'Montant Total', type: 'amount' },
      ],
      rows: [
        {
          id: 'row-1',
          prestation: 'Fret maritime conteneur 40ft',
          qty: 1,
          unit_price: 1200000,
          total: 1200000,
        },
        {
          id: 'row-2',
          prestation: 'Passage portuaire & acconage Douala',
          qty: 1,
          unit_price: 450000,
          total: 450000,
        },
        {
          id: 'row-3',
          prestation: 'Formalités douanières déclaratives',
          qty: 1,
          unit_price: 200000,
          total: 200000,
        },
      ],
    };

    it('should return false if quote list is empty or undefined', () => {
      expect(service.exportQuotesPdf([])).toBe(false);
      expect(service.exportQuotesPdf(null as unknown as SalesQuote[])).toBe(false);
    });

    it('should successfully trigger PDF export for a single quote with sanitized filename', () => {
      const { saveSpy } = createPdfDocumentSpy();

      const quoteWithSpecialChars: SalesQuote = {
        ...mockQuote,
        quoteNumber: 'COT/2026#009/SPECIAL',
      };

      const result = service.exportQuotesPdf([quoteWithSpecialChars]);

      expect(result).toBe(true);
      expect(saveSpy).toHaveBeenCalledWith('cotation_COT_2026_009_SPECIAL.pdf');
    });

    it('should support batch export with multiple quotes and add pages', () => {
      const { addPageSpy, saveSpy } = createPdfDocumentSpy();

      const quote2: SalesQuote = {
        ...mockQuote,
        id: 'quote-102',
        quoteNumber: 'COT-2026-002',
        totalAmount: 950000,
      };

      const result = service.exportQuotesPdf([mockQuote, quote2]);

      expect(result).toBe(true);
      expect(addPageSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledOnce();
      expect(saveSpy.mock.calls[0][0]).toMatch(/^cotations_export_.*\.pdf$/);
    });

    it('should handle quote with missing seaFreight and empty rows gracefully', () => {
      const { saveSpy } = createPdfDocumentSpy();

      const minimalQuote: SalesQuote = {
        id: 'quote-minimal',
        quoteNumber: 'COT-MIN-001',
        prospectId: 'prospect-minimal',
        title: 'Cotation sans fret maritime détaillé',
        status: 'draft',
        prospectName: 'Client Inconnu',
        assignedTo: null,
        assignedToName: null,
        createdBy: null,
        totalAmount: 0,
        currency: 'FCFA',
        totalColumnId: 'total',
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
        validUntil: null,
        columns: [],
        rows: [],
      };

      expect(() => service.exportQuotesPdf([minimalQuote])).not.toThrow();
      expect(saveSpy).toHaveBeenCalledOnce();
    });
  });
});
