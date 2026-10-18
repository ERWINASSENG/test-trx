import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { ProspectService } from './prospect.service';

describe('ProspectService - gestion des erreurs API', () => {
  let service: ProspectService;
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    TestBed.configureTestingModule({
      providers: [
        ProspectService,
        {
          provide: AuthService,
          useValue: {
            currentUser: () => ({ id: 'user-1' }),
            token: () => 'test-token',
            refreshAccessTokenAfterUnauthorized: vi.fn().mockResolvedValue({ status: 'unavailable' }),
            handleUnauthorizedSession: vi.fn(),
          },
        },
      ],
    });
    service = TestBed.inject(ProspectService);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    TestBed.resetTestingModule();
  });

  it('charge les prospects depuis une réponse valide', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      prospects: [{ id: 'prospect-1', name: 'Client Exemple', status: 'new' }],
      total: 1,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const loaded = await service.loadProspects();

    expect(loaded).toBe(true);
    expect(service.prospects()).toHaveLength(1);
    expect(service.prospects()[0].id).toBe('prospect-1');
    expect(service.total()).toBe(1);
    expect(service.error()).toBeNull();
  });

  it('affiche le motif métier renvoyé par l’API lors d’un échec HTTP', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: 'Un prospect portant cette adresse e-mail existe déjà.',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.createProspect({ companyName: 'Client Exemple' });

    expect(result).toEqual({
      success: false,
      error: 'Un prospect portant cette adresse e-mail existe déjà.',
    });
  });

  it('distingue une erreur de connexion d’un refus HTTP', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const loaded = await service.loadProspects();

    expect(loaded).toBe(false);
    expect(service.error()).toBe(
      'Connexion au service Contacts impossible. Vérifiez votre connexion puis réessayez.'
    );
  });

  it('signale une réponse invalide au lieu de la traiter comme une liste vide', async () => {
    fetchMock.mockResolvedValue(new Response('null', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const loaded = await service.loadProspects();

    expect(loaded).toBe(false);
    expect(service.prospects()).toEqual([]);
    expect(service.error()).toBe('Le service Contacts a renvoyé une réponse invalide.');
  });
});
