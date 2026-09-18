import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { DashboardEmployee } from './dashboard-employee';
import { AuthService } from '../../../core/services/auth.service';
import { UserProfile } from '../../../core/models/auth.model';

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
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DashboardEmployee],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
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
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Jean');
    expect(compiled.textContent).toContain('Kamga');
  });

  it('devrait gérer le cas où aucun utilisateur n\'est encore connecté', () => {
    authServiceMock.currentUser.set(null);
    fixture.detectChanges();
    expect(component.currentUser()).toBeNull();
  });
});
