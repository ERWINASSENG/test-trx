import { describe, expect, it } from 'vitest';
import {
  createAccessRulesLoader,
  type LoadedAccessRules,
} from './access-control';

describe('concurrent access-rule loading', () => {
  it('shares only in-flight database reads for the same user', async () => {
    let completeRead!: (result: LoadedAccessRules | null) => void;
    const databaseRead = new Promise<LoadedAccessRules | null>((resolve) => {
      completeRead = resolve;
    });
    let readCount = 0;
    const profiles: ({ role: string; is_active: boolean } | null | undefined)[] = [];
    const loadFromDatabase = (
      _userId: string,
      profile?: { role: string; is_active: boolean } | null
    ) => {
      readCount += 1;
      profiles.push(profile);
      return databaseRead;
    };
    const load = createAccessRulesLoader(loadFromDatabase);
    const profile = { role: 'admin', is_active: true };

    const first = load('shared-user', profile);
    const concurrent = load('shared-user', profile);

    expect(readCount).toBe(1);
    expect(first).toBe(concurrent);

    completeRead({ roleKeys: ['admin'], rules: [], hasActiveRoleAssignments: true });
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(firstResult).toEqual(concurrentResult);
    await expect(load('shared-user')).resolves.toEqual({
      roleKeys: ['admin'],
      rules: [],
      hasActiveRoleAssignments: true,
    });
    expect(readCount).toBe(2);
    expect(profiles).toEqual([profile, undefined]);
  });
});
