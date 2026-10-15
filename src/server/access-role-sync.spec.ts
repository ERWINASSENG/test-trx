import { describe, expect, it, vi } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { syncUserAccessRole } from './access-role-sync';

function createQuery(result: { data: unknown; error: { message: string } | null }) {
  const promise = Promise.resolve(result);
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return query;
}

function createClient(
  roleData: unknown,
  profileData: unknown,
  assignmentsData: unknown
): SupabaseClient {
  const queries = {
    access_roles: createQuery({ data: roleData, error: null }),
    profiles: createQuery({ data: profileData, error: null }),
    access_user_roles: createQuery({ data: assignmentsData, error: null }),
  };
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const client = {
    from: vi.fn((table: keyof typeof queries) => queries[table]),
    rpc,
  };
  return client as unknown as SupabaseClient;
}

describe('syncUserAccessRole', () => {
  it('does not call the synchronization RPC when the role is already synchronized', async () => {
    const client = createClient(
      { id: 'role-1' },
      { role: 'tresorier' },
      [{ role_id: 'role-1', assignment_source: 'legacy_profile', expires_at: null }]
    );

    await syncUserAccessRole(client, 'user-1', 'tresorier', 'user-1', 'legacy_profile');

    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('calls the synchronization RPC when the requested role is not assigned', async () => {
    const client = createClient(
      { id: 'role-1' },
      { role: 'employe' },
      [{ role_id: 'role-2', assignment_source: 'legacy_profile', expires_at: null }]
    );

    await syncUserAccessRole(client, 'user-1', 'tresorier', 'user-1', 'legacy_profile');

    expect(client.rpc).toHaveBeenCalledWith('sync_user_primary_role', {
      p_actor_user_id: 'user-1',
      p_user_id: 'user-1',
      p_role_key: 'tresorier',
      p_exclusive: false,
    });
  });
});
