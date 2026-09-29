import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveServerRole } from './auth';

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