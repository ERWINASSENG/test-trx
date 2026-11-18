import { TestBed } from '@angular/core/testing';
import { ExportService } from './export.service';
import { AuthService } from './auth.service';
import { CashierTransaction, DailyCashierReport } from '../models/cashier-transaction.model';
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

  describe('Daily Cashier Report Export (CAISSE TRX)', () => {
    const sampleReport: DailyCashierReport = {
      date: '2026-11-13',
      displayDate: '13/11/2026',
      title: 'CAISSE TRX du 13/11/2026',
      journalId: 'native-caisse-principal',
      journalName: 'Caisse Principale',
      journalPrefix: 'CSH1',
      reportSolde: 736291,
      recettes: [
        {
          id: 'rec-1',
          date: '13/11/2026',
          libelle: 'APPROV CAISSE ; Retrait BCPME',
          noDossier: null,
          pieceComptable: 'CSH1/2026/00100',
          partenaire: null,
          service: 'DG',
          montant: 20000000,
          category: 'entree',
        },
        {
          id: 'rec-2',
          date: '13/11/2026',
          libelle: 'Retour partiel de la provision',
          noDossier: null,
          pieceComptable: 'CSH1/2026/00101',
          partenaire: 'M ZAKARI',
          service: 'TRANSIT',
          montant: 212500,
          category: 'entree',
        },
      ],
      totalRecettes: 20212500,
      totalApresRecettes: 20948791,
      depenses: [
        {
          id: 'dep-1',
          date: '13/11/2026',
          libelle: '=HYPERLINK("https://evil.example") Carburant',
          noDossier: 'LTTR269AG',
          pieceComptable: 'CSH1/2026/00102',
          partenaire: 'ZAK/SONYA',
          service: 'TRANSPORT',
          montant: 7600000,
          category: 'sortie',
        },
        {
          id: 'dep-2',
          date: '13/11/2026',
          libelle: 'Règlement facture ENEO TRX',
          noDossier: null,
          pieceComptable: 'CSH1/2026/00103',
          partenaire: null,
          service: 'DG',
          montant: 12734856,
          category: 'sortie',
        },
      ],
      totalDepenses: 20334856,
      soldeFinal: 613935,
    };

    it('should neutralize Excel formula injection prefixes (S7)', () => {
      expect(service.sanitizeExcelText('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
      expect(service.sanitizeExcelText('+CMD|calc')).toBe("'+CMD|calc");
      expect(service.sanitizeExcelText('-100')).toBe("'-100");
      expect(service.sanitizeExcelText('@evil')).toBe("'@evil");
      expect(service.sanitizeExcelText('Carburant standard')).toBe('Carburant standard');
      expect(service.sanitizeExcelText(null)).toBe('');
    });

    it('should return false when daily report is missing or invalid', async () => {
      expect(service.exportDailyCashierReportPdf(null as unknown as DailyCashierReport)).toBe(false);
      await expect(
        service.exportDailyCashierReportExcel(null as unknown as DailyCashierReport)
      ).resolves.toBe(false);
    });

    it('should export daily cashier report as PDF with sanitized filename', () => {
      const doc = new jsPDF();
      const saveSpy = vi.fn();
      Object.defineProperty(doc, 'save', {
        configurable: true,
        value: (filename?: string) => {
          saveSpy(filename);
          return doc;
        },
      });
      vi.spyOn(
        service as unknown as { createPdfDocument: () => jsPDF },
        'createPdfDocument'
      ).mockReturnValue(doc);

      const result = service.exportDailyCashierReportPdf(sampleReport);

      expect(result).toBe(true);
      expect(saveSpy).toHaveBeenCalledWith('CAISSE_TRX_2026-11-13.pdf');
    });

    it('should export daily cashier report as .xlsx workbook with exact sections and formula neutralization', async () => {
      const captured: {
        filename: string;
        mime: string;
        data: ArrayBuffer | Uint8Array | null;
      } = {
        filename: '',
        mime: '',
        data: null,
      };

      vi.spyOn(
        service as unknown as {
          downloadBinaryFile: (data: ArrayBuffer | Uint8Array, filename: string, mimeType: string) => void;
        },
        'downloadBinaryFile'
      ).mockImplementation((data, filename, mimeType) => {
        captured.data = data;
        captured.filename = filename;
        captured.mime = mimeType;
      });

      const result = await service.exportDailyCashierReportExcel(sampleReport);

      expect(result).toBe(true);
      expect(captured.filename).toBe('CAISSE_TRX_2026-11-13.xlsx');
      expect(captured.mime).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(captured.data).toBeTruthy();
      if (!captured.data) {
        throw new Error('Expected binary workbook payload');
      }

      const excelModule = await import('exceljs');
      const ExcelJS = excelModule.default || excelModule;
      const workbook = new ExcelJS.Workbook();
      const bytes = captured.data instanceof Uint8Array ? captured.data : new Uint8Array(captured.data);
      await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

      const sheet = workbook.getWorksheet('CAISSE TRX');
      expect(sheet).toBeTruthy();
      if (!sheet) {
        throw new Error('Expected CAISSE TRX worksheet');
      }
      expect(sheet.getRow(1).getCell(1).value).toBe('CAISSE TRX du 13/11/2026');
      expect(sheet.getRow(2).getCell(3).value).toBe(736291);

      const values = sheet.getSheetValues().map((row) =>
        Array.isArray(row) ? row.map((v) => String(v ?? '')).join(' | ') : ''
      );
      const flatText = values.join('\n');
      expect(flatText).toContain('TOTAL\nRECETTES');
      expect(flatText).toContain('20212500');
      expect(flatText).toContain('20948791');
      expect(flatText).toContain('20334856');
      expect(flatText).toContain('613935');
      expect(flatText).toContain('ZAK/SONYA');
      expect(flatText).toContain('LTTR269AG');
    });
  });
});

