// =============================================================================
// Tests unitaires — CrmTimingComponent
// Couverture : Cas nominal, filtres, popover calendrier, modale, erreurs, état vide
// =============================================================================

import { TestBed, ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CrmTimingComponent } from './crm-timing';
import { QuoteService } from '../../../../core/services/quote.service';
import { AccessControlService } from '../../../../core/services/access-control.service';
import {
  QuoteTimingAnalyticsResponse,
  QuoteTimingItem,
  SalesRepPerformance,
} from '../../../../core/models/quote.model';

// ---------------------------------------------------------------------------
// SECTION 1 : DONNÉES FACTICES POUR LES TESTS
// ---------------------------------------------------------------------------
const MOCK_QUOTE_ITEM: QuoteTimingItem = {
  id: 'quote-1',
  quoteNumber: 'COT-2026-001',
  clientName: 'SOCAPALM Cameroun',
  details: 'Fret Maritime 2x40ft Le Havre - Douala',
  repId: 'rep-1',
  repName: 'Jean Dupont',
  amount: 4500000,
  amountFormatted: '4 500 000 FCFA',
  status: 'sent',
  commercialMinutes: 120,
  commercialDelayFormatted: '2h 00m',
  clientMinutes: 360,
  clientDelayFormatted: '6h 00m',
  isSlaBreach: false,
  isOverdue: false,
  date: '2026-10-20',
  createdAtFormatted: '20/10/2026 09:00',
  sentAtFormatted: '20/10/2026 11:00',
  respondedAtFormatted: '20/10/2026 17:00',
};

const MOCK_OVERDUE_QUOTE: QuoteTimingItem = {
  id: 'quote-2',
  quoteNumber: 'COT-2026-002',
  clientName: 'ALUCAM SA',
  details: 'Dédouanement Express Port de Kribi',
  repId: 'rep-2',
  repName: 'Marie Claire',
  amount: 8200000,
  amountFormatted: '8 200 000 FCFA',
  status: 'draft',
  commercialMinutes: 3000,
  commercialDelayFormatted: '50h 00m',
  clientMinutes: null,
  clientDelayFormatted: '-',
  isSlaBreach: true,
  isOverdue: true,
  date: '2026-10-18',
  createdAtFormatted: '18/10/2026 08:30',
  sentAtFormatted: '-',
  respondedAtFormatted: '-',
};

const MOCK_REP: SalesRepPerformance = {
  repId: 'rep-1',
  repName: 'Jean Dupont',
  quotesCount: 12,
  avgDelayFormatted: '2h 15m',
  slaRateFormatted: '91.7%',
  conversionRateFormatted: '68.0%',
  totalAmount: 54000000,
  totalAmountFormatted: '54 000 000 FCFA',
};

const MOCK_ANALYTICS: QuoteTimingAnalyticsResponse = {
  kpis: {
    avgDelayFormatted: '2h 45m',
    avgDelayMinutes: 165,
    slaComplianceRateFormatted: '88.5%',
    slaCompliancePercent: 88.5,
    inProgressCount: 7,
    overdueCount: 2,
    totalAmount: 125000000,
    totalAmountFormatted: '125 000 000 FCFA',
    conversionRateFormatted: '65.2%',
    conversionPercent: 65.2,
  },
  quotes: [MOCK_QUOTE_ITEM, MOCK_OVERDUE_QUOTE],
  reps: [MOCK_REP],
  totalCount: 2,
};

