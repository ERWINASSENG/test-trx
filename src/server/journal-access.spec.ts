import { describe, expect, it, vi } from 'vitest';
import { getSupabaseAdmin } from './auth';
import { authorizeJournalOwnerWrite } from './journal-access';

const createAdminClient = (journal: Record<string, unknown> | null, error: unknown = null) => {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: journal, error }),
  };
  const client = {
    from: vi.fn().mockReturnValue(query),
  } as unknown as NonNullable<ReturnType<typeof getSupabaseAdmin>>;

  return { client, query };
};

describe('authorizeJournalOwnerWrite', () => {
  it('autorise un trésorier propriétaire du journal personnalisé', async () => {
    const { client, query } = createAdminClient({ created_by: 'user-1', sequence_prefix: 'BANK1' });

    await expect(authorizeJournalOwnerWrite(client, 'journal-1', 'tresorier', 'user-1'))
      .resolves.toEqual({ authorized: true });
    expect(query.eq).toHaveBeenCalledWith('id', 'journal-1');
  });

  it('refuse un journal appartenant à un autre trésorier', async () => {
    const { client } = createAdminClient({ created_by: 'user-2', sequence_prefix: 'BANK1' });

    await expect(authorizeJournalOwnerWrite(client, 'journal-1', 'tresorier', 'user-1'))
      .resolves.toMatchObject({ authorized: false, status: 403 });
  });

  it('refuse explicitement CSH1 même si le trésorier en est propriétaire', async () => {
    const { client } = createAdminClient({ created_by: 'user-1', sequence_prefix: 'CSH1' });

    await expect(authorizeJournalOwnerWrite(client, 'cash-journal', 'tresorier', 'user-1'))
      .resolves.toMatchObject({ authorized: false, status: 403 });
  });

  it('autorise l’administrateur sans lecture d’ownership', async () => {
    const { client, query } = createAdminClient(null);

    await expect(authorizeJournalOwnerWrite(client, 'cash-journal', 'admin', 'admin-1'))
      .resolves.toEqual({ authorized: true });
    expect(client.from).not.toHaveBeenCalled();
    expect(query.maybeSingle).not.toHaveBeenCalled();
  });

  it('refuse un rôle non autorisé avant tout accès à la base', async () => {
    const { client } = createAdminClient(null);

    await expect(authorizeJournalOwnerWrite(client, 'journal-1', 'manager', 'user-1'))
      .resolves.toMatchObject({ authorized: false, status: 403 });
    expect(client.from).not.toHaveBeenCalled();
  });

  it('échoue fermé si le propriétaire ne peut pas être vérifié', async () => {
    const { client } = createAdminClient(null, new Error('database unavailable'));

    await expect(authorizeJournalOwnerWrite(client, 'journal-1', 'tresorier', 'user-1'))
      .resolves.toMatchObject({ authorized: false, status: 500 });
  });

  it('refuse une requête sans identifiant utilisateur', async () => {
    const { client } = createAdminClient({ created_by: 'user-1', sequence_prefix: 'BANK1' });

    await expect(authorizeJournalOwnerWrite(client, 'journal-1', 'tresorier', undefined))
      .resolves.toMatchObject({ authorized: false, status: 401 });
    expect(client.from).not.toHaveBeenCalled();
  });
});