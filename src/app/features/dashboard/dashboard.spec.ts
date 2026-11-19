import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { Dashboard } from './dashboard';
import { AuthService } from '../../core/services/auth.service';
import { AccessControlService } from '../../core/services/access-control.service';
import { UserService } from '../../core/services/user.service';
import { UserProfile } from '../../core/models/auth.model';

describe('Dashboard Component', () => {
  let component: Dashboard;
  const currentUserMock = signal<UserProfile | null>(null);
  const grantedPermissions = signal<string[]>([]);

  const authServiceMock = {
    currentUser: currentUserMock,
  };

  const userServiceMock = {
    users: signal([]),
    totalUsersCount: signal(0),
    activeUsersCount: signal(0),
  };

  beforeEach(() => {
    grantedPermissions.set([]);
    currentUserMock.set({
      id: 'usr-default',
      email: 'user@transimex.cm',
      firstName: 'Agent',
      lastName: 'Transmex',
      role: 'employe',
      isActive: true,
      createdAt: new Date().toISOString(),
    });

    TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authServiceMock },
        {
          provide: AccessControlService,
          useValue: { hasPermission: (perm: string) => grantedPermissions().includes(perm) },
        },
        { provide: UserService, useValue: userServiceMock },
      ],
    });

    const fixture = TestBed.createComponent(Dashboard);
    component = fixture.componentInstance;
  });

  it('devrait initialiser le composant parent dashboard', () => {
    expect(component).toBeTruthy();
  });

  it('devrait orienter vers la vue admin avec dashboard.admin.view', () => {
    grantedPermissions.set(['dashboard.admin.view']);
    expect(component.dashboardView()).toBe('admin');
  });

  it('devrait orienter vers la vue manager avec dashboard.manager.view (même pour un rôle personnalisé)', () => {
    currentUserMock.set({
      id: 'daf-id',
      email: 'daf@transimex.cm',
      firstName: 'Directeur',
      lastName: 'Finance',
      role: 'employe',
      customRole: 'daf',
      isActive: true,
      createdAt: new Date().toISOString(),
    });
    grantedPermissions.set(['dashboard.manager.view']);

    expect(component.dashboardView()).toBe('manager');
  });

  it('devrait orienter vers la vue commercial avec dashboard.commercial.view', () => {
    grantedPermissions.set(['dashboard.commercial.view']);
    expect(component.dashboardView()).toBe('commercial');
  });

  it('devrait orienter vers la vue commercial pour un rôle personnalisé ayant module.crm.view', () => {
    grantedPermissions.set(['module.crm.view']);
    expect(component.dashboardView()).toBe('commercial');
  });

  it('devrait replier sur la vue employee par défaut sans permission de vue spécifique (fail-safe)', () => {
    grantedPermissions.set(['module.dashboard.view']);
    expect(component.dashboardView()).toBe('employee');
  });
});
