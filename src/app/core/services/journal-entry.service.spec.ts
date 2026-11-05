import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JournalEntryService } from './journal-entry.service';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';

describe('JournalEntryService', () => {
  let service: JournalEntryService;
  let fetchMock: ReturnType<typeof vi.fn>;
  let notifications: { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    fetchMock = vi.fn();
    notifications = { success: vi.fn(), error: vi.fn() };
    vi.stubGlobal('fetch', fetchMock);

    TestBed.configureTestingModule({
      providers: [
        JournalEntryService,
        {
          provide: SupabaseService,
          useValue: { supabase: null },
        },
        {
          provide: AuthService,
          useValue: { token: () => 'test-token' },
        },
        {
          provide: NotificationService,
          useValue: notifications,
        },
      ],
    });
    service = TestBed.inject(JournalEntryService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  it('charge les écritures du journal et les ajoute au signal', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      entries: [{
        id: 'entry-1',
        journal_id: 'journal-1',
        sequence_number: 1,
        piece_comptable: 'BNK1/2026/00001',
        date: '2026-10-17',
        libelle: 'Versement client',
        category: 'entree',
        status: 'draft',
        montant: 12500,
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.loadEntries('journal-1');

    expect(result).toHaveLength(1);
    expect(result[0].libelle).toBe('Versement client');
    expect(service.entries()).toEqual(result);
    expect(service.isLoading()).toBe(false);
  });

  it('affiche le motif métier de l’API lors du chargement refusé', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: 'Vous ne pouvez pas consulter les écritures de ce journal.',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(service.loadEntries('journal-1')).resolves.toEqual([]);

    expect(notifications.error).toHaveBeenCalledWith(
      'Vous ne pouvez pas consulter les écritures de ce journal.',
      'Chargement impossible'
    );
  });

  it('signale une panne réseau lors du chargement', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(service.loadEntries('journal-1')).resolves.toEqual([]);

    expect(notifications.error).toHaveBeenCalledWith(
      'Connexion au service des écritures impossible. Vérifiez votre connexion puis réessayez.',
      'Chargement impossible'
    );
    expect(service.isLoading()).toBe(false);
  });

  it('signale une liste d’écritures invalide dans une réponse réussie', async () => {
    fetchMock.mockResolvedValue(new Response('null', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(service.loadEntries('journal-1')).resolves.toEqual([]);

    expect(notifications.error).toHaveBeenCalledWith(
      'Le serveur a renvoyé une liste d’écritures invalide.',
      'Chargement impossible'
    );
  });

  it('conserve le motif métier lors du refus de création', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      message: 'Le montant de cette écriture dépasse le solde autorisé.',
    }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await service.createEntry({
      journal_id: 'journal-1',
      libelle: 'Paiement fournisseur',
      category: 'sortie',
      montant: -50000,
    });

    expect(result).toBeNull();
    expect(notifications.error).toHaveBeenCalledWith(
      'Le montant de cette écriture dépasse le solde autorisé.',
      'Échec de saisie'
    );
    expect(service.isSubmitting()).toBe(false);
  });

  it('distingue une panne réseau lors de la création', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await service.createEntry({
      journal_id: 'journal-1',
      libelle: 'Paiement fournisseur',
      category: 'sortie',
      montant: -50000,
    });

    expect(result).toBeNull();
    expect(notifications.error).toHaveBeenCalledWith(
      'Connexion au service comptable impossible pour enregistrer l’écriture. Vérifiez votre connexion puis réessayez.',
      'Échec de saisie'
    );
    expect(service.isSubmitting()).toBe(false);
  });
});
