import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { DashboardCommercial } from './dashboard-commercial';
import { CrmService } from '../../../core/services/crm.service';
import { QuoteService } from '../../../core/services/quote.service';
import { DossierService } from '../../../core/services/dossier.service';
import { ProspectService } from '../../../core/services/prospect.service';
import { CrmActivity, CrmClient, CrmOpportunity } from '../../../core/models/crm.model';
import { SalesQuote } from '../../../core/models/quote.model';

describe('DashboardCommercial', () => {
  let component: DashboardCommercial;
  let fixture: ComponentFixture<DashboardCommercial>;

  const mockClient1: CrmClient = {
    id: 'p-1',
    name: 'Société Minière du Cameroun',
    companyName: 'Société Minière du Cameroun',
    contactName: 'Alain Mballa',
    contactRole: 'Directeur',
    email: 'a.mballa@smc.cm',
    phone: '+237699123456',
    country: 'Cameroun',
    sector: 'Mines',
    status: 'qualified',
    assignedTo: 'user-1',
  };

  const mockClient2: CrmClient = {
    id: 'p-2',
    name: 'CFAO Cameroun',
    companyName: 'CFAO Cameroun',
    contactName: 'Jean Nkou',
    contactRole: 'Responsable',
    email: 'j.nkou@cfao.cm',
    phone: '+237690123456',
    country: 'Cameroun',
    sector: 'Automobile',
    status: 'converted',
    assignedTo: 'user-1',
  };

  const mockOpportunities: CrmOpportunity[] = [
    {
      id: 'opp-1',
      prospectId: 'p-1',
      assignedTo: 'user-1',
      assignedToName: 'Commercial Test',
      title: 'Import Minier',
      stage: 'negotiation',
      transportMode: 'sea',
      direction: 'import',
      origin: 'Anvers',
      destination: 'Douala',
      goodsDescription: 'Engins',
      weightKg: 5000,
      volumeM3: 40,
      incoterm: 'CIF',
      estimatedValue: 125000000,
      currency: 'XAF',
      expectedCloseDate: '2026-10-30',
      wonReason: null,
      contractReference: null,
      notes: null,
      client: mockClient1,
      contacts: [],
      quoteId: null,
      quoteNumber: null,
      quoteStatus: null,
      dossierNumber: null,
      dossierId: null,
    },
    {
      id: 'opp-2',
      prospectId: 'p-2',
      assignedTo: 'user-1',
      assignedToName: 'Commercial Test',
      title: 'Fret Aérien Express',
      stage: 'won',
      transportMode: 'air',
      direction: 'import',
      origin: 'Paris',
      destination: 'Douala',
      goodsDescription: 'Pièces',
      weightKg: 200,
      volumeM3: 2,
      incoterm: 'FOB',
      estimatedValue: 62000000,
      currency: 'XAF',
      expectedCloseDate: '2026-10-25',
      wonReason: 'accepted_quote',
      contractReference: 'CTR-001',
      notes: null,
      client: mockClient2,
      contacts: [],
      quoteId: null,
      quoteNumber: null,
      quoteStatus: null,
      dossierNumber: null,
      dossierId: null,
    },
  ];

  const mockClients: CrmClient[] = [mockClient1, mockClient2];

  const mockQuotes: SalesQuote[] = [
    {
      id: 'q-1',
      quoteNumber: 'COT-2026-0000001',
      prospectId: 'p-1',
      opportunityId: 'opp-1',
      assignedTo: 'user-1',
      prospectName: 'Société Minière du Cameroun',
      assignedToName: 'Commercial Test',
      createdBy: 'user-1',
      title: 'Offre Minier',
      currency: 'XAF',
      columns: [],
      rows: [],
      totalColumnId: 'amount',
      totalAmount: 125000000,
      status: 'sent',
      validUntil: '2026-11-15',
      seaFreight: { portOfLoading: 'Anvers', portOfDischarge: 'Douala Port' },
      createdAt: '2026-10-12T10:00:00Z',
      updatedAt: '2026-10-12T10:00:00Z',
    },
  ];

  const mockActivities: CrmActivity[] = [
    {
      id: 'act-1',
      prospectId: 'p-1',
      opportunityId: 'opp-1',
      contactId: null,
      assignedTo: 'user-1',
      activityType: 'call',
      title: 'Appel client - SMC',
      dueAt: new Date(Date.now() + 3600 * 1000 * 12).toISOString(),
      status: 'pending',
      notes: 'Relance offre',
      clientName: 'Société Minière du Cameroun',
      contactName: 'Alain Mballa',
    },
  ];

  const crmServiceMock = {
    opportunities: signal(mockOpportunities),
    clients: signal(mockClients),
    activities: signal(mockActivities),
    load: vi.fn().mockResolvedValue(true),
    updateActivityStatus: vi.fn().mockResolvedValue({ success: true }),
  };

  const quoteServiceMock = {
    quotes: signal(mockQuotes),
    loadQuotes: vi.fn().mockResolvedValue(true),
  };

  const dossierServiceMock = {
    total: signal(1),
    loadDossiers: vi.fn().mockResolvedValue(true),
  };

  const prospectServiceMock = {
    total: signal(2),
    loadProspects: vi.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [DashboardCommercial],
      providers: [
        provideRouter([]),
        { provide: CrmService, useValue: crmServiceMock },
        { provide: QuoteService, useValue: quoteServiceMock },
        { provide: DossierService, useValue: dossierServiceMock },
        { provide: ProspectService, useValue: prospectServiceMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardCommercial);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('devrait instancier le composant DashboardCommercial', () => {
    expect(component).toBeTruthy();
  });

  it('devrait charger les données du CRM et des cotations lors de ngOnInit', () => {
    expect(crmServiceMock.load).toHaveBeenCalled();
    expect(quoteServiceMock.loadQuotes).toHaveBeenCalled();
    expect(dossierServiceMock.loadDossiers).toHaveBeenCalled();
    expect(prospectServiceMock.loadProspects).toHaveBeenCalled();
  });

  it('devrait calculer le chiffre d\'affaires prévisionnel à partir de la base', () => {
    expect(component.totalPipelineAmount()).toBe(187000000);
    expect(component.formatMillions(187000000)).toBe('187 M');
  });

  it('devrait calculer le nombre d\'opportunités et de devis en cours', () => {
    expect(component.activeOpportunitiesCount()).toBe(2);
    expect(component.activeQuotesCount()).toBe(1);
  });

  it('devrait calculer le taux de conversion parmi les opportunités clôturées', () => {
    expect(component.conversionRate()).toBe(100);
  });

  it('devrait exposer les paliers de l\'entonnoir des ventes', () => {
    const stages = component.funnelStages();
    expect(stages.length).toBe(6);
    expect(stages[0].label).toBe('Prospects');
    expect(stages[0].count).toBe(2);
    expect(stages[4].label).toBe('Dossiers');
    expect(stages[4].count).toBe(1);
  });

  it('devrait afficher les tâches et permettre de les marquer comme terminées', async () => {
    const tasks = component.pendingActivities();
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe('Appel client - SMC');

    await component.completeTask('act-1');
    expect(crmServiceMock.updateActivityStatus).toHaveBeenCalledWith('act-1', 'completed');
  });
});
