import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin, resolveServerRole, updateExistingUserProfileRole } from './auth';

const createSupabaseMock = (profile: unknown, queryError: unknown = null) => {
  const maybeSingle = vi.fn().mockResolvedValue({ data: profile, error: queryError });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });

  return {
    client: { from } as unknown as SupabaseClient,
    from,
    select,
    eq,
    maybeSingle,
  };
};

describe('resolveServerRole', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the active profile role instead of stale app_metadata', async () => {
    const mock = createSupabaseMock({ role: 'tresorier', is_active: true });

    await expect(resolveServerRole(mock.client, {
      id: 'user-1',
      app_metadata: { role: 'admin' },
    })).resolves.toBe('tresorier');

    expect(mock.from).toHaveBeenCalledWith('profiles');
    expect(mock.select).toHaveBeenCalledWith('role, is_active');
    expect(mock.eq).toHaveBeenCalledWith('id', 'user-1');
  });

  it('denies inactive profiles even when app_metadata claims admin', async () => {
    const mock = createSupabaseMock({ role: 'admin', is_active: false });

    await expect(resolveServerRole(mock.client, {
      id: 'user-2',
      app_metadata: { role: 'admin' },
    })).resolves.toBeNull();
  });

  it('denies users without a profile or when the profile lookup fails', async () => {
    const missingProfile = createSupabaseMock(null);
    const failedLookup = createSupabaseMock(null, new Error('database unavailable'));

    await expect(resolveServerRole(missingProfile.client, {
      id: 'user-3',
      app_metadata: { role: 'manager' },
    })).resolves.toBeNull();
    await expect(resolveServerRole(failedLookup.client, {
      id: 'user-4',
      app_metadata: { role: 'manager' },
    })).resolves.toBeNull();
  });

  it('honors ADMIN_EMAILS only when the profile is active', async () => {
    vi.stubEnv('ADMIN_EMAILS', 'admin@example.com');
    const activeProfile = createSupabaseMock({ role: 'employe', is_active: true });
    const inactiveProfile = createSupabaseMock({ role: 'admin', is_active: false });

    await expect(resolveServerRole(activeProfile.client, {
      id: 'user-5',
      email: 'ADMIN@example.com',
    })).resolves.toBe('admin');
    await expect(resolveServerRole(inactiveProfile.client, {
      id: 'user-6',
      email: 'admin@example.com',
    })).resolves.toBeNull();
  });
});

describe('updateExistingUserProfileRole', () => {
  it('met à jour uniquement le rôle du profil existant sans passer par un insert', async () => {
    const eq = vi.fn().mockResolvedValue({ data: null, error: null });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    const client = { from } as unknown as SupabaseClient;

    await updateExistingUserProfileRole(client, 'user-7', 'admin', 'admin@example.com');

    expect(from).toHaveBeenCalledWith('profiles');
    expect(update).toHaveBeenCalledWith({
      role: 'admin',
      email: 'admin@example.com',
      updated_at: expect.any(String),
    });
    expect(eq).toHaveBeenCalledWith('id', 'user-7');
  });
});

describe('getSupabaseAdmin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reuses the admin client for the same server configuration', () => {
    vi.stubEnv('SUPABASE_URL', 'https://cache-test.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'cache-test-service-role-key');

    const firstClient = getSupabaseAdmin();
    const secondClient = getSupabaseAdmin();

    expect(firstClient).not.toBeNull();
    expect(secondClient).toBe(firstClient);
  });

  it('creates a new client when the server credentials change', () => {
    vi.stubEnv('SUPABASE_URL', 'https://credential-test.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'old-service-role-key');
    const firstClient = getSupabaseAdmin();

    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'new-service-role-key');
    const secondClient = getSupabaseAdmin();

    expect(secondClient).not.toBeNull();
    expect(secondClient).not.toBe(firstClient);
  });
});