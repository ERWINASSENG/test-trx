import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { DashboardAdmin } from './dashboard-admin';
import { AuthService } from '../../../core/services/auth.service';
import { UserService } from '../../../core/services/user.service';
import { CashierService } from '../../../core/services/cashier.service';
import { UserProfile } from '../../../core/models/auth.model';
import { CashierTransaction } from '../../../core/models/cashier-transaction.model';

describe('DashboardAdmin', () => {
  let component: DashboardAdmin;
  let fixture: ComponentFixture<DashboardAdmin>;

  const mockAdminUser: UserProfile = {
    id: 'admin-1',
    email: 'admin@transimex.cm',
    firstName: 'Directeur',
    lastName: 'Général',
    role: 'admin',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const mockTransactions: CashierTransaction[] = [
    {
      id: 'tx-1',
      date: new Date().toISOString(),
      libelle: 'FA-2026-001',
      montant: 500000,
      category: 'entree',
      typeTransaction: 'Encaissement Client',
      typeDescription: 'Règlement facture',
      firstName: 'Jean Dupont',
    },
    {
      id: 'tx-2',
      date: new Date().toISOString(),
      libelle: 'CARB-842',
      montant: 150000,
      category: 'sortie',
      typeTransaction: 'Carburant Flotte',
      typeDescription: 'Carburant camions',
      firstName: 'Samuel Eboa',
    },
    {
      id: 'tx-3',
      date: new Date().toISOString(),
      libelle: 'FOURN-109',
      montant: 50000,
      category: 'sortie',
      typeTransaction: 'Fournitures Bureau',
      typeDescription: 'Papeterie',
      firstName: 'Samuel Eboa',
    },
  ];

  const authServiceMock = {
    currentUser: signal(mockAdminUser),
    isAdmin: signal(true),
  };

  const userServiceMock = {
    users: signal([mockAdminUser]),
    totalUsersCount: signal(1),
    activeUsersCount: signal(1),
  };

  const cashierServiceMock = {
    allTransactions: signal<CashierTransaction[]>(mockTransactions),
    currentBalance: signal<number>(18500000),
    isLoading: signal<boolean>(false),
    loadTransactions: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardAdmin],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
        { provide: UserService, useValue: userServiceMock },
        { provide: CashierService, useValue: cashierServiceMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardAdmin);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create dashboard admin component', () => {
    expect(component).toBeTruthy();
  });

  it('should load cashier transactions on init', () => {
    expect(cashierServiceMock.loadTransactions).toHaveBeenCalled();
  });

  it('should format currency correctly in XAF', () => {
    const formatted = component.formatCurrency(1000000);
    expect(formatted).toContain('1');
    expect(formatted).toContain('000');
  });

  it('should correctly calculate financial KPIs from cashier transactions', () => {
    const kpis = component.financialKPIs();
    expect(kpis.income).toBe(500000);
    expect(kpis.expense).toBe(200000);
    expect(kpis.netBalance).toBe(300000);
    expect(kpis.totalTransactions).toBe(3);
    expect(kpis.globalBalance).toBe(18500000);
  });

  it('should compute category breakdown for expenses', () => {
    const categories = component.categoryBreakdown();
    expect(categories.length).toBe(2);
    expect(categories[0].category).toBe('Carburant Flotte');
    expect(categories[0].amount).toBe(150000);
    expect(categories[0].percentage).toBe(75);
  });

  it('should compute employee cash breakdown correctly', () => {
    const employees = component.employeeBreakdown();
    expect(employees.length).toBe(2);
    const samuel = employees.find((e) => e.name === 'Samuel Eboa');
    expect(samuel).toBeDefined();
    expect(samuel?.totalExpense).toBe(200000);
  });

  it('should filter transactions by period', () => {
    component.setPeriod('7d');
    expect(component.selectedPeriod()).toBe('7d');
    expect(component.filteredTransactions().length).toBeGreaterThanOrEqual(0);

    component.setPeriod('all');
    expect(component.filteredTransactions().length).toBe(3);
  });

  it('should handle empty transaction list gracefully (cas limite)', () => {
    cashierServiceMock.allTransactions.set([]);
    fixture.detectChanges();

    expect(component.timelineChartData()).toEqual([]);
    expect(component.categoryBreakdown()).toEqual([]);
    expect(component.employeeBreakdown()).toEqual([]);
    expect(component.financialKPIs().income).toBe(0);
    expect(component.financialKPIs().expense).toBe(0);
  });
});

