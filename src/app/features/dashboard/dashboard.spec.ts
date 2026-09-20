import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Dashboard } from './dashboard';
import { AuthService } from '../../core/services/auth.service';
import { UserService } from '../../core/services/user.service';
import { UserProfile } from '../../core/models/auth.model';

describe('Dashboard Component', () => {
  let component: Dashboard;
  const currentUserMock = signal<UserProfile | null>(null);

  const authServiceMock = {
    currentUser: currentUserMock,
  };

  const userServiceMock = {
    users: signal([]),
    totalUsersCount: signal(0),
    activeUsersCount: signal(0),
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
        { provide: UserService, useValue: userServiceMock },
      ],
    });

    const fixture = TestBed.createComponent(Dashboard);
    component = fixture.componentInstance;
  });

  it('devrait initialiser le composant parent dashboard', () => {
    expect(component).toBeTruthy();
  });

  it('devrait orienter vers la vue admin si le rôle est admin', () => {
    currentUserMock.set({
      id: 'admin-id',
      email: 'admin@transimex.cm',
      firstName: 'Admin',
      lastName: 'Transimex',
      role: 'admin',
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    expect(component.dashboardView()).toBe('admin');
  });

  it('devrait orienter vers la vue manager si le rôle est manager', () => {
    currentUserMock.set({
      id: 'manager-id',
      email: 'manager@transimex.cm',
      firstName: 'Manager',
      lastName: 'Logistique',
      role: 'manager',
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    expect(component.dashboardView()).toBe('manager');
  });

  it('devrait orienter vers la vue manager si le rôle est tresorier', () => {
    currentUserMock.set({
      id: 'tresorier-id',
      email: 'tresorier@transimex.cm',
      firstName: 'Trésorier',
      lastName: 'Finance',
      role: 'tresorier',
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    expect(component.dashboardView()).toBe('manager');
  });

  it('devrait orienter vers la vue employee pour un collaborateur employe', () => {
    currentUserMock.set({
      id: 'employe-id',
      email: 'employe@transimex.cm',
      firstName: 'Agent',
      lastName: 'Maritime',
      role: 'employe',
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    expect(component.dashboardView()).toBe('employee');
  });
});
