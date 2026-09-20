import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthService } from './auth.service';
import { SupabaseService } from './supabase.service';
import { UserProfile } from '../models/auth.model';

describe('AuthService', () => {
  let service: AuthService;
  let routerSpy: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    routerSpy = { navigate: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: Router, useValue: routerSpy },
        {
          provide: SupabaseService,
          useValue: {
            supabase: null,
            isConfigured: signal(false),
            ensureInitialized: vi.fn().mockResolvedValue(false),
          },
        },
      ],
    });

    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
    service = TestBed.inject(AuthService);
  });

  it('devrait être créé avec un état non authentifié par défaut sans fausses données', () => {
    expect(service).toBeTruthy();
    expect(service.isAuthenticated()).toBe(false);
    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
  });

  it('ne doit JAMAIS écrire le token JWT dans le localStorage lors de la création d une session (anti-XSS)', () => {
    const mockUser: UserProfile = {
      id: 'usr-123',
      email: 'test@transmex.com',
      firstName: 'Jean',
      lastName: 'Dupont',
      role: 'employe',
      roles: ['employe'],
      department: 'Exploitation',
      isActive: true,
      createdAt: new Date().toISOString(),
    };
    const mockToken = 'secret.jwt.token.never.in.localstorage';

    service.setLocalSession(mockUser, mockToken);

    // Vérification mémoire
    expect(service.isAuthenticated()).toBe(true);
    expect(service.currentUser()?.email).toBe('test@transmex.com');
    expect(service.token()).toBe(mockToken);

    // Vérification absence stricte dans le localStorage
    if (typeof localStorage !== 'undefined') {
      expect(localStorage.getItem('transmex_auth_session')).toBeNull();
      expect(localStorage.getItem('sb-token')).toBeNull();
    }
  });

  it('devrait échouer proprement lors d une tentative avec des identifiants inconnus', async () => {
    const result = await service.login({
      email: 'inconnu@transmex.com',
      password: 'password123',
    });

    expect(result.success).toBe(false);
    expect(service.authError()).toBeTruthy();
  });

  it('devrait vider la session en mémoire et rediriger vers le login lors de la déconnexion', async () => {
    await service.logout();
    expect(service.currentUser()).toBeNull();
    expect(service.token()).toBeNull();
    expect(service.isAuthenticated()).toBe(false);
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/auth/login']);
  });
});
