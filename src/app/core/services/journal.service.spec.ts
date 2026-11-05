import { computed, signal } from '@angular/core';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { JournalService } from './journal.service';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { CashierService } from './cashier.service';
import { AccessControlService } from './access-control.service';

describe('JournalService', () => {
  let service: JournalService;
  let grantedPermissions: ReturnType<typeof signal<string[]>>;

  const mockSupabaseService: { supabase: SupabaseService['supabase'] } = {
    supabase: null,
  };

  const mockAuthService = {
    currentUser: () => ({ id: 'usr-1', email: 'test@example.com' }),
    token: () => 'test-token',
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
    grantedPermissions = signal(['journals.read']);
    const mockAccessControl = {
      hasPermission: (permissionKey: string) => grantedPermissions().includes(permissionKey),
      effectivePermissions: grantedPermissions,
    };
    service = Object.create(JournalService.prototype);
    Object.assign(service, {
      supabaseService: mockSupabaseService as unknown as SupabaseService,
      authService: mockAuthService as unknown as AuthService,
      notificationService: mockNotificationService as unknown as NotificationService,
      cashierService: mockCashierService as unknown as CashierService,
      accessControl: mockAccessControl as unknown as AccessControlService,
      canViewJournals: computed(() => mockAccessControl.hasPermission('journals.read')),
      canCreateJournal: computed(() => mockAccessControl.hasPermission('journals.create')),
      canUpdateJournal: computed(() => mockAccessControl.hasPermission('journals.update')),
      canDeleteJournal: computed(() => mockAccessControl.hasPermission('journals.delete')),
      isReadOnly: computed(() => (
        mockAccessControl.hasPermission('journals.read')
        && !mockAccessControl.hasPermission('journals.update')
      )),
      defaultNativeCashJournal: { id: 'native-caisse-principal' },
      _journals: signal([]),
      _isLoading: signal(false),
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockSupabaseService.supabase = null;
  });

  it('devrait initialiser les fonctions du service', () => {
    expect(service.getTypeLabel('cash')).toBe('Espèces');
    expect(service.getTypeLabel('bank')).toBe('Banque');
    expect(service.getTypeLabel('sale')).toBe('Ventes');
    expect(service.getTypeLabel('purchase')).toBe('Achats');
    expect(service.getTypeLabel('general')).toBe('Divers');
  });

  it('devrait dériver les capacités des permissions effectives plutôt que du rôle', () => {
    expect(service.canViewJournals()).toBe(true);
    expect(service.canCreateJournal()).toBe(false);
    expect(service.canUpdateJournal()).toBe(false);
    expect(service.isReadOnly()).toBe(true);

    grantedPermissions.set(['journals.read', 'journals.create', 'journals.update']);
    expect(service.canCreateJournal()).toBe(true);
    expect(service.canUpdateJournal()).toBe(true);
    expect(service.isReadOnly()).toBe(false);
  });

  it('ne modifie pas directement le statut si la permission update manque', async () => {
    Object.assign(service, {
      _journals: signal([{ id: 'journal-1', is_active: true }]),
    });

    await service.toggleActive('journal-1');

    expect(mockNotificationService.error).toHaveBeenCalledWith(
      'Tu ne disposes pas de la permission nécessaire pour modifier des journaux.',
      'Action non autorisée'
    );
  });

  it('ne contourne pas un refus API par une lecture directe Supabase', async () => {
    const from = vi.fn();
    const journals = signal<{ id: string }[]>([]);
    mockSupabaseService.supabase = { from } as unknown as SupabaseService['supabase'];
    Object.assign(service, {
      _journals: journals,
      journals: computed(() => journals()),
    });
    grantedPermissions.set(['journals.read']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    await service.loadJournals();

    expect(from).not.toHaveBeenCalled();
    expect(service.journals()).toEqual([{ id: 'native-caisse-principal' }]);
  });

  it('affiche le motif métier renvoyé par l’API lors du chargement des journaux', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'L’accès aux journaux est temporairement suspendu.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));

    await service.loadJournals();

    expect(mockNotificationService.error).toHaveBeenCalledWith(
      'L’accès aux journaux est temporairement suspendu.',
      'Chargement impossible'
    );
  });

  it('distingue une panne réseau lors du chargement des journaux', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await service.loadJournals();

    expect(mockNotificationService.error).toHaveBeenCalledWith(
      'Connexion au service des journaux impossible. Vérifiez votre connexion puis réessayez.',
      'Chargement impossible'
    );
  });

  it('signale une réponse de chargement invalide', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('null', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));

    await service.loadJournals();

    expect(mockNotificationService.error).toHaveBeenCalledWith(
      'Le serveur a renvoyé une liste de journaux invalide.',
      'Chargement impossible'
    );
  });

  it('conserve le motif métier lors du refus de création d’un journal', async () => {
    grantedPermissions.set(['journals.read', 'journals.create']);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Ce préfixe de séquence est déjà utilisé.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    )));

    const result = await service.createJournal({
      name: 'Journal de test',
      type: 'bank',
      sequence_prefix: 'BNK1',
      default_account: '512000',
    });

    expect(result).toBeNull();
    expect(mockNotificationService.error).toHaveBeenCalledWith(
      'Ce préfixe de séquence est déjà utilisé.',
      'Échec de création'
    );
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
