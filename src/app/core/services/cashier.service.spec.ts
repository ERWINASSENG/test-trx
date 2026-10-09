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
      status: 'posted' as const,
      matricule_vehicule: 'LT-5544-AA',
      dossier_id: 'dossier-1',
      first_name: 'Samuel',
      employee: 'Samuel Eboa',
      quantity: 50,
      montant: -75000,
      created_by: 'usr-1',
    };

    let fetchCalledWithUrl = '';
    let fetchCalledWithInit: RequestInit | undefined;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/cahier/operations') {
        fetchCalledWithUrl = String(input);
        fetchCalledWithInit = init;
      }
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
      status: 'posted',
      matriculeVehicule: 'LT-5544-AA',
      dossierId: 'dossier-1',
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
    expect(bodySent.dossierId).toBe('dossier-1');

    // 2. Vérification de la mise à jour immédiate du Signal avec la pièce retournée par le serveur
    expect(result.success).toBe(true);
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].id).toBe('tx-uuid-123');
    expect(service.allTransactions()[0].pieceComptable).toBe('CSH1/2026/00001');
    expect(service.allTransactions()[0].dossierId).toBe('dossier-1');
    expect(service.allTransactions()[0].libelle).toBe('Plein carburant camion');
    expect(service.currentBalance()).toBe(-75000);
  });

  it('devrait transmettre le dossier lié lors de la modification d’une opération Caisse', async () => {
    const mapped = service.mapDatabaseOperations([{
      id: 'tx-existing',
      date: '2026-10-01',
      libelle: 'Dépense existante',
      category: 'sortie',
      status: 'posted',
      montant: -10000,
    }]);
    (service as unknown as { _transactions: { set: (value: unknown) => void } })._transactions.set(mapped);

    let updateBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        updateBody = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
      }
      return new Response(JSON.stringify({ summary: { solde_global: -10000 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const result = await service.updateTransaction('tx-existing', { dossierId: 'dossier-2' });

    expect(result.success).toBe(true);
    expect(updateBody['dossierId']).toBe('dossier-2');
    expect(service.allTransactions()[0].dossierId).toBe('dossier-2');
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

  it('devrait ne compter que les opérations posted dans le solde après chargement', async () => {
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
        status: 'posted' as const,
      },
      {
        id: 'row-2',
        date: '2026-09-07',
        libelle: 'Brouillon non comptabilisé',
        category: 'entree' as const,
        montant: 250000,
        status: 'draft' as const,
      },
      {
        id: 'row-3',
        date: '2026-09-08',
        libelle: 'Opération annulée',
        category: 'sortie' as const,
        montant: -100000,
        status: 'cancelled' as const,
      },
    ];

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ operations: mockRows }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await service.loadTransactions();

    expect(service.allTransactions().length).toBe(3);
    expect(service.allTransactions().find((tx) => tx.id === 'row-1')?.libelle).toBe('Versement Caisse');
    expect(service.currentBalance()).toBe(500000);
    expect(service.caisseTotalEntrees()).toBe(500000);
    expect(service.caisseTotalSorties()).toBe(0);
  });

  it('devrait donner la priorité absolue à serverSummary pour caisseBalance, caisseTotalEntrees et caisseTotalSorties', async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/summary')) {
        return new Response(
          JSON.stringify({
            summary: {
              solde_global: 4200000,
              total_entrees: 5000000,
              total_sorties: 800000,
              total_count: 42,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ operations: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    await service.loadCashierSummary();

    expect(service.caisseBalance()).toBe(4200000);
    expect(service.currentBalance()).toBe(4200000);
    expect(service.caisseTotalEntrees()).toBe(5000000);
    expect(service.caisseTotalSorties()).toBe(800000);
  });

  it('devrait annuler les éléments sélectionnés sans supprimer leur pièce comptable', async () => {
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith('/status')) {
        return new Response(JSON.stringify({
          success: true,
          count: 1,
          data: [{ id: 'tx-delete-1', piece_comptable: 'CSH1/2026/00001', status: 'cancelled' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        success: true,
        operation: {
          id: 'tx-delete-1',
          piece_comptable: 'CSH1/2026/00001',
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

    await service.cancelSelected();
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].status).toBe('cancelled');
    expect(service.allTransactions()[0].pieceComptable).toBe('CSH1/2026/00001');
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
      libelle: 'Tentative avec pièce en conflit',
      montant: 12000,
      category: 'sortie',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Erreur d\'unicité');
    expect(service.error()).toContain('CSH1/2026/00099');
  });

  it('devrait refuser une pièce fournie par le client avant tout appel serveur', async () => {
    let requestSent = false;
    globalThis.fetch = (async () => {
      requestSent = true;
      return new Response(null, { status: 201 });
    }) as typeof globalThis.fetch;

    const result = await service.saveOperationViaApi({
      pieceComptable: 'CSH1/2026/00099',
      libelle: 'Pièce importée manuellement',
      montant: 12000,
      category: 'sortie',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('attribuée par la base');
    expect(requestSent).toBe(false);
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

  it('devrait rendre visible en première page un nouveau brouillon sans pièce', async () => {
    const postedRows = Array.from({ length: 80 }, (_, index) => ({
      id: `posted-${index}`,
      piece_comptable: `CSH1/2026/${String(index + 1).padStart(5, '0')}`,
      date: '2026-10-02',
      libelle: `Opération comptabilisée ${index}`,
      category: 'entree' as const,
      status: 'posted' as const,
      montant: 100,
    }));
    const mappedRows = service.mapDatabaseOperations(postedRows);
    (service as unknown as { _transactions: { set: (value: unknown) => void } })._transactions.set(mappedRows);
    service.setPageIndex(1);

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          operation: {
            id: 'draft-without-piece',
            piece_comptable: null,
            date: '2026-10-03',
            libelle: 'Brouillon sans pièce',
            service: 'TRANSIT',
            category: 'entree',
            status: 'draft',
            montant: 1,
            created_at: '2026-10-03T10:00:00.000Z',
          },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ operations: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const result = await service.saveOperationViaApi({
      libelle: 'Brouillon sans pièce',
      service: 'TRANSIT',
      category: 'entree',
      status: 'draft',
      montant: 1,
    });

    expect(result.success).toBe(true);
    expect(service.filterState().pageIndex).toBe(0);
    expect(service.pagedTransactions()[0].id).toBe('draft-without-piece');
  });
});