// ---------------------------------------------------------------------------
// SECTION 2 : CONFIGURATION DU TESTBED & INSTANCIATION
// ---------------------------------------------------------------------------
describe('CrmTimingComponent', () => {
  let component: CrmTimingComponent;
  let fixture: ComponentFixture<CrmTimingComponent>;

  let mockTimingAnalyticsSignal: ReturnType<typeof signal<QuoteTimingAnalyticsResponse | null>>;
  let mockIsLoadingSignal: ReturnType<typeof signal<boolean>>;
  let mockErrorSignal: ReturnType<typeof signal<string | null>>;
  let mockLoadTimingAnalytics: ReturnType<typeof vi.fn>;

  const mockAccessControl = {
    hasPermission: vi.fn((perm: string) => perm === 'quotes.timing.read'),
  };

  beforeEach(async () => {
    mockTimingAnalyticsSignal = signal<QuoteTimingAnalyticsResponse | null>(MOCK_ANALYTICS);
    mockIsLoadingSignal = signal<boolean>(false);
    mockErrorSignal = signal<string | null>(null);
    mockLoadTimingAnalytics = vi.fn().mockResolvedValue(undefined);

    const mockQuoteService = {
      timingAnalytics: mockTimingAnalyticsSignal,
      isTimingLoading: mockIsLoadingSignal,
      timingError: mockErrorSignal,
      loadTimingAnalytics: mockLoadTimingAnalytics,
    };

    await TestBed.configureTestingModule({
      imports: [CrmTimingComponent],
      providers: [
        { provide: QuoteService, useValue: mockQuoteService },
        { provide: AccessControlService, useValue: mockAccessControl },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CrmTimingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  // -------------------------------------------------------------------------
  // SECTION 3 : TESTS DU CYCLE DE VIE ET CAS NOMINAL
  // -------------------------------------------------------------------------
  it('devrait instancier le composant et charger les données initiales', () => {
    expect(component).toBeTruthy();
    expect(mockLoadTimingAnalytics).toHaveBeenCalledWith({
      period: 'month',
      date: null,
      repId: undefined,
    });
  });

  it('devrait exposer les KPI calculés et la liste des cotations', () => {
    expect(component.kpis().avgDelayFormatted).toBe('2h 45m');
    expect(component.kpis().slaCompliancePercent).toBe(88.5);
    expect(component.kpis().overdueCount).toBe(2);
    expect(component.allQuotes().length).toBe(2);
    expect(component.salesReps().length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // SECTION 4 : GESTION DES SOUS-ONGLETS ET SÉLECTEURS DE PÉRIODE
  // -------------------------------------------------------------------------
  it('devrait permettre de basculer entre les sous-onglets de vue', () => {
    expect(component.currentSubTab()).toBe('quotes');
    component.switchSubTab('reps');
    expect(component.currentSubTab()).toBe('reps');
    component.switchSubTab('analytics');
    expect(component.currentSubTab()).toBe('analytics');
  });

  it('devrait recharger les analyses lors du changement de période', () => {
    component.selectPeriod('quarter');
    expect(component.currentPeriod()).toBe('quarter');
    expect(component.selectedDate()).toBeNull();
    expect(mockLoadTimingAnalytics).toHaveBeenCalledWith({
      period: 'quarter',
      date: null,
      repId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 5 : POPOVER CALENDRIER ET SÉLECTION DE JOUR
  // -------------------------------------------------------------------------
  it('devrait ouvrir, fermer le popover calendrier et filtrer par jour', () => {
    expect(component.isCalendarOpen()).toBe(false);

    const dummyEvent = new MouseEvent('click');
    component.toggleCalendarPopover(dummyEvent);
    expect(component.isCalendarOpen()).toBe(true);

    component.selectDate('2026-10-18', '18 Octobre 2026');
    expect(component.selectedDate()).toBe('2026-10-18');
    expect(component.selectedDateLabel()).toBe('18 Octobre 2026');
    expect(component.currentPeriod()).toBe('day');
    expect(component.isCalendarOpen()).toBe(false);

    expect(mockLoadTimingAnalytics).toHaveBeenCalledWith({
      period: 'day',
      date: '2026-10-18',
      repId: undefined,
    });
  });

  // -------------------------------------------------------------------------
  // SECTION 6 : FILTRAGE MULTI-CRITÈRES DES COTATIONS
  // -------------------------------------------------------------------------
  it('devrait filtrer les cotations par terme de recherche textuel', () => {
    component.searchQuery.set('SOCAPALM');
    expect(component.filteredQuotes().length).toBe(1);
    expect(component.filteredQuotes()[0].quoteNumber).toBe('COT-2026-001');

    component.searchQuery.set('INTACTROUVABLE');
    expect(component.filteredQuotes().length).toBe(0);
  });

  it('devrait filtrer les cotations par statut de SLA', () => {
    component.selectedSlaFilter.set('overdue');
    expect(component.filteredQuotes().length).toBe(1);
    expect(component.filteredQuotes()[0].quoteNumber).toBe('COT-2026-002');

    component.selectedSlaFilter.set('compliant');
    expect(component.filteredQuotes().length).toBe(1);
    expect(component.filteredQuotes()[0].quoteNumber).toBe('COT-2026-001');
  });

  // -------------------------------------------------------------------------
  // SECTION 7 : MODALE DE TIMELINE & DÉTAILS
  // -------------------------------------------------------------------------
  it('devrait ouvrir et fermer la modale chronologique pour une cotation', () => {
    expect(component.activeTimelineQuote()).toBeNull();

    component.openTimelineModal(MOCK_QUOTE_ITEM);
    expect(component.activeTimelineQuote()?.id).toBe('quote-1');

    component.closeTimelineModal();
    expect(component.activeTimelineQuote()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // SECTION 8 : GESTION DES CAS LIMITES (LISTE VIDE ET ERREUR)
  // -------------------------------------------------------------------------
  it('devrait gérer convenablement l’état avec liste vide', () => {
    mockTimingAnalyticsSignal.set({
      kpis: {
        avgDelayFormatted: '—',
        avgDelayMinutes: 0,
        slaComplianceRateFormatted: '100%',
        slaCompliancePercent: 100,
        inProgressCount: 0,
        overdueCount: 0,
        totalAmount: 0,
        totalAmountFormatted: '0 FCFA',
        conversionRateFormatted: '0%',
        conversionPercent: 0,
      },
      quotes: [],
      reps: [],
      totalCount: 0,
    });
    fixture.detectChanges();

    expect(component.allQuotes().length).toBe(0);
    expect(component.filteredQuotes().length).toBe(0);
  });

  it('devrait propager les erreurs signalées par le service', () => {
    mockErrorSignal.set('Erreur réseau de communication avec le serveur');
    fixture.detectChanges();

    expect(component.error()).toBe('Erreur réseau de communication avec le serveur');
  });
});

