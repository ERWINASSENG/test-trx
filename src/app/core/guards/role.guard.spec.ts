import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { roleGuard } from './role.guard';
import { AuthService } from '../services/auth.service';
import { vi, describe, it, expect, beforeEach } from 'vitest';

describe('roleGuard (Niveau 2 de Sécurité RBAC)', () => {
  let authServiceMock: {
    waitForSession: ReturnType<typeof vi.fn>;
    currentUser: ReturnType<typeof vi.fn>;
  };
  let routerMock: {
    createUrlTree: ReturnType<typeof vi.fn>;
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

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authServiceMock },
        { provide: Router, useValue: routerMock },
      ],
    });
  });

  it('devrait autoriser l’accès si aucun rôle spécifique n’est exigé dans data.roles', async () => {
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

  it('devrait autoriser l’accès si l’utilisateur a le rôle admin (cas nominal)', async () => {
    authServiceMock.currentUser.mockReturnValue({
      id: 'admin-1',
      email: 'admin@transmex.cm',
      role: 'admin',
    });

    const routeSnapshot = {
      data: { roles: ['admin'] },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('devrait autoriser le rôle trésorier sur une route réservée aux managers', async () => {
    authServiceMock.currentUser.mockReturnValue({
      id: 'tresorier-1',
      email: 'tresorier@transmex.cm',
      role: 'tresorier',
    });

    const routeSnapshot = {
      data: { roles: ['manager'] },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('devrait bloquer et rediriger vers /dashboard si l’utilisateur a le rôle employé ou opérateur', async () => {
    authServiceMock.currentUser.mockReturnValue({
      id: 'user-2',
      email: 'operateur@transmex.cm',
      role: 'employe',
    });

    const routeSnapshot = {
      data: { roles: ['admin'] },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(routerMock.createUrlTree).toHaveBeenCalledWith(['/dashboard'], {
      queryParams: { unauthorized: '1' },
    });
    expect(result).not.toBe(true);
  });

  it('devrait bloquer et rediriger vers /dashboard si aucun utilisateur n’est connecté', async () => {
    authServiceMock.currentUser.mockReturnValue(null);

    const routeSnapshot = {
      data: { roles: ['admin'] },
    } as unknown as ActivatedRouteSnapshot;

    const stateSnapshot = {} as RouterStateSnapshot;

    const result = await TestBed.runInInjectionContext(() =>
      roleGuard(routeSnapshot, stateSnapshot)
    );

    expect(authServiceMock.waitForSession).toHaveBeenCalled();
    expect(routerMock.createUrlTree).toHaveBeenCalledWith(['/dashboard'], {
      queryParams: { unauthorized: '1' },
    });
    expect(result).not.toBe(true);
  });
});
