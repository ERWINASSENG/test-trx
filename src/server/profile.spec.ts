import { describe, expect, it } from 'vitest';
import { getActiveAccessRole } from './profile';

describe('getActiveAccessRole', () => {
  it('returns the active dynamic role and ignores expired or inactive assignments', () => {
    const now = Date.parse('2026-10-09T12:00:00.000Z');

    expect(getActiveAccessRole([
      {
        created_at: '2026-10-01T00:00:00.000Z',
        expires_at: null,
        access_roles: { role_key: 'daf', label: 'DAF', is_active: true },
      },
      {
        created_at: '2026-10-02T00:00:00.000Z',
        expires_at: '2026-10-03T00:00:00.000Z',
        access_roles: { role_key: 'admin', label: 'Administrateur', is_active: true },
      },
      {
        created_at: '2026-10-08T00:00:00.000Z',
        expires_at: null,
        access_roles: { role_key: 'manager', label: 'Manager', is_active: false },
      },
    ], now)).toEqual({ customRole: 'daf', roleLabel: 'DAF' });
  });

  it('supports the array shape returned by a joined Supabase relation', () => {
    expect(getActiveAccessRole([{
      created_at: '2026-10-08T00:00:00.000Z',
      expires_at: null,
      access_roles: [{ role_key: 'daf', label: 'DAF', is_active: true }],
    }], Date.parse('2026-10-09T12:00:00.000Z'))).toEqual({
      customRole: 'daf',
      roleLabel: 'DAF',
    });
  });
});
