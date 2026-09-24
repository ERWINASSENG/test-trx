import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JournalService } from './journal.service';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { CashierService } from './cashier.service';

describe('JournalService', () => {
  let service: JournalService;

  const mockSupabaseService = {
    supabase: null,
  };

  const mockAuthService = {
    currentUser: () => ({ id: 'usr-1', email: 'test@example.com' }),
  };

  const mockNotificationService = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };

  const mockCashierService = {
    currentBalance: () => 1500000,
    allTransactions: () => [],
  };

  beforeEach(() => {
    service = Object.create(JournalService.prototype);
    Object.assign(service, {
      supabaseService: mockSupabaseService as unknown as SupabaseService,
      authService: mockAuthService as unknown as AuthService,
      notificationService: mockNotificationService as unknown as NotificationService,
      cashierService: mockCashierService as unknown as CashierService,
    });
  });

  it('devrait initialiser les fonctions du service', () => {
    expect(service.getTypeLabel('cash')).toBe('Espèces');
    expect(service.getTypeLabel('bank')).toBe('Banque');
    expect(service.getTypeLabel('sale')).toBe('Ventes');
    expect(service.getTypeLabel('purchase')).toBe('Achats');
    expect(service.getTypeLabel('general')).toBe('Divers');
  });
});
