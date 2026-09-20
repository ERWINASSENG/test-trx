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
            isConfigured: () => true,
            ensureInitialized: () => Promise.resolve(),
            supabase: {
              auth: {
                getSession: () => Promise.resolve({ data: { session: null } }),
              },
              from: () => {
                const queryBuilder = {
                  select: () => {
                    const selectChain = {
                      eq: () => Promise.resolve({ data: null, error: null }),
                      single: () => Promise.resolve({ data: null, error: null }),
                    };
                    return selectChain;
                  },
                  insert: () => {
                    const insertChain = {
                      select: () => {
                        const selectChain2 = {
                          single: () => Promise.resolve({
                            data: {
                              id: 'direct-uuid-456',
                              piece_comptable: 'PC-123',
                              date: new Date().toISOString(),
                              libelle: 'Dépannage urgence',
                              service: 'TRANSPORT',
                              category: 'sortie',
                              status: 'draft',
                              montant: -20000,
                              quantity: 1,
                              no_dossier: '',
                              employee: '',
                            },
                            error: null,
                          }),
                        };
                        return selectChain2;
                      },
                    };
                    return insertChain;
                  },
                };
                return queryBuilder;
              },
            },
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
      service: 'TRANSPORT',
      typeDescription: 'Station Total',
      category: 'sortie',
      noDossier: 'LT-5544-AA',
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

    // 2. Vérification de la mise à jour immédiate du Signal
    expect(result.success).toBe(true);
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].id).toBe('tx-uuid-123');
    expect(service.allTransactions()[0].libelle).toBe('Plein carburant camion');
    expect(service.currentBalance()).toBe(-75000);
  });

  it('devrait basculer en repli sécurisé si l’API serveur-relais renvoie une erreur', async () => {
    // Simulation d'une erreur 500 sur l'API serveur
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: 'Erreur serveur interne' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const result = await service.saveOperationViaApi({
      libelle: 'Dépannage urgence',
      service: 'TRANSPORT',
      category: 'sortie',
      montant: -20000,
    });

    // Même en cas d'indisponibilité de l'API, l'état local du Signal est préservé
    expect(result.success).toBe(true);
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].libelle).toBe('Dépannage urgence');
    expect(service.currentBalance()).toBe(-20000);
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
    globalThis.fetch = vi.fn().mockImplementation((url, init) => {
      if (init && init.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true, deletedCount: 1 }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          operation: {
            id: 'tx-to-delete',
            piece_comptable: 'PC-123',
            date: '2026-09-15',
            libelle: 'Transaction à supprimer',
            service: 'TRANSPORT',
            category: 'sortie',
            status: 'draft',
            montant: -10000,
          }
        })
      });
    }) as unknown as typeof globalThis.fetch;

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
      service: 'TRANSPORT',
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

  it('devrait basculer sur le canal de secours Supabase direct avec limitation stricte si l’API Express échoue', async () => {
    // 1. Simuler l'échec de l'API Express
    globalThis.fetch = (async () => {
      throw new Error('API Express indisponible');
    }) as typeof globalThis.fetch;

    let capturedLimit: number | null = null;
    const mockDbRow = {
      id: 'fallback-row-1',
      date: new Date('2026-09-06T08:00:00Z').toISOString(),
      libelle: 'Opération via Supabase direct bornée',
      category: 'entree' as const,
      montant: 150000,
    };

    const mockQueryBuilder: Record<string, unknown> = {};
    mockQueryBuilder['select'] = () => mockQueryBuilder;
    mockQueryBuilder['order'] = () => mockQueryBuilder;
    mockQueryBuilder['limit'] = (lim: number) => {
      capturedLimit = lim;
      return Promise.resolve({ data: [mockDbRow], error: null });
    };

    const mockSupabaseClient = {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      },
      from: (table: string) => {
        expect(table).toBe('cashier_transactions');
        return mockQueryBuilder;
      },
    };

    const supabaseService = TestBed.inject(SupabaseService);
    Object.defineProperty(supabaseService, 'supabase', {
      value: mockSupabaseClient,
      configurable: true,
    });

    // Test avec limite personnalisée (ex. 500)
    await service.loadTransactions(500);

    expect(capturedLimit).toBe(500);
    expect(service.allTransactions().length).toBe(1);
    expect(service.allTransactions()[0].libelle).toBe('Opération via Supabase direct bornée');
  });
});
