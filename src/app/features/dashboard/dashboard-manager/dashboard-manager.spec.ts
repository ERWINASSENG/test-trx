import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { DashboardManager } from './dashboard-manager';
import { AuthService } from '../../../core/services/auth.service';
import { CashierService } from '../../../core/services/cashier.service';
import { UserProfile } from '../../../core/models/auth.model';
import { CashierTransaction } from '../../../core/models/cashier-transaction.model';

describe('DashboardManager', () => {
  let component: DashboardManager;
  let fixture: ComponentFixture<DashboardManager>;

  const mockManagerUser: UserProfile = {
    id: 'manager-1',
    email: 'manager@transimex.cm',
    firstName: 'Paul',
    lastName: 'Ewane',
    role: 'manager',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const mockTransactions: CashierTransaction[] = [
    {
      id: 'tx-1',
      date: '2026-03-01',
      libelle: 'Approvisionnement caisse',
      service: 'DG',
      typeDescription: 'Dotation',
      category: 'entree',
      firstName: 'Jean',
      quantity: 1,
      montant: 500000,
    },
    {
      id: 'tx-2',
      date: '2026-03-02',
      libelle: 'Carburant transport',
      service: 'TRANSPORT',
      typeDescription: 'Camion 01',
      category: 'sortie',
      firstName: 'Paul',
      quantity: 1,
      montant: -50000,
    },
  ];

  const currentUserSignal = signal<UserProfile | null>(mockManagerUser);
  const transactionsSignal = signal<CashierTransaction[]>(mockTransactions);
  const balanceSignal = signal<number>(450000);

  const authServiceMock = {
    currentUser: currentUserSignal,
  };

  const cashierServiceMock = {
    allTransactions: transactionsSignal,
    currentBalance: balanceSignal,
    loadTransactions: () => Promise.resolve(),
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardManager],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
        { provide: CashierService, useValue: cashierServiceMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardManager);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create dashboard manager component', () => {
    expect(component).toBeTruthy();
  });

  it('should format currency correctly in FCFA', () => {
    expect(component.formatCurrency(450000)).toContain('450');
    expect(component.formatCurrency(450000)).toContain('FCFA');
  });

  it('should compute chart timeline data correctly from transactions', () => {
    const data = component.chartData();
    expect(data.labels.length).toBe(2);
    expect(data.balances.length).toBe(2);
    expect(data.balances[0]).toBe(500000);
    expect(data.balances[1]).toBe(450000);
    expect(data.descriptions[0]).toBe('Approvisionnement caisse');
  });

  it('should handle empty transactions gracefully with default chart data', () => {
    transactionsSignal.set([]);
    fixture.detectChanges();

    const data = component.chartData();
    expect(data.labels).toEqual(['Départ', 'Aujourd’hui']);
    expect(data.balances).toEqual([0, 0]);

    // Restore transactions
    transactionsSignal.set(mockTransactions);
  });

  it('should handle dates formatted as DD/MM/YYYY in transaction sorting', () => {
    transactionsSignal.set([
      {
        id: 'tx-old',
        date: '05/03/2026',
        libelle: 'Opération 2',
        service: 'DG',
        typeDescription: 'Test',
        category: 'sortie',
        firstName: 'Jean',
        quantity: 1,
        montant: -20000,
      },
      {
        id: 'tx-first',
        date: '01/03/2026',
        libelle: 'Opération 1',
        service: 'DG',
        typeDescription: 'Test',
        category: 'entree',
        firstName: 'Jean',
        quantity: 1,
        montant: 100000,
      },
    ]);
    fixture.detectChanges();

    const data = component.chartData();
    expect(data.balances[0]).toBe(100000);
    expect(data.balances[1]).toBe(80000);

    // Restore
    transactionsSignal.set(mockTransactions);
  });

  it('should process same-day transactions with entree before sortie so chart starts positive', () => {
    transactionsSignal.set([
      {
        id: 'tx-depense',
        date: '13/09/2026',
        libelle: 'Carburant et frais',
        service: 'DG',
        typeDescription: 'Dépense',
        category: 'sortie',
        firstName: 'Paul',
        quantity: 1,
        montant: -457892,
      },
      {
        id: 'tx-dotation',
        date: '13/09/2026',
        libelle: 'Dotation initiale',
        service: 'DG',
        typeDescription: 'Approvisionnement',
        category: 'entree',
        firstName: 'Paul',
        quantity: 1,
        montant: 500000,
      },
    ]);
    fixture.detectChanges();

    const data = component.chartData();
    expect(data.balances[0]).toBe(500000);
    expect(data.balances[1]).toBe(42108);

    // Restore
    transactionsSignal.set(mockTransactions);
  });

  it('should clean up chart instance on destroy without throwing', () => {
    expect(() => component.ngOnDestroy()).not.toThrow();
  });
});



