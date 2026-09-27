import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { DashboardEmployee } from './dashboard-employee';
import { AuthService } from '../../../core/services/auth.service';
import { UserProfile } from '../../../core/models/auth.model';
import { CashierService } from '../../../core/services/cashier.service';

describe('DashboardEmployee', () => {
  let component: DashboardEmployee;
  let fixture: ComponentFixture<DashboardEmployee>;

  const mockEmployeeUser: UserProfile = {
    id: 'emp-1',
    email: 'agent@transimex.cm',
    firstName: 'Jean',
    lastName: 'Kamga',
    role: 'employe',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const authServiceMock = {
    currentUser: signal<UserProfile | null>(mockEmployeeUser),
    token: () => 'mock-jwt-token',
    isAuthenticated: () => true,
    waitForSession: () => Promise.resolve(),
  };

  const cashierServiceMock = {
    currentBalance: signal(0),
    allTransactions: signal([]),
  };

  beforeEach(async () => {
    authServiceMock.currentUser.set(mockEmployeeUser);
    cashierServiceMock.currentBalance.set(0);
    cashierServiceMock.allTransactions.set([]);
    await TestBed.configureTestingModule({
      imports: [DashboardEmployee],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
        { provide: CashierService, useValue: cashierServiceMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardEmployee);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('devrait instancier le composant dashboard employee', () => {
    expect(component).toBeTruthy();
  });

  it('devrait récupérer et exposer les informations du collaborateur connecté', () => {
    expect(component.currentUser()).toEqual(mockEmployeeUser);
    expect(component.currentUser()?.firstName).toBe('Jean');
    expect(component.currentUser()?.lastName).toBe('Kamga');
  });

  it('affiche le lien Journal de caisse uniquement à la caissière', () => {
    const cashierUser = { ...mockEmployeeUser, role: 'caissiere' as const };
    authServiceMock.currentUser.set(cashierUser);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('a[routerLink="/caisse"]')).toBeTruthy();

    authServiceMock.currentUser.set(mockEmployeeUser);
    fixture.detectChanges();
    expect(host.querySelector('a[routerLink="/caisse"]')).toBeNull();
  });

  it('devrait gérer le cas où aucun utilisateur n\'est encore connecté', () => {
    authServiceMock.currentUser.set(null);
    fixture.detectChanges();
    expect(component.currentUser()).toBeNull();
  });
});
