import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessControlService } from '../../core/services/access-control.service';
import { AuthService } from '../../core/services/auth.service';
import { QuoteService } from '../../core/services/quote.service';
import { QuoteAssignee, QuoteColumn, QuoteContact, QuoteTemplate, SalesQuote } from '../../core/models/quote.model';
import { Prospect } from '../../core/models/prospect.model';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { QuotesComponent } from './quotes';

describe('QuotesComponent (Fiche de cotation maritime Transimex)', () => {
  let component: QuotesComponent;
  let fixture: ComponentFixture<QuotesComponent>;

  const mockQuotes = signal<SalesQuote[]>([]);
  const mockProspects = signal<Prospect[]>([]);
  const mockContacts = signal<QuoteContact[]>([]);
  const mockAssignees = signal<QuoteAssignee[]>([]);
  const mockTemplates = signal<QuoteTemplate[]>([]);
  const mockLoading = signal<boolean>(false);
  const mockError = signal<string | null>(null);
  const mockRoute = { snapshot: { queryParamMap: { get: vi.fn().mockReturnValue(null) } } };

  const mockQuoteService = {
    quotes: mockQuotes,
    prospects: mockProspects,
    contacts: mockContacts,
    assignees: mockAssignees,
    templates: mockTemplates,
    isLoading: mockLoading,
    error: mockError,
    loadQuotes: vi.fn().mockResolvedValue(true),
    loadProspects: vi.fn().mockResolvedValue(true),
    loadContacts: vi.fn().mockResolvedValue(true),
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
    mockContacts.set([]);
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
        provideRouter([]),
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

  it('prépare une cotation pour la société et l’opportunité passées par le CRM', async () => {
    fixture.destroy();
    mockContacts.set([{
      id: 'contact-crm',
      prospectId: 'prospect-abc',
      fullName: 'Amina Nono',
      jobTitle: 'Achats',
      email: 'amina@example.com',
      phone: '+237 600 00 00 00',
    }]);
    mockRoute.snapshot.queryParamMap.get = vi.fn((key: string) => ({
      prospectId: 'prospect-abc',
      opportunityId: 'opportunity-abc',
      contactId: 'contact-crm',
    }[key] || null));
    fixture = TestBed.createComponent(QuotesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await vi.waitFor(() => expect(component.isEditorOpen()).toBe(true));

    expect(component.error()).toBeNull();
    expect(component.prospectId()).toBe('prospect-abc');
    expect(component.opportunityId()).toBe('opportunity-abc');
    expect(component.contactId()).toBe('contact-crm');
    expect(component.title()).toBe('');
    expect(component.currency()).toBe('');
    expect(component.status()).toBe('draft');
    expect(component.seaContactName()).toBe('Amina Nono');
  });

  it('devrait ouvrir une fiche vierge sans valeurs métier ni choix implicite', () => {
    component.openCreate();
    fixture.detectChanges();

    expect(component.isEditorOpen()).toBe(true);
    expect(component.editingId()).toBeNull();
    expect(component.title()).toBe('');
    expect(component.currency()).toBe('');
    expect(component.prospectId()).toBe('');
    expect(component.contactId()).toBe('');
    expect(component.opportunityId()).toBeNull();
    expect(component.assignedTo()).toBe('');
    expect(component.clientSearch()).toBe('');
    expect(component.validUntil()).toBe('');
    expect(component.seaContactName()).toBe('');
    expect(component.seaPhone()).toBe('');
    expect(component.seaEmail()).toBe('');
    expect(component.seaAddress()).toBe('');
    expect(component.seaGoodsType()).toBe('');
    expect(component.seaGoodsDescription()).toBe('');
    expect(component.seaGrossWeightKg()).toBeNull();
    expect(component.seaTotalVolumeM3()).toBeNull();
    expect(component.seaPackagesCount()).toBeNull();
    expect(component.seaPackagingType()).toBe('');
    expect(component.seaPortOfLoading()).toBe('');
    expect(component.seaPortOfDischarge()).toBe('');
    expect(component.seaIncoterm()).toBe('');
    expect(component.seaNeedInlandTransport()).toBeNull();
    expect(component.seaEstimatedDepartureDate()).toBeNull();
    expect(component.seaEstimatedArrivalDate()).toBeNull();
    expect(component.serviceFcl()).toBe(false);
    expect(component.serviceLcl()).toBe(false);
    expect(component.serviceRoro()).toBe(false);
    expect(component.serviceBreakBulk()).toBe(false);
    expect(component.serviceOther()).toBe('');
    expect(component.docCommercialInvoice()).toBe(false);
    expect(component.docPackingList()).toBe(false);
    expect(component.docCertificateOfOrigin()).toBe(false);
    expect(component.docMsdsTechnicalSheet()).toBe(false);
    expect(component.docOther()).toBe('');
    expect(component.addonCustomsClearance()).toBe(false);
    expect(component.addonCargoInsurance()).toBe(false);
    expect(component.addonWarehousing()).toBe(false);
    expect(component.addonPortHandling()).toBe(false);
    expect(component.addonTracking()).toBe(false);
    expect(component.status()).toBe('draft');
    expect(component.saveTemplate()).toBe(false);
    expect(component.columns().length).toBeGreaterThanOrEqual(3);
    expect(component.rows()).toHaveLength(1);

    const row = component.rows()[0];
    expect(row).not.toHaveProperty('id');
    expect(Object.keys(row).sort()).toEqual(component.columns().map((column) => column.id).sort());
    for (const column of component.columns()) {
      if (column.type === 'amount' || column.type === 'number') {
        expect(row[column.id]).toBeNull();
      } else if (column.type === 'checkbox') {
        expect(row[column.id]).toBe(false);
      } else {
        expect(row[column.id]).toBe('');
      }
    }

    const inlandTransport = fixture.nativeElement.querySelector('#field-inland') as HTMLSelectElement;
    expect(inlandTransport.value).toBe('');
  });

  it('devrait pré-remplir les coordonnées de contact lors de la sélection d’un client existant', async () => {
    component.openCreate();
    await component.onProspectSelected('prospect-abc');

    expect(component.prospectId()).toBe('prospect-abc');
    expect(component.clientSearch()).toBe('Cameroun Trading SA');
    expect(component.seaContactName()).toBe('M. Jean Nono');
    expect(component.seaPhone()).toBe('+237 699 00 11 22');
    expect(component.seaEmail()).toBe('trading@camnet.cm');
  });

  it('associe un contact CRM partagé à la cotation et reprend ses coordonnées', async () => {
    mockContacts.set([{
      id: 'contact-abc',
      prospectId: 'prospect-abc',
      fullName: 'Amina Nono',
      jobTitle: 'Achats',
      email: 'amina@example.com',
      phone: '+237 600 00 00 00',
    }]);
    component.onContactSelected('contact-abc');

    expect(component.contactId()).toBe('contact-abc');
    expect(component.seaContactName()).toBe('Amina Nono');
    expect(component.seaEmail()).toBe('amina@example.com');
    expect(component.seaPhone()).toBe('+237 600 00 00 00');
  });

  it('devrait calculer dynamiquement le montant total de la cotation à partir des lignes chiffrées', () => {
    component.openCreate();
    const totalColId = component.totalColumnId();
    expect(totalColId).toBeTruthy();

    // Modification des lignes de chiffrage
    const cols = component.columns();
    const designationCol = cols[0];
    const unitCol = cols[1];
    const amountCol = cols.find((c) => c.id === totalColId)!;

    component.rows.set([
      { [designationCol.id]: 'Fret maritime 40ft', [unitCol.id]: '1 conteneur', [amountCol.id]: 2500000 },
      { [designationCol.id]: 'Manutention portuaire', [unitCol.id]: 'Forfait', [amountCol.id]: 350000 },
    ]);

    expect(component.draftTotal()).toBe(2850000);
    expect(component.formatAmount(component.draftTotal(), 'XAF')).toContain('2 850 000');
  });

  it('devrait construire le payload complet seaFreight et appeler createQuote lors de l’enregistrement', async () => {
    mockContacts.set([{
      id: 'contact-abc',
      prospectId: 'prospect-abc',
      fullName: 'Amina Nono',
      jobTitle: 'Achats',
      email: 'amina@example.com',
      phone: '+237 600 00 00 00',
    }]);
    component.openCreate();
    await component.onProspectSelected('prospect-abc');
    component.onContactSelected('contact-abc');
    component.assignedTo.set('usr-agent-01');
    component.title.set('Fret maritime - Cacao');
    component.currency.set('xaf');

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
    component.serviceFcl.set(true);

    // Chiffrage
    const totalCol = component.columns().find((column) => column.id === component.totalColumnId())!;
    component.rows.set([
      {
        ...component.rows()[0],
        [component.columns()[0].id]: 'Fret maritime',
        [totalCol.id]: 1800000,
      },
    ]);

    await component.saveQuote();

    expect(mockQuoteService.createQuote).toHaveBeenCalledTimes(1);
    const passedInput = mockQuoteService.createQuote.mock.calls[0][0];
    expect(passedInput.prospectId).toBe('prospect-abc');
    expect(passedInput.contactId).toBe('contact-abc');
    expect(passedInput.title).toBe('Fret maritime - Cacao');
    expect(passedInput.currency).toBe('XAF');
    expect(passedInput.rows).toHaveLength(1);
    expect(passedInput.rows[0]).not.toHaveProperty('id');
    expect(Object.keys(passedInput.rows[0]).sort()).toEqual(
      passedInput.columns.map((column: QuoteColumn) => column.id).sort(),
    );
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
    component.title.set('Cotation maritime');
    component.currency.set('XAF');
    component.clientSearch.set('');
    component.prospectId.set('');

    await component.saveQuote();

    expect(mockQuoteService.createQuote).not.toHaveBeenCalled();
    expect(component.error()).toContain('sélectionner un prospect/client destinataire');
    expect(component.isEditorOpen()).toBe(true);
  });

  it('devrait refuser une devise vide avant tout appel au service', async () => {
    component.openCreate();
    component.title.set('Cotation maritime');
    component.prospectId.set('prospect-abc');
    component.currency.set('');

    await component.saveQuote();

    expect(mockQuoteService.createQuote).not.toHaveBeenCalled();
    expect(component.error()).toContain('code devise de trois lettres');
    expect(component.isEditorOpen()).toBe(true);
  });

  it('devrait conserver le choix « Non » en édition si une ancienne cotation ne précise pas le transport intérieur', () => {
    const quote: SalesQuote = {
      id: 'quote-legacy',
      quoteNumber: 'COT-2026-000002',
      prospectId: 'prospect-abc',
      prospectName: 'Cameroun Trading SA',
      assignedTo: null,
      assignedToName: null,
      createdBy: 'usr-agent-01',
      title: 'Cotation ancienne',
      currency: 'XAF',
      columns: [],
      rows: [],
      totalColumnId: '',
      totalAmount: 0,
      status: 'draft',
      validUntil: null,
      seaFreight: {},
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };

    component.openEdit(quote);
    fixture.detectChanges();

    expect(component.seaNeedInlandTransport()).toBe(false);
    const inlandTransport = fixture.nativeElement.querySelector('#field-inland') as HTMLSelectElement;
    expect(inlandTransport.value).toBe('no');
  });
});
