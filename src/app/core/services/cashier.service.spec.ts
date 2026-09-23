import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CashierService } from './cashier.service';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { ExportService } from './export.service';
import { NotificationService } from './notification.service';

describe('CashierService - Architecture Hybride & Signals', () => {
  let service: CashierService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;

    TestBed.configureTestingModule({
      providers: [
        CashierService,
        { provide: PLATFORM_ID, useValue: 'browser' },
        {
          provide: NotificationService,
          useValue: {
            success: vi.fn(),
            error: vi.fn(),
            warning: vi.fn(),
            info: vi.fn(),
          },
        },
        {
          provide: ExportService,
          useValue: {
            exportToCsv: vi.fn(),
            exportToExcel: vi.fn(),
            exportToPdf: vi.fn(),
          },
        },
        {
          provide: SupabaseService,
          useValue: {
            isConfigured: () => false,
            ensureInitialized: () => Promise.resolve(),
            supabase: null,
          },
        },
        {
          provide: AuthService,
          useValue: {
            token: () => 'mock-jwt-token',
            currentUser: () => ({ id: 'usr-1', email: 'test@transmex.cm' }),
          },
        },
      ],
    });
    service = TestBed.inject(CashierService);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('devrait être initialisé avec un solde nul et une liste vide', () => {
    expect(service).toBeTruthy();
    expect(service.allTransactions().length).toBe(0);
    expect(service.currentBalance()).toBe(0);
    expect(service.paginationLabel()).toBe('0 / 0');
  });

  it('devrait sauvegarder via l’API serveur-relais et mettre à jour le Signal instantanément (cas nominal)', async () => {
    const mockCreatedDbRow = {
      id: 'tx-uuid-123',
      piece_comptable: 'CSH1/2026/00001',
      date: new Date('2026-09-06T10:00:00Z').toISOString(),
      libelle: 'Plein carburant camion',
      type_transaction: 'Carburant',
      type_description: 'Station Total',
      category: 'sortie' as const,
      matricule_vehicule: 'LT-5544-AA',
      first_name: 'Samuel',
      employee: 'Samuel Eboa',
      quantity: 50,
      montant: -75000,
      created_by: 'usr-1',
    };

    let fetchCalledWithUrl = '';
    let fetchCalledWithInit: RequestInit | undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalledWithUrl = String(input);
      fetchCalledWithInit = init;
      return new Response(
        JSON.stringify({
          success: true,
          operation: mockCreatedDbRow,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    const result = await service.saveOperationViaApi({
      libelle: 'Plein carburant camion',
      typeTransaction: 'Carburant',
      typeDescription: 'Station Total',
      category: 'sortie',
      matriculeVehicule: 'LT-5544-AA',
      firstName: 'Samuel',
      employee: 'Samuel Eboa',
      quantity: 50,
      montant: -75000,
    });

    // 1. Vérification de l'appel API avec le token d'autorisation
    expect(fetchCalledWithUrl).toBe('/api/cahier/operations');
    expect(fetchCalledWithInit?.method).toBe('POST');
    const headers = fetchCalledWithInit?.headers as Record<string, string>;
    expect(headers?.['Authorization']).toBe('Bearer mock-jwt-token');

    // Vérifie que pieceComptable n'est pas imposé côté client (null envoyé pour laisser le trigger l'assigner comme Odoo)
    const bodySent = JSON.parse(String(fetchCalledWithInit?.body || '{}'));
    expect(bodySent.pieceComptable).toBeNull();

    // 2. Vérification de la mise à jour immédiate du Signal avec la pièce retournée par le serveur
    expect(result.success).toBe(true);
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].id).toBe('tx-uuid-123');
    expect(service.allTransactions()[0].pieceComptable).toBe('CSH1/2026/00001');
    expect(service.allTransactions()[0].libelle).toBe('Plein carburant camion');
    expect(service.currentBalance()).toBe(-75000);
  });

  it('devrait refuser l’écriture si l’API serveur-relais renvoie une erreur', async () => {
    // Simulation d'une erreur 500 sur l'API serveur
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'Erreur serveur interne' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const result = await service.saveOperationViaApi({
      libelle: 'Dépannage urgence',
      typeTransaction: 'Maintenance',
      category: 'sortie',
      montant: -20000,
    });

    expect(result.success).toBe(false);
    expect(service.allTransactions().length).toBe(0);
    expect(service.currentBalance()).toBe(0);
  });

  it('devrait récupérer les opérations via l’API rapide dans loadTransactions()', async () => {
    const mockRows = [
      {
        id: 'row-1',
        date: new Date('2026-09-06T08:00:00Z').toISOString(),
        libelle: 'Versement Caisse',
        type_transaction: 'Apport',
        type_description: '',
        category: 'entree' as const,
        first_name: 'Admin',
        employee: 'Directeur',
        quantity: 1,
        montant: 500000,
      },
    ];

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ operations: mockRows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await service.loadTransactions();

    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].libelle).toBe('Versement Caisse');
    expect(service.currentBalance()).toBe(500000);
  });

  it('devrait supprimer les éléments sélectionnés et recalculer les soldes', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        success: true,
        operation: {
          id: 'tx-delete-1',
          date: '2026-09-20',
          libelle: 'Transaction à supprimer',
          category: 'sortie',
          montant: -10000,
          status: 'draft',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    // Ajout d'une opération initiale
    await service.saveOperationViaApi({
      libelle: 'Transaction à supprimer',
      montant: -10000,
      category: 'sortie',
    });

    expect(service.allTransactions().length).toBe(1);
    const id = service.allTransactions()[0].id;
    service.toggleSelectTransaction(id);

    expect(service.allTransactions()[0].selected).toBe(true);

    await service.deleteSelected();
    expect(service.allTransactions().length).toBe(0);
    expect(service.currentBalance()).toBe(0);
  });

  it('devrait filtrer les données réactivement avec les Signals de recherche', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          success: true,
          operation: {
            id: 'row-1',
            date: new Date().toISOString(),
            libelle: 'Frais de péage autoroute',
            type_transaction: 'Péage',
            category: 'sortie',
            montant: -5000,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    await service.saveOperationViaApi({
      libelle: 'Frais de péage autoroute',
      typeTransaction: 'Péage',
      category: 'sortie',
      montant: -5000,
    });

    service.setSearchQuery('péage');
    expect(service.filteredTransactions().length).toBe(1);

    service.setSearchQuery('carburant');
    expect(service.filteredTransactions().length).toBe(0);

    service.setSearchQuery('');
    expect(service.filteredTransactions().length).toBe(1);
  });

  it('devrait calculer la prochaine pièce comptable séquentielle nextPieceComptable (Cas nominal)', async () => {
    const currentYear = new Date().getFullYear() || 2026;
    expect(service.nextPieceComptable()).toBe(`CSH1/${currentYear}/00001`);

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          operations: [
            {
              id: 'row-1',
              piece_comptable: `CSH1/${currentYear}/00005`,
              date: new Date().toISOString(),
              libelle: 'Opération avec pièce',
              montant: 10000,
              category: 'entree',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    await service.loadTransactions();

    expect(service.nextPieceComptable()).toBe(`CSH1/${currentYear}/00006`);
  });

  it('devrait bloquer immédiatement la création si le numéro de pièce comptable existe déjà (Cas d’erreur)', async () => {
    const currentYear = new Date().getFullYear() || 2026;
    const existingPiece = `CSH1/${currentYear}/00010`;

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          operations: [
            {
              id: 'row-existing',
              piece_comptable: existingPiece,
              date: new Date().toISOString(),
              libelle: 'Opération déjà présente',
              montant: 50000,
              category: 'entree',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    await service.loadTransactions();

    const result = await service.saveOperationViaApi({
      pieceComptable: existingPiece,
      libelle: 'Nouvelle opération avec même pièce',
      montant: 25000,
      category: 'entree',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(existingPiece);
    expect(service.error()).toContain('déjà attribué');
  });

  it('devrait propager le rejet HTTP 409 renvoyé par le serveur si un doublon survient côté serveur', async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          error: 'Erreur d\'unicité : le numéro de pièce comptable "CSH1/2026/00099" est déjà attribué.',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof globalThis.fetch;

    const result = await service.saveOperationViaApi({
      pieceComptable: 'CSH1/2026/00099',
      libelle: 'Tentative avec pièce en conflit',
      montant: 12000,
      category: 'sortie',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Erreur d\'unicité');
    expect(service.error()).toContain('CSH1/2026/00099');
  });

  it('devrait initialiser la pagination à 80 éléments minimum et respecter ce plancher via setPageSize', () => {
    expect(service.filterState().pageSize).toBe(80);

    // Tentative de définir une taille inférieure à 80 -> doit être ramenée à 80
    service.setPageSize(10);
    expect(service.filterState().pageSize).toBe(80);

    service.setPageSize(50);
    expect(service.filterState().pageSize).toBe(80);

    // Taille supérieure ou égale à 80 -> acceptée
    service.setPageSize(100);
    expect(service.filterState().pageSize).toBe(100);

    // Valeur invalide ou négative -> ramenée à 80
    service.setPageSize(-5);
    expect(service.filterState().pageSize).toBe(80);
  });

  it('devrait paginer correctement avec le plancher de 80 éléments', () => {
    const mockRows = Array.from({ length: 95 }, (_, i) => ({
      id: `tx-${i + 1}`,
      date: '2026-09-01',
      libelle: `Opération test ${i + 1}`,
      montant: 1000,
      category: 'entree' as const,
      status: 'draft' as const,
      created_at: new Date(2026, 8, 1, 10, i).toISOString(),
    }));

    const mapped = service.mapDatabaseOperations(mockRows);
    (service as unknown as { _transactions: { set: (v: unknown) => void } })._transactions.set(mapped);

    expect(service.totalCount()).toBe(95);
    expect(service.pagedTransactions().length).toBe(80);
    expect(service.paginationLabel()).toBe('1-80 / 95');
    expect(service.hasNextPage()).toBe(true);
    expect(service.hasPrevPage()).toBe(false);

    service.nextPage();
    expect(service.pagedTransactions().length).toBe(15);
    expect(service.paginationLabel()).toBe('81-95 / 95');
    expect(service.hasNextPage()).toBe(false);
    expect(service.hasPrevPage()).toBe(true);
  });
});
