import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { AccessControlService } from '../../core/services/access-control.service';
import { QuoteService } from '../../core/services/quote.service';
import { SalesQuote } from '../../core/models/quote.model';
import { QuotesComponent } from './quotes';

describe('QuotesComponent', () => {
  let fixture: ComponentFixture<QuotesComponent>;

  const quotes: SalesQuote[] = [
    {
      id: 'quote-1',
      quoteNumber: 'COT-001',
      prospectId: 'prospect-1',
      prospectName: 'Client Alpha',
      assignedTo: null,
      assignedToName: null,
      createdBy: null,
      title: 'Équipement de bureau',
      currency: 'XAF',
      columns: [],
      rows: [],
      totalColumnId: '',
      totalAmount: 125000,
      status: 'sent',
      validUntil: null,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'quote-2',
      quoteNumber: 'COT-002',
      prospectId: 'prospect-2',
      prospectName: 'Client Beta',
      assignedTo: null,
      assignedToName: null,
      createdBy: null,
      title: 'Maintenance annuelle',
      currency: 'XAF',
      columns: [],
      rows: [],
      totalColumnId: '',
      totalAmount: 85000,
      status: 'accepted',
      validUntil: null,
      createdAt: '',
      updatedAt: '',
    },
  ];

  const quoteService = {
    quotes: signal(quotes),
    prospects: signal([]),
    assignees: signal([]),
    templates: signal([]),
    isLoading: signal(false),
    error: signal(null),
    loadQuotes: vi.fn().mockResolvedValue(true),
    loadProspects: vi.fn().mockResolvedValue(true),
    loadTemplates: vi.fn().mockResolvedValue(true),
    loadAssignees: vi.fn().mockResolvedValue(true),
  };

  const accessControl = {
    hasPermission: vi.fn(() => false),
  };

  const authService = {
    currentUser: signal(null),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QuotesComponent],
      providers: [
        { provide: QuoteService, useValue: quoteService },
        { provide: AccessControlService, useValue: accessControl },
        { provide: AuthService, useValue: authService },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(QuotesComponent);
    fixture.detectChanges();
  });

  it('affiche la liste par défaut et permet de passer en vue Kanban puis de revenir à la liste', () => {
    expect(fixture.nativeElement.querySelector('.quotes-table')).not.toBeNull();

    fixture.nativeElement.querySelector('[aria-label="Vue Kanban"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.quotes-table')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.quotes-kanban-column').length).toBe(5);
    expect(fixture.nativeElement.querySelectorAll('.quote-kanban-card').length).toBe(2);

    fixture.nativeElement.querySelector('[aria-label="Vue liste"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.quotes-table')).not.toBeNull();
  });

  it('groupe les cotations dans les colonnes correspondant à leur statut', () => {
    const component = fixture.componentInstance;

    expect(component.statusColumns().find((column) => column.status === 'sent')?.quotes.map((quote) => quote.quoteNumber))
      .toEqual(['COT-001']);
    expect(component.statusColumns().find((column) => column.status === 'accepted')?.quotes.map((quote) => quote.quoteNumber))
      .toEqual(['COT-002']);
  });
});
