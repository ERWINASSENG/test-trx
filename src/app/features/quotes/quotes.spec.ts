import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { QuoteService } from '../../core/services/quote.service';
import { QuoteAssignee, QuoteTemplate, SalesQuote } from '../../core/models/quote.model';
import { Prospect } from '../../core/models/prospect.model';
import { ActivatedRoute } from '@angular/router';
import { QuotesComponent } from './quotes';

describe('QuotesComponent (Fiche de cotation maritime Transimex)', () => {
  let component: QuotesComponent;
  let fixture: ComponentFixture<QuotesComponent>;

  const mockQuotes = signal<SalesQuote[]>([]);
  const mockProspects = signal<Prospect[]>([]);
  const mockAssignees = signal<QuoteAssignee[]>([]);
  const mockTemplates = signal<QuoteTemplate[]>([]);
  const mockLoading = signal<boolean>(false);
  const mockError = signal<string | null>(null);
  const mockRoute = { snapshot: { queryParamMap: { get: vi.fn().mockReturnValue(null) } } };

  const mockQuoteService = {
    quotes: mockQuotes,
    prospects: mockProspects,
    assignees: mockAssignees,
    templates: mockTemplates,
    isLoading: mockLoading,
    error: mockError,
    loadQuotes: vi.fn().mockResolvedValue(true),
    loadProspects: vi.fn().mockResolvedValue(true),
    loadAssignees: vi.fn().mockResolvedValue(true),
    loadTemplates: vi.fn().mockResolvedValue(true),
    createQuote: vi.fn().mockResolvedValue({ success: true, data: { id: 'created-quote-1' } }),
    updateQuote: vi.fn().mockResolvedValue({ success: true, data: { id: 'updated-quote-1' } }),
    deleteQuote: vi.fn().mockResolvedValue({ success: true, data: { deleted: true } }),
    createProspect: vi.fn().mockResolvedValue({
      success: true,
      data: {
        id: 'new-prospect-123',
        name: 'Société Nouvelle SARL',
        companyName: 'Société Nouvelle SARL',
      },
    }),
    createTemplate: vi.fn().mockResolvedValue({ success: true }),
    deleteTemplate: vi.fn().mockResolvedValue({ success: true }),
  };

  const mockAccessControl = {
    hasPermission: vi.fn(() => {
      // Toutes les permissions cotation autorisées pour les tests
      return true;
    }),
  };

  const mockAuthService = {
    currentUser: signal({
      id: 'usr-agent-01',
      email: 'agent@transimex-cm.com',
      firstName: 'Alberic',
      lastName: 'Asseng',
      role: 'commercial',
    }),
  };

  beforeEach(async () => {
    mockRoute.snapshot.queryParamMap.get.mockReturnValue(null);
    mockQuotes.set([]);
    mockProspects.set([
      {
        id: 'prospect-abc',
        name: 'Cameroun Trading SA',
        companyName: 'Cameroun Trading SA',
        contactName: 'M. Jean Nono',
        phone: '+237 699 00 11 22',
        email: 'trading@camnet.cm',
        status: 'qualified',
        currency: 'XAF',
        notes: '',
        createdBy: null,
        assignedTo: 'usr-agent-01',
        estimatedValue: 15000000,
        source: 'Salon',
        nextFollowUp: null,
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ]);
    mockAssignees.set([
      { id: 'usr-agent-01', firstName: 'Alberic', lastName: 'Asseng', email: 'agent@transimex-cm.com' },
    ]);

    await TestBed.configureTestingModule({
      imports: [QuotesComponent],
      providers: [
        { provide: QuoteService, useValue: mockQuoteService },
        { provide: AccessControlService, useValue: mockAccessControl },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ActivatedRoute, useValue: mockRoute },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QuotesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('devrait instancier le composant QuotesComponent et initialiser la vue liste', () => {
    expect(component).toBeTruthy();
    expect(component.view()).toBe('list');
    expect(component.isEditorOpen()).toBe(false);
  });

  it('filtre la liste sur la référence transmise par le CRM', async () => {
    fixture.destroy();
    mockRoute.snapshot.queryParamMap.get.mockReturnValue('COT-2026-000001');
    fixture = TestBed.createComponent(QuotesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    expect(component.quoteSearch()).toBe('COT-2026-000001');
  });

  it('devrait ouvrir une fiche vierge avec toutes les cases décochées par défaut', () => {
    component.openCreate();
    fixture.detectChanges();

    expect(component.isEditorOpen()).toBe(true);
    expect(component.editingId()).toBeNull();
    expect(component.title()).toBe('Cotation Fret Maritime Transimex');
    expect(component.currency()).toBe('XAF');
    expect(component.seaPortOfLoading()).toBe('Douala Port (CMDLA)');
    expect(component.seaIncoterm()).toBe('FOB');
    expect(component.seaNeedInlandTransport()).toBe(false);
    expect(component.serviceFcl()).toBe(false);
    expect(component.serviceLcl()).toBe(false);
    expect(component.serviceRoro()).toBe(false);
    expect(component.serviceBreakBulk()).toBe(false);
    expect(component.docCommercialInvoice()).toBe(false);
    expect(component.docPackingList()).toBe(false);
    expect(component.docCertificateOfOrigin()).toBe(false);
    expect(component.docMsdsTechnicalSheet()).toBe(false);
    expect(component.addonCustomsClearance()).toBe(false);
    expect(component.addonCargoInsurance()).toBe(false);
    expect(component.addonWarehousing()).toBe(false);
    expect(component.addonPortHandling()).toBe(false);
    expect(component.addonTracking()).toBe(false);
    expect(component.saveTemplate()).toBe(false);
    expect(component.columns().length).toBeGreaterThanOrEqual(3);
  });

  it('devrait pré-remplir les coordonnées de contact lors de la sélection d’un client existant', () => {
    component.openCreate();
    component.onProspectSelected('prospect-abc');

    expect(component.prospectId()).toBe('prospect-abc');
    expect(component.clientSearch()).toBe('Cameroun Trading SA');
    expect(component.seaContactName()).toBe('M. Jean Nono');
    expect(component.seaPhone()).toBe('+237 699 00 11 22');
    expect(component.seaEmail()).toBe('trading@camnet.cm');
  });

  it('devrait calculer dynamiquement le montant total de la cotation à partir des lignes chiffrées', () => {
    component.openCreate();
    const totalColId = component.totalColumnId();
    expect(totalColId).toBeTruthy();

    // Modification des lignes de chiffrage
    const cols = component.columns();
    const designationCol = cols[0];
    const unitCol = cols[1];
    const amountCol = cols.find((c) => c.type === 'amount')!;

    component.rows.set([
      { [designationCol.id]: 'Fret maritime 40ft', [unitCol.id]: '1 conteneur', [amountCol.id]: 2500000 },
      { [designationCol.id]: 'Manutention portuaire', [unitCol.id]: 'Forfait', [amountCol.id]: 350000 },
    ]);

    expect(component.draftTotal()).toBe(2850000);
    expect(component.formatAmount(component.draftTotal(), 'XAF')).toContain('2 850 000');
  });

  it('devrait construire le payload complet seaFreight et appeler createQuote lors de l’enregistrement', async () => {
    component.openCreate();
    component.onProspectSelected('prospect-abc');

    // Saisie des détails d'expédition et d'itinéraire
    component.seaGoodsType.set('Produits agricoles');
    component.seaGoodsDescription.set('Cacao en sacs');
    component.seaGrossWeightKg.set(24000);
    component.seaTotalVolumeM3.set(65.5);
    component.seaPackagesCount.set(350);
    component.seaPackagingType.set('Sacs en jute');
    component.seaPortOfLoading.set('Douala Port');
    component.seaPortOfDischarge.set('Anvers');
    component.seaIncoterm.set('CIF');

    // Chiffrage
    const amountCol = component.columns().find((c) => c.type === 'amount')!;
    component.rows.set([
      { [component.columns()[0].id]: 'Fret maritime', [amountCol.id]: 1800000 },
    ]);

    await component.saveQuote();

    expect(mockQuoteService.createQuote).toHaveBeenCalledTimes(1);
    const passedInput = mockQuoteService.createQuote.mock.calls[0][0];
    expect(passedInput.prospectId).toBe('prospect-abc');
    expect(passedInput.seaFreight).toBeDefined();
    expect(passedInput.seaFreight.goodsType).toBe('Produits agricoles');
    expect(passedInput.seaFreight.grossWeightKg).toBe(24000);
    expect(passedInput.seaFreight.portOfLoading).toBe('Douala Port');
    expect(passedInput.seaFreight.portOfDischarge).toBe('Anvers');
    expect(passedInput.seaFreight.incoterm).toBe('CIF');
    expect(passedInput.seaFreight.serviceTypes.fcl).toBe(true);
    expect(component.isEditorOpen()).toBe(false);
  });

  it('devrait afficher une erreur si l’utilisateur tente d’enregistrer sans sélectionner ou créer de client', async () => {
    component.openCreate();
    component.clientSearch.set('');
    component.prospectId.set('');

    await component.saveQuote();

    expect(mockQuoteService.createQuote).not.toHaveBeenCalled();
    expect(component.error()).toContain('nom de la société cliente');
    expect(component.isEditorOpen()).toBe(true);
  });
});
