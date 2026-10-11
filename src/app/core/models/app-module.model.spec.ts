import { describe, expect, it } from 'vitest';
import { APP_MODULES, isAppModuleVisibleToPermissions } from './app-module.model';

describe('app module visibility permissions', () => {
  const accountingModule = APP_MODULES.find((module) => module.id === 'comptabilite')!;

  it('does not use a data permission to decide whether a module tile is visible', () => {
    expect(isAppModuleVisibleToPermissions(accountingModule, [{
      permissionKey: 'cashier.read',
      scope: { type: 'all', version: 1 },
      effect: 'allow',
    }])).toBe(false);
  });

  it('shows the module only when its dedicated visibility permission is allowed', () => {
    expect(isAppModuleVisibleToPermissions(accountingModule, [{
      permissionKey: 'module.accounting.view',
      scope: { type: 'all', version: 1 },
      effect: 'allow',
    }])).toBe(true);

    expect(isAppModuleVisibleToPermissions(accountingModule, [
      {
        permissionKey: 'module.accounting.view',
        scope: { type: 'all', version: 1 },
        effect: 'allow',
      },
      {
        permissionKey: 'module.accounting.view',
        scope: { type: 'all', version: 1 },
        effect: 'deny',
      },
    ])).toBe(false);
  });
});
