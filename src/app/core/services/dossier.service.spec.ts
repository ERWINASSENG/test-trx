import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { DossierService } from './dossier.service';

describe('DossierService', () => {
  let service: DossierService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let token: string | null;

  beforeEach(() => {
    token = 'mock-jwt-token';
    TestBed.configureTestingModule({
      providers: [
        DossierService,
        { provide: AuthService, useValue: { token: () => token } },
      ],
    });
    service = TestBed.inject(DossierService);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuse les appels sans session authentifiée', async () => {
    token = null;

    await expect(service.loadDossiers()).resolves.toBe(false);
    await expect(service.createDossier({ noDossier: 'DOS-001' })).resolves.toMatchObject({
      success: false,
      error: 'Session authentifiée introuvable.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('charge et mappe les dossiers avec pagination, recherche et lien prospect', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        dossiers: [{
          id: 'dossier-1',
          noDossier: 'DOS-001',
          prospectId: 'prospect-1',
          client: 'Client test',
          statut: 'ouvert',
          description: 'Suivi commercial',
          createdBy: 'user-1',
          createdAt: '2026-10-01T10:00:00Z',
          updatedAt: '2026-10-02T10:00:00Z',
        }],
        total: 12,
      }),
    });

    await expect(service.loadDossiers({ limit: 10, offset: 5, search: 'DOS-' })).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/dossiers?limit=10&offset=5&search=DOS-');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer mock-jwt-token' });
    expect(service.dossiers()[0]).toMatchObject({
      id: 'dossier-1',
      noDossier: 'DOS-001',
      prospectId: 'prospect-1',
      statut: 'ouvert',
    });
    expect(service.total()).toBe(12);
    expect(service.error()).toBeNull();
  });

  it('charge toutes les pages de dossiers pour remplir le sélecteur', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `dossier-${index}`,
      noDossier: `DOS-${index}`,
    }));
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isFirstPage = url.includes('offset=0');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          dossiers: isFirstPage ? firstPage : [{ id: 'dossier-100', noDossier: 'DOS-100' }],
          total: 101,
        }),
      } as Response;
    });

    await expect(service.loadAllDossiers()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('offset=100');
    expect(service.dossiers()).toHaveLength(101);
    expect(service.total()).toBe(101);
  });

  it('charge le résumé des dépenses par dossier', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        summaries: [{
          id: 'dossier-1',
          noDossier: 'DOS-001',
          client: 'Client test',
          expenseCount: 3,
          totalExpenses: 125000,
        }],
      }),
    });

    await expect(service.loadExpenseSummary()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('/api/dossiers/expenses', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer mock-jwt-token' }),
    }));
    expect(service.expenseSummary()).toMatchObject([{
      id: 'dossier-1',
      noDossier: 'DOS-001',
      client: 'Client test',
      expenseCount: 3,
      totalExpenses: 125000,
    }]);
  });

  it('expose une demande d’ouverture du formulaire consommable une seule fois', () => {
    expect(service.createModalRequested()).toBe(false);
    expect(service.consumeCreateModalRequest()).toBe(false);

    service.requestCreateModal();

    expect(service.createModalRequested()).toBe(true);
    expect(service.consumeCreateModalRequest()).toBe(true);
    expect(service.createModalRequested()).toBe(false);
    expect(service.consumeCreateModalRequest()).toBe(false);
  });

  it('crée un dossier en envoyant le prospect associé et met à jour la liste', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        dossier: {
          id: 'dossier-2',
          noDossier: 'DOS-002',
          prospectId: 'prospect-2',
          client: null,
          statut: 'ouvert',
          description: null,
          createdBy: 'user-1',
          createdAt: '2026-10-03T10:00:00Z',
          updatedAt: '2026-10-03T10:00:00Z',
        },
      }),
    });

    const result = await service.createDossier({
      noDossier: 'DOS-002',
      prospectId: 'prospect-2',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/dossiers', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ noDossier: 'DOS-002', prospectId: 'prospect-2' }),
    }));
    expect(result).toMatchObject({ success: true, data: { prospectId: 'prospect-2' } });
    expect(service.dossiers()[0].id).toBe('dossier-2');
    expect(service.total()).toBe(1);
  });

  it('expose le message API si la création échoue', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Ce numéro de dossier existe déjà.' }),
    });

    await expect(service.createDossier({ noDossier: 'DOS-001' })).resolves.toEqual({
      success: false,
      error: 'Ce numéro de dossier existe déjà.',
    });
    expect(service.total()).toBe(0);
  });
});