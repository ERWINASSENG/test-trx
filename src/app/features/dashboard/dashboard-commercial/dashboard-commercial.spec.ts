import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardCommercial } from './dashboard-commercial';
import { CrmService } from '../../../core/services/crm.service';
import { QuoteService } from '../../../core/services/quote.service';
import { DossierService } from '../../../core/services/dossier.service';
import { ProspectService } from '../../../core/services/prospect.service';
import { AuthService } from '../../../core/services/auth.service';
import { CrmOpportunity } from '../../../core/models/crm.model';
import { SalesQuote } from '../../../core/models/quote.model';

describe('DashboardCommercial', () => {
  let component: DashboardCommercial;
  let fixture: ComponentFixture<DashboardCommercial>;

  const mockOpportunities = signal<CrmOpportunity[]>([
    {
      id: 'opp-1',
      prospectId: 'prospect-1',
      assignedTo: 'usr-1',
      assignedToName: 'Agent Commercial',
      title: 'Transport maritime conteneurs Douala',
      stage: 'negotiation',
      transportMode: 'sea',
      direction: 'export',
      origin: 'Douala',
      destination: 'Le Havre',
      goodsDescription: 'Cacao en fèves',
      weightKg: 24000,
      volumeM3: 45,
      incoterm: 'FOB',
      estimatedValue: 125_000_000,
      currency: 'XAF',
      expectedCloseDate: '2026-06-18',
      wonReason: null,
      contractReference: null,
    } as unknown as CrmOpportunity,
    {
      id: 'opp-2',
      prospectId: 'prospect-2',
      assignedTo: 'usr-1',
      assignedToName: 'Agent Commercial',
      title: 'Aérien express Douala - Paris',
      stage: 'won',
      transportMode: 'air',
      direction: 'export',
      origin: 'Douala',
      destination: 'Paris CDG',
      goodsDescription: 'Fruits exotiques',
      weightKg: 5000,
      volumeM3: 12,
      incoterm: 'CIF',
      estimatedValue: 62_000_000,
      currency: 'XAF',
      expectedCloseDate: '2026-06-17',
      wonReason: 'accepted_quote',
      contractReference: 'CTR-2026-004',
    } as unknown as CrmOpportunity,
  ]);

  const mockQuotes = signal<SalesQuote[]>([
    {
      id: 'quote-1',
      quoteNumber: 'DEV/2026/00001',
      title: 'Cotation Fret Maritime',
      prospectId: 'prospect-1',
      prospectName: 'Société Minière',
      opportunityId: 'opp-1',
      assignedTo: 'usr-1',
      assignedToName: 'Agent',
      currency: 'XAF',
      totalAmount: 125_000_000,
      columns: [],
      rows: [],
      totalColumnId: 'col-amount',
      status: 'draft',
      validUntil: '2026-07-01',
      notes: null,
      paymentTerms: null,
      createdAt: '2026-06-01T10:00:00Z',
      updatedAt: '2026-06-01T10:00:00Z',
    } as unknown as SalesQuote,
  ]);

  const mockCrmService = {
    opportunities: mockOpportunities,
    clients: signal([]),
    load: vi.fn().mockResolvedValue(true),
  };

  const mockQuoteService = {
    quotes: mockQuotes,
    loadQuotes: vi.fn().mockResolvedValue(true),
  };

  const mockDossierService = {
    dossiers: signal([]),
    total: signal(26),
    loadDossiers: vi.fn().mockResolvedValue(true),
  };

  const mockProspectService = {
    prospects: signal([]),
    total: signal(124),
    loadProspects: vi.fn().mockResolvedValue(true),
  };

  const mockAuthService = {
    currentUser: signal({
      id: 'usr-comm-1',
      email: 'commercial@transimex-cm.com',
      firstName: 'Paul',
      lastName: 'Biya',
      role: 'commercial',
      isActive: true,
      createdAt: '2026-01-01',
    }),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardCommercial],
      providers: [
        provideRouter([]),
        { provide: CrmService, useValue: mockCrmService },
        { provide: QuoteService, useValue: mockQuoteService },
        { provide: DossierService, useValue: mockDossierService },
        { provide: ProspectService, useValue: mockProspectService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardCommercial);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait instancier le composant DashboardCommercial', () => {
    expect(component).toBeTruthy();
  });

  it('devrait calculer correctement les 4 indicateurs KPIs supérieurs', () => {
    // Chiffre d affaires prévisionnel (125M + 62M = 187M)
    expect(component.forecastRevenueFormatted()).toContain('187 M FCFA');

    // Devis en cours (au moins 1 devis draft)
    expect(component.pendingQuotesCount()).toBe(1);

    // Nombre d opportunités
    expect(component.opportunitiesCount()).toBe(2);

    // Taux de conversion (1 won sur 2 opps = 50%)
    expect(component.conversionRate()).toBe(50);
  });

  it('devrait construire les 5 étages de l entonnoir des ventes', () => {
    const steps = component.funnelSteps();
    expect(steps.length).toBe(5);

    expect(steps[0].label).toBe('Prospects');
    expect(steps[0].count).toBe(124);
    expect(steps[0].percent).toBe(100);

    expect(steps[1].label).toBe('Opportunités');
    expect(steps[2].label).toBe('Devis envoyés');
    expect(steps[3].label).toBe('Négociations');
    expect(steps[4].label).toBe('Contrats signés');
  });

  it('devrait permettre de cocher et décocher une tâche de suivi', () => {
    const tasks = component.followUpTasks();
    const firstTask = tasks[0];
    const initialCompleted = firstTask.completed;

    component.toggleTask(firstTask.id);
    const updatedTask = component.followUpTasks().find((t) => t.id === firstTask.id);
    expect(updatedTask?.completed).toBe(!initialCompleted);
  });

  it('devrait ajouter une nouvelle tâche de suivi avec addNewFollowUpTask', () => {
    const initialCount = component.followUpTasks().length;
    component.addNewFollowUpTask();
    expect(component.followUpTasks().length).toBe(initialCount + 1);
  });

  it('devrait formater correctement les montants monétaires en FCFA', () => {
    const formatted = component.formatCurrency(125000000);
    expect(formatted).toContain('125');
  });
});
