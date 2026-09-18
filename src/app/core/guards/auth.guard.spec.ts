import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';
import { UserProfile } from '../models/auth.model';

describe('AuthGuard', () => {
  const mockActiveUser: UserProfile = {
    id: 'user-1',
    email: 'user@transmex.com',
    firstName: 'Jean',
    lastName: 'Dupont',
    role: 'employe',
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  const mockInactiveUser: UserProfile = {
    id: 'user-2',
    email: 'inactive@transmex.com',
    firstName: 'Paul',
    lastName: 'Inactif',
    role: 'employe',
    isActive: false,
    createdAt: new Date().toISOString(),
  };

  let currentUserSignal = signal<UserProfile | null>(mockActiveUser);
  let isAuthenticatedSignal = signal<boolean>(true);
  let logoutSpy = vi.fn();

  beforeEach(() => {
    currentUserSignal = signal<UserProfile | null>(mockActiveUser);
    isAuthenticatedSignal = signal<boolean>(true);
    logoutSpy = vi.fn();

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            currentUser: currentUserSignal,
            isAuthenticated: isAuthenticatedSignal,
            logout: logoutSpy,
          },
        },
      ],
    });
  });

  const dummyRoute = {} as ActivatedRouteSnapshot;
  const dummyState = { url: '/dashboard' } as RouterStateSnapshot;

  it('devrait autoriser l\'accès si l\'utilisateur est authentifié et actif', async () => {
    currentUserSignal.set(mockActiveUser);
    isAuthenticatedSignal.set(true);

    const result = await TestBed.runInInjectionContext(() => authGuard(dummyRoute, dummyState));
    expect(result).toBe(true);
  });

  it('devrait bloquer et déconnecter si l\'utilisateur est connecté mais inactif (isActive = false)', async () => {
    currentUserSignal.set(mockInactiveUser);
    isAuthenticatedSignal.set(true);

    const result = await TestBed.runInInjectionContext(() => authGuard(dummyRoute, dummyState));
    expect(result instanceof UrlTree).toBe(true);
    expect(logoutSpy).toHaveBeenCalled();
    expect((result as UrlTree).queryParams['error']).toBe('account_disabled');
  });

  it('devrait rediriger vers /auth/login avec returnUrl si l\'utilisateur n\'est pas authentifié', async () => {
    currentUserSignal.set(null);
    isAuthenticatedSignal.set(false);

    const result = await TestBed.runInInjectionContext(() => authGuard(dummyRoute, dummyState));
    expect(result instanceof UrlTree).toBe(true);
    expect((result as UrlTree).queryParams['returnUrl']).toBe('/dashboard');
  });
});
