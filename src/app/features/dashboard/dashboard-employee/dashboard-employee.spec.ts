import '@angular/compiler';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementRef, Injector, runInInjectionContext, signal } from '@angular/core';
import { DashboardEmployee } from './dashboard-employee';
import { AuthService } from '../../../core/services/auth.service';
import { UserProfile } from '../../../core/models/auth.model';
import { CashierService } from '../../../core/services/cashier.service';
import { CashierTransaction } from '../../../core/models/cashier-transaction.model';

describe('DashboardEmployee', () => {
  let component: DashboardEmployee;
  let injector: Injector;

  const mockEmployeeUser: UserProfile = {
    id: 'emp-1',
    email: 'agent@transimex.cm',
    firstName: 'Jean',
    lastName: 'Kamga',
    role: 'employe',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const mockCashierTransactions: CashierTransaction[] = [
    {
      id: 'tx-1',
      pieceComptable: 'CSH1/2026/00001',
      date: '2026-11-01',
      libelle: 'Solde initial transport',
      category: 'entree',
      status: 'posted',
      montant: 1000000,
    },
    {
      id: 'tx-2',
      pieceComptable: 'CSH1/2026/00002',
      date: '2026-11-02',
      libelle: 'Règlement fret transit',
      category: 'entree',
      status: 'posted',
      montant: 600000,
    },
    {
      id: 'tx-3',
      pieceComptable: 'CSH1/2026/00003',
      date: '2026-11-03',
      libelle: 'Encaissement client',
      category: 'entree',
      status: 'posted',
      montant: 650000,
    },
    {
      id: 'tx-4',
      pieceComptable: 'CSH1/2026/00004',
      date: '2026-11-03',
      libelle: 'Frais carburant camion',
      category: 'sortie',
      status: 'posted',
      montant: -400000,
    },
    {
      id: 'tx-5',
      pieceComptable: 'CSH1/2026/00005',
      date: '2026-11-03',
      libelle: 'Opération brouillon',
      category: 'sortie',
      status: 'draft',
      montant: -50000,
    },
  ];

  const authServiceMock = {
    currentUser: signal<UserProfile | null>(mockEmployeeUser),
    token: () => 'mock-jwt-token',
    isAuthenticated: () => true,
    waitForSession: () => Promise.resolve(),
  };

  const cashierServiceMock = {
    currentBalance: signal(1850000),
    caisseTotalSorties: signal(400000),
    caisseTransactions: signal<CashierTransaction[]>(mockCashierTransactions),
    allTransactions: signal(mockCashierTransactions),
    loadTransactions: vi.fn().mockResolvedValue(undefined),
    loadCashierSummary: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authServiceMock.currentUser.set(mockEmployeeUser);
    cashierServiceMock.currentBalance.set(1850000);
    cashierServiceMock.caisseTotalSorties.set(400000);
    cashierServiceMock.caisseTransactions.set(mockCashierTransactions);

    injector = Injector.create({
      providers: [
        { provide: AuthService, useValue: authServiceMock },
        { provide: CashierService, useValue: cashierServiceMock },
        { provide: ElementRef, useValue: new ElementRef({ querySelector: () => null }) },
      ],
    });

    component = runInInjectionContext(injector, () => new DashboardEmployee());
  });

  it('devrait instancier le composant dashboard employee', () => {
    expect(component).toBeTruthy();
  });

  it('devrait récupérer et exposer les informations du collaborateur connecté', () => {
    expect(component.currentUser()).toEqual(mockEmployeeUser);
    expect(component.currentUser()?.firstName).toBe('Jean');
    expect(component.currentUser()?.lastName).toBe('Kamga');
  });

  it('calcule correctement les soldes et montants pour la caissière', () => {
    const cashierUser = { ...mockEmployeeUser, role: 'caissiere' as const };
    authServiceMock.currentUser.set(cashierUser);
    component.selectedDate.set('2026-11-03');
    component.ngOnInit();

    expect(cashierServiceMock.loadTransactions).toHaveBeenCalled();
    expect(cashierServiceMock.loadCashierSummary).toHaveBeenCalled();
    expect(component.isCashier()).toBe(true);

    // Vérifier les 4 montants calculés
    expect(component.soldeVeille()).toBe(1600000);
    expect(component.entreesJour()).toBe(650000);
    expect(component.sortiesJour()).toBe(400000);
    expect(component.soldeCaisse()).toBe(1850000);
    expect(component.entreesLabel()).toBe('Entrées du jour');
    expect(component.sortiesLabel()).toBe('Total Décaissements');
  });

  it('devrait identifier correctement si le rôle est caissière ou non', () => {
    expect(component.isCashier()).toBe(false);

    authServiceMock.currentUser.set({ ...mockEmployeeUser, role: 'caissiere' as const });
    expect(component.isCashier()).toBe(true);
  });

  it('devrait ouvrir et fermer le popover calendrier au clic', () => {
    expect(component.isCalendarOpen()).toBe(false);
    component.toggleCalendar();
    expect(component.isCalendarOpen()).toBe(true);
    component.closeCalendar();
    expect(component.isCalendarOpen()).toBe(false);
  });

  it('devrait permettre de changer la date et recalculer le solde veille et les flux', () => {
    component.selectDate('2026-11-02');
    expect(component.selectedDate()).toBe('2026-11-02');
    expect(component.selectedPeriod()).toBe('day');
    expect(component.isCalendarOpen()).toBe(false);

    // Solde veille au 2 nov = opérations du 1er nov = 1 000 000 FCFA
    expect(component.soldeVeille()).toBe(1000000);
    expect(component.entreesJour()).toBe(600000);
    expect(component.sortiesJour()).toBe(0);
    expect(component.soldeCaisse()).toBe(1600000);

    // Sélection des 7 derniers jours
    component.selectLast7Days();
    expect(component.selectedPeriod()).toBe('7d');
    expect(component.selectedDateLabel()).toBe('7 derniers jours');
    expect(component.entreesLabel()).toBe('Entrées (7 jours)');
    expect(component.sortiesLabel()).toBe('Sorties (7 jours)');
  });

  it('devrait formater correctement les montants monétaires en FCFA', () => {
    expect(component.formatAmount(50000)).toBe('50 000');
    expect(component.formatAmount(0)).toBe('0');
  });

  it('devrait gérer le cas où aucun utilisateur n\'est encore connecté', () => {
    authServiceMock.currentUser.set(null);
    expect(component.currentUser()).toBeNull();
    expect(component.isCashier()).toBe(false);
  });
});
