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

  it('devrait calculer le solde propre du journal natif de caisse', () => {
    Object.assign(service, {
      defaultNativeCashJournal: { id: 'native-caisse-principal' },
      cashierService: {
        allTransactions: () => [
          { montant: 10000, journalId: 'native-caisse-principal' },
          { montant: -4000, journal_id: 'native-caisse-principal' },
          { montant: 50000, journalId: 'other-journal' },
        ],
      },
    });

    const balance = service.getJournalBalance('native-caisse-principal');
    expect(balance).toBe(6000);
  });

  it('devrait calculer le solde propre d’un autre journal', () => {
    Object.assign(service, {
      defaultNativeCashJournal: { id: 'native-caisse-principal' },
      cashierService: {
        allTransactions: () => [
          { montant: 10000, journalId: 'native-caisse-principal' },
          { montant: 50000, journalId: 'bank-1' },
          { montant: -20000, journalId: 'bank-1' },
        ],
      },
    });

    expect(service.getJournalBalance('bank-1')).toBe(30000);
    expect(service.getJournalTransactionCount('bank-1')).toBe(2);
  });
});
