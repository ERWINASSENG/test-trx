import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { roleGuard } from './role.guard';
import { AuthService } from '../services/auth.service';
import { AccessControlService } from '../services/access-control.service';
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe('roleGuard (Niveau 2 de Sécurité RBAC)', () => {
  let authServiceMock: {
    waitForSession: ReturnType<typeof vi.fn>;
    currentUser: ReturnType<typeof vi.fn>;
  };
  let routerMock: {
    createUrlTree: ReturnType<typeof vi.fn>;
  };
  let accessControlMock: {
    loadMyPermissions: ReturnType<typeof vi.fn>;
    hasPermission: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    authServiceMock = {
      waitForSession: vi.fn().mockResolvedValue(undefined),
      currentUser: vi.fn().mockReturnValue(null),
    };

    routerMock = {
      createUrlTree: vi.fn().mockImplementation((commands, extras) => ({
        commands,
        extras,
        toString: () => '/dashboard?unauthorized=1',
      } as unknown as UrlTree)),
    };
    accessControlMock = {
      loadMyPermissions: vi.fn().mockResolvedValue(undefined),
      hasPermission: vi.fn().mockReturnValue(false),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authServiceMock },
        { provide: Router, useValue: routerMock },
        { provide: AccessControlService, useValue: accessControlMock },
      ],
    });
  });

  it('devrait autoriser l’accès si aucune permission spécifique n’est exigée', async () => {
    const routeSnapshot = {
      data: {},
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('devrait autoriser l’accès si la permission serveur est accordée', async () => {
    authServiceMock.currentUser.mockReturnValue({
      id: 'admin-1',
      email: 'admin@transmex.cm',
      role: 'admin',
    });

    accessControlMock.hasPermission.mockReturnValue(true);
    const routeSnapshot = {
      data: { permission: 'access.roles.read' },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('devrait charger les permissions avant de décider', async () => {
    authServiceMock.currentUser.mockReturnValue({
      id: 'tresorier-1',
      email: 'tresorier@transmex.cm',
      role: 'tresorier',
    });

    accessControlMock.hasPermission.mockReturnValue(true);
    const routeSnapshot = {
      data: { permission: 'journals.read' },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('devrait bloquer et rediriger vers /forbidden sans permission', async () => {
    authServiceMock.currentUser.mockReturnValue({
      id: 'user-2',
      email: 'operateur@transmex.cm',
      role: 'employe',
    });

    const routeSnapshot = {
      data: { permission: 'access.roles.read' },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(routerMock.createUrlTree).toHaveBeenCalledWith(['/forbidden'], {
      queryParams: { permission: 'access.roles.read' },
    });
    expect(result).not.toBe(true);
  });

  it('devrait bloquer et rediriger si aucune session n’est connectée', async () => {
    authServiceMock.currentUser.mockReturnValue(null);

    const routeSnapshot = {
      data: { permission: 'access.roles.read' },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(routerMock.createUrlTree).toHaveBeenCalledWith(['/forbidden'], {
      queryParams: { permission: 'access.roles.read' },
    });
    expect(result).not.toBe(true);
  });
});
