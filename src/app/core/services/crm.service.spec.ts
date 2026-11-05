import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { CrmService } from './crm.service';

describe('CrmService - gestion des erreurs API', () => {
  let service: CrmService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [
        CrmService,
        {
          provide: AuthService,
          useValue: {
            currentUser: signal({ id: 'crm-user' }),
            token: signal('test-token'),
            handleUnauthorizedSession: vi.fn(),
          },
        },
      ],
    });
    service = TestBed.inject(CrmService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('charge les données CRM depuis une réponse valide', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      clients: [],
      contacts: [],
      opportunities: [],
      activities: [],
      campaigns: [],
      canManageTeam: false,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(service.load()).resolves.toBe(true);

    expect(service.clients()).toEqual([]);
    expect(service.error()).toBeNull();
  });

  it('conserve le motif métier renvoyé par l’API CRM', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: 'Un client existe déjà avec cette adresse e-mail.',
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.createClient({
      companyName: 'Client Exemple',
      contactName: 'Amina Exemple',
      contactRole: 'Achats',
      email: 'amina@example.com',
      phone: '',
      country: 'Cameroun',
      sector: 'Logistique',
    });

    expect(result).toEqual({
      success: false,
      error: 'Un client existe déjà avec cette adresse e-mail.',
    });
  });

  it('distingue une panne réseau d’une erreur HTTP', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(service.load()).resolves.toBe(false);

    expect(service.error()).toBe(
      'Connexion au service CRM impossible pour charger les données CRM. Vérifiez votre connexion puis réessayez.'
    );
  });

  it('signale une réponse invalide sans la traiter comme un aperçu CRM vide', async () => {
    fetchMock.mockResolvedValue(new Response('null', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(service.load()).resolves.toBe(false);

    expect(service.clients()).toEqual([]);
    expect(service.error()).toBe('Le service CRM a renvoyé une réponse invalide.');
  });
});
