import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, beforeEach, expect, it } from 'vitest';
import { UserProfile, UserRole } from '../models/auth.model';
import { AuthService } from './auth.service';
import { AccessControlService } from './access-control.service';

describe('AccessControlService', () => {
  let service: AccessControlService;
  let currentUser: ReturnType<typeof signal<UserProfile | null>>;
  let currentRole: ReturnType<typeof signal<UserRole>>;

  beforeEach(() => {
    currentUser = signal<UserProfile | null>({
      id: 'cashier-user',
      email: 'cashier@example.test',
      firstName: 'Test',
      lastName: 'Cashier',
      role: 'caissiere',
      isActive: true,
      createdAt: '2026-10-03T00:00:00.000Z',
    });
    currentRole = signal<UserRole>('caissiere');

    TestBed.configureTestingModule({
      providers: [
        AccessControlService,
        {
          provide: AuthService,
          useValue: {
            currentUser,
            currentRole,
            isAdmin: () => currentRole() === 'admin',
          },
        },
      ],
    });
    service = TestBed.inject(AccessControlService);
  });

  it('autorise la caissière à mettre à jour le statut des opérations', () => {
    expect(service.hasPermission('cashier.status_update')).toBe(true);
    expect(service.hasPermission('cashier.update')).toBe(true);
  });

  it('refuse le droit de mise à jour du statut au comptable par défaut', () => {
    currentRole.set('comptable');
    currentUser.update((user) => user ? { ...user, role: 'comptable' } : null);

    expect(service.hasPermission('cashier.status_update')).toBe(false);
    expect(service.hasPermission('cashier.update')).toBe(false);
  });
});