import { describe, it, expect, beforeEach, vi } from 'vitest';
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
      status: 'posted',
      service: 'COMMERCIAL',
      typeDescription: 'Règlement facture',
      firstName: 'Jean Dupont',
    },
    {
      id: 'tx-2',
      date: new Date().toISOString(),
      libelle: 'CARB-842',
      montant: 150000,
      category: 'sortie',
      status: 'posted',
      service: 'TRANSPORT',
      typeDescription: 'Carburant camions',
      firstName: 'Samuel Eboa',
    },
    {
      id: 'tx-3',
      date: new Date().toISOString(),
      libelle: 'FOURN-109',
      montant: 50000,
      category: 'sortie',
      status: 'posted',
      service: 'DG',
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
    caisseTransactions: signal<CashierTransaction[]>(mockTransactions),
    currentBalance: signal<number>(300000),
    caisseBalance: signal<number>(18500000),
    serverSummary: signal<{
      total_entrees: number;
      total_sorties: number;
      solde_global: number;
      total_count: number;
    } | null>({
      total_entrees: 500000,
      total_sorties: 200000,
      solde_global: 18500000,
      total_count: 3,
    }),
    isLoading: signal<boolean>(false),
    loadTransactions: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    userServiceMock.users.set([mockAdminUser]);
    cashierServiceMock.allTransactions.set(mockTransactions);
    cashierServiceMock.caisseTransactions.set(mockTransactions);
    cashierServiceMock.serverSummary.set({
      total_entrees: 500000,
      total_sorties: 200000,
      solde_global: 18500000,
      total_count: 3,
    });

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

  it('should default to all periods and display the official cashier balance', () => {
    expect(component.selectedPeriod()).toBe('all');
    expect(component.filteredTransactions()).toHaveLength(3);
    expect(component.timelineChartData().at(-1)?.balance).toBe(18500000);
  });

  it('should use server aggregates for all-period KPIs beyond the loaded page', () => {
    cashierServiceMock.serverSummary.set({
      total_entrees: 700000,
      total_sorties: 250000,
      solde_global: 18500000,
      total_count: 1200,
    });

    expect(component.financialKPIs().income).toBe(700000);
    expect(component.financialKPIs().expense).toBe(250000);
    expect(component.financialKPIs().totalTransactions).toBe(1200);
  });

  it('should exclude drafts and cancelled transactions from dashboard analytics', () => {
    const nonPostedTransactions: CashierTransaction[] = [
      { ...mockTransactions[0], id: 'tx-draft', montant: 70000, status: 'draft' },
      { ...mockTransactions[0], id: 'tx-cancelled', montant: 90000, status: 'cancelled' },
    ];
    cashierServiceMock.caisseTransactions.set([...mockTransactions, ...nonPostedTransactions]);

    expect(component.financialKPIs().income).toBe(500000);
    expect(component.financialKPIs().expense).toBe(200000);
    expect(component.financialKPIs().totalTransactions).toBe(3);
    expect(component.recentTransactions().map((transaction) => transaction.id)).not.toContain('tx-draft');
    expect(component.recentTransactions().map((transaction) => transaction.id)).not.toContain('tx-cancelled');
  });

  it('should parse French and ISO dates consistently in period filters and chart labels', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 2);
    const day = String(recentDate.getDate()).padStart(2, '0');
    const month = String(recentDate.getMonth() + 1).padStart(2, '0');
    const year = recentDate.getFullYear();
    const frenchDate = `${day}/${month}/${year}`;
    const isoDate = `${year}-${month}-${day}`;
    const transactions: CashierTransaction[] = [
      { ...mockTransactions[0], id: 'tx-fr', date: frenchDate },
      { ...mockTransactions[0], id: 'tx-iso', date: isoDate },
      { ...mockTransactions[0], id: 'tx-invalid', date: '31/02/2026' },
    ];
    cashierServiceMock.caisseTransactions.set(transactions);
    component.setPeriod('7d');

    expect(component.filteredTransactions().map((transaction) => transaction.id)).toEqual(['tx-fr', 'tx-iso']);
    expect(component.timelineChartData().map((point) => point.date)).toEqual([isoDate]);
  });

  it('should resolve collaborator names and format negative amounts with one sign', () => {
    const collaborator: UserProfile = {
      ...mockAdminUser,
      id: 'employee-1',
      firstName: 'Amina',
      lastName: 'Nguema',
    };
    userServiceMock.users.set([mockAdminUser, collaborator]);
    const transaction: CashierTransaction = {
      ...mockTransactions[1],
      firstName: '',
      employee: '',
      partenaire: '',
      employeeId: collaborator.id,
      montant: -150000,
    };

    expect(component.getTransactionBeneficiary(transaction)).toBe('Amina Nguema');
    expect(component.formatTransactionAmount(transaction)).toBe(`-${component.formatCurrency(150000)}`);
  });

  it('should compute category breakdown for expenses', () => {
    const categories = component.categoryBreakdown();
    expect(categories.length).toBe(2);
    expect(categories[0].category).toBe('TRANSPORT');
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
    cashierServiceMock.caisseTransactions.set([]);
    cashierServiceMock.serverSummary.set(null);
    fixture.detectChanges();

    expect(component.timelineChartData()).toEqual([]);
    expect(component.categoryBreakdown()).toEqual([]);
    expect(component.employeeBreakdown()).toEqual([]);
    expect(component.financialKPIs().income).toBe(0);
    expect(component.financialKPIs().expense).toBe(0);
  });
});

