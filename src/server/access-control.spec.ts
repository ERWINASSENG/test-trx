import { describe, expect, it } from 'vitest';
import { AccessScope } from '../app/core/models/access-control.model';
import { hasPermission, registerAccessScopeEvaluator } from './access-control';

describe('hasPermission', () => {
  it('autorise un grant de rôle dont le scope all correspond', async () => {
    const allowed = await hasPermission(
      'user-1',
      'cashier.read',
      undefined,
      {
        roleKeys: ['manager'],
        rules: [{
          permissionKey: 'cashier.read',
          effect: 'allow',
          scope: { type: 'all', version: 1 },
          isUserOverride: false,
          sourceRoleKey: 'manager',
        }],
      }
    );

    expect(allowed).toBe(true);
  });

  it('autorise la caissière à modifier le statut d’une opération', async () => {
    const allowed = await hasPermission(
      'cashier-user',
      'cashier.status_update',
      undefined,
      { roleKeys: ['caissiere'], rules: [] }
    );

    expect(allowed).toBe(true);
    await expect(hasPermission(
      'cashier-user',
      'cashier.update',
      undefined,
      { roleKeys: ['caissiere'], rules: [] }
    )).resolves.toBe(true);
  });

  it('refuse la modification de statut aux rôles sans ce droit', async () => {
    const allowed = await hasPermission(
      'accountant-user',
      'cashier.status_update',
      undefined,
      { roleKeys: ['comptable'], rules: [] }
    );

    expect(allowed).toBe(false);
    await expect(hasPermission(
      'accountant-user',
      'cashier.update',
      undefined,
      { roleKeys: ['comptable'], rules: [] }
    )).resolves.toBe(false);
  });

  it('fait primer le refus individuel sur le fallback caissière', async () => {
    const allowed = await hasPermission(
      'cashier-user',
      'cashier.status_update',
      undefined,
      {
        roleKeys: ['caissiere'],
        rules: [{
          permissionKey: 'cashier.status_update',
          effect: 'deny',
          scope: { type: 'all', version: 1 },
          isUserOverride: true,
        }],
      }
    );

    expect(allowed).toBe(false);
  });

  it('applique le scope owner uniquement à la ressource possédée', async () => {
    const rules = {
      roleKeys: ['tresorier'],
      rules: [{
        permissionKey: 'journal_entries.create',
        effect: 'allow' as const,
        scope: { type: 'owner', version: 1 },
        isUserOverride: false,
        sourceRoleKey: 'tresorier',
      }],
    };

    await expect(hasPermission('user-1', 'journal_entries.create', { ownerUserId: 'user-1' }, rules))
      .resolves.toBe(true);
    await expect(hasPermission('user-1', 'journal_entries.create', { ownerUserId: 'user-2' }, rules))
      .resolves.toBe(false);
  });

  it('fait primer un refus individuel sur un grant de rôle', async () => {
    const allowed = await hasPermission(
      'user-1',
      'cashier.read',
      undefined,
      {
        roleKeys: ['manager'],
        rules: [
          {
            permissionKey: 'cashier.read',
            effect: 'allow',
            scope: { type: 'all', version: 1 },
            isUserOverride: false,
            sourceRoleKey: 'manager',
          },
          {
            permissionKey: 'cashier.read',
            effect: 'deny',
            scope: { type: 'all', version: 1 },
            isUserOverride: true,
          },
        ],
      }
    );

    expect(allowed).toBe(false);
  });

  it('refuse un type de scope non enregistré', async () => {
    const allowed = await hasPermission(
      'user-1',
      'cashier.read',
      undefined,
      {
        roleKeys: ['custom'],
        rules: [{
          permissionKey: 'cashier.read',
          effect: 'allow',
          scope: { type: 'future_scope', version: 1 } as AccessScope,
          isUserOverride: false,
          sourceRoleKey: 'custom',
        }],
      }
    );

    expect(allowed).toBe(false);
  });

  it('permet d’ajouter un évaluateur serveur pour un nouveau contexte', async () => {
    registerAccessScopeEvaluator('project_member', (_scope, actor, resource) => {
      const memberIds = resource?.['memberIds'];
      return Array.isArray(memberIds) && memberIds.includes(actor.userId);
    });

    const allowed = await hasPermission(
      'user-1',
      'project.read',
      { memberIds: ['user-1', 'user-2'] },
      {
        roleKeys: ['project_member'],
        rules: [{
          permissionKey: 'project.read',
          effect: 'allow',
          scope: { type: 'project_member', version: 1 },
          isUserOverride: false,
          sourceRoleKey: 'project_member',
        }],
      }
    );

    expect(allowed).toBe(true);
  });

  it('autorise un rôle personnalisé comme DAF avec ses permissions dédiées', async () => {
    const allowed = await hasPermission(
      'user-daf',
      'journals.read',
      undefined,
      {
        roleKeys: ['daf'],
        rules: [
          {
            permissionKey: 'journals.read',
            effect: 'allow',
            scope: { type: 'all', version: 1 },
            isUserOverride: false,
            sourceRoleKey: 'daf',
          },
          {
            permissionKey: 'cashier.read',
            effect: 'allow',
            scope: { type: 'all', version: 1 },
            isUserOverride: false,
            sourceRoleKey: 'daf',
          },
        ],
      }
    );

    expect(allowed).toBe(true);
  });
});