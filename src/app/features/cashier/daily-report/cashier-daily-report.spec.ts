import '@angular/compiler';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CashierDailyReport } from './cashier-daily-report';
import { CashierService } from '../../../core/services/cashier.service';
import { ExportService } from '../../../core/services/export.service';
import { JournalService } from '../../../core/services/journal.service';
import { AuthService } from '../../../core/services/auth.service';
import { AccessControlService } from '../../../core/services/access-control.service';
import { NotificationService } from '../../../core/services/notification.service';
import { DailyCashierReport } from '../../../core/models/cashier-transaction.model';
import { UserRole } from '../../../core/models/auth.model';

describe('CashierDailyReport Component', () => {
  let component: CashierDailyReport;
  let fixture: ComponentFixture<CashierDailyReport>;

  const sampleReport: DailyCashierReport = {
    date: '2026-11-13',
    displayDate: '13/11/2026',
    title: 'CAISSE TRX du 13/11/2026',
    journalId: 'native-caisse-principal',
    journalName: 'CAISSE TRX',
    journalPrefix: 'CSH1',
    reportSolde: 1126095,
    recettes: [
      {
        id: 'rec-1',
        date: '13/11/2026',
        libelle: 'Appro caisse principale',
        montant: 200000,
        pieceComptable: 'CSH1/2026/00101',
        category: 'entree',
      },
    ],
    depenses: [
      {
        id: 'dep-1',
        date: '13/11/2026',
        libelle: 'Transport Course',
        noDossier: 'OT7116',
        montant: 5000,
        pieceComptable: 'NP738',
        partenaire: 'NP738 NDOUMBE',
        category: 'sortie',
      },
    ],
    totalRecettes: 200000,
    totalApresRecettes: 1326095,
    totalDepenses: 5000,
    soldeFinal: 1321095,
  };

  let currentRole = signal<UserRole>('caissiere');
  let canExportFlag = signal<boolean>(true);
  let canReadJournalEntriesFlag = signal<boolean>(false);

  const cashierServiceMock = {
    fetchDailyReport: vi.fn().mockResolvedValue(sampleReport),
  };

  const exportServiceMock = {
    exportDailyCashierReportPdf: vi.fn(),
    exportDailyCashierReportExcel: vi.fn().mockResolvedValue(undefined),
    formatReportInteger: (val: number) =>
      Math.round(val).toLocaleString('fr-FR').replace(/\u202F/g, ' '),
    formatReportAmount: (val: number) =>
      Math.abs(Math.round(val)).toLocaleString('fr-FR').replace(/\u202F/g, ' '),
    formatDailyReportLibelle: (item: { libelle: string }) => item.libelle,
    formatDailyReportPieceCol: (item: { partenaire?: string | null; pieceComptable?: string | null }) =>
      item.partenaire || item.pieceComptable || '',
  };

  const journalServiceMock = {
    journals: signal([
      {
        id: 'custom-j1',
        name: 'Banque Principale',
        type: 'bank' as const,
        sequence_prefix: 'BNK1',
        default_account: '521',
        currency: 'XAF',
        is_active: true,
      },
    ]),
    loadJournals: vi.fn().mockResolvedValue(undefined),
  };

  const notificationServiceMock = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    currentRole = signal<UserRole>('caissiere');
    canExportFlag = signal<boolean>(true);
    canReadJournalEntriesFlag = signal<boolean>(false);
    cashierServiceMock.fetchDailyReport.mockResolvedValue(sampleReport);

    await TestBed.configureTestingModule({
      imports: [CashierDailyReport],
      providers: [
        provideRouter([]),
        { provide: CashierService, useValue: cashierServiceMock },
        { provide: ExportService, useValue: exportServiceMock },
        { provide: JournalService, useValue: journalServiceMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        {
          provide: AuthService,
          useValue: {
            currentRole,
          },
        },
        {
          provide: AccessControlService,
          useValue: {
            hasPermission: (perm: string) => {
              if (perm === 'cashier.export') return canExportFlag();
              if (perm === 'journal_entries.read') return canReadJournalEntriesFlag();
              return false;
            },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CashierDailyReport);
    component = fixture.componentInstance;
  });

  it('charge automatiquement la prévisualisation du rapport journalier au démarrage', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(cashierServiceMock.fetchDailyReport).toHaveBeenCalledTimes(1);
    expect(component.report()).toEqual(sampleReport);
    const titleEl = fixture.nativeElement.querySelector('#daily-report-sheet-title');
    expect(titleEl?.textContent).toContain('CAISSE TRX du 13/11/2026');
  });

  it('recharge la prévisualisation lorsque l’utilisateur change la date', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    cashierServiceMock.fetchDailyReport.mockClear();
    component.dateControl.setValue('2026-11-12');
    await fixture.whenStable();

    expect(cashierServiceMock.fetchDailyReport).toHaveBeenCalledWith(
      '2026-11-12',
      'native-caisse-principal'
    );
  });

  it('exporte le rapport prévisualisé en PDF et en Excel (.xlsx)', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    await component.exportCurrentReport('pdf');
    expect(exportServiceMock.exportDailyCashierReportPdf).toHaveBeenCalledWith(sampleReport);
    expect(notificationServiceMock.success).toHaveBeenCalled();

    await component.exportCurrentReport('xlsx');
    expect(exportServiceMock.exportDailyCashierReportExcel).toHaveBeenCalledWith(sampleReport);
  });

  it('bloque le chargement si la permission cashier.export est absente', async () => {
    canExportFlag.set(false);
    cashierServiceMock.fetchDailyReport.mockClear();

    await component.loadPreview();
    expect(cashierServiceMock.fetchDailyReport).not.toHaveBeenCalled();
    expect(component.report()).toBeNull();
    expect(component.errorMessage()).toContain('permission');
  });
});
