import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSupabaseAdmin = vi.fn();

vi.mock('./auth', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  clearServerProfileCache: vi.fn(),
}));

vi.mock('./profile', () => ({
  clearUserProfileResponseCache: vi.fn(),
}));

import {
  assignAccessRoleHandler,
  getRolePermissionsHandler,
  getUserAccessHandler,
  listAccessAuditHandler,
  replaceRolePermissionsHandler,
  revokeAccessRoleHandler,
  revokeUserPermissionOverrideHandler,
  setUserPermissionOverrideHandler,
} from './access-control.handlers';

const CALLER_UUID = '11111111-1111-4111-8111-111111111111';
const TARGET_UUID = '22222222-2222-4222-8222-222222222222';
const ROLE_UUID = '33333333-3333-4333-8333-333333333333';
const OVERRIDE_UUID = '44444444-4444-4444-8444-444444444444';

function createMockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status: vi.fn().mockImplementation(function (this: typeof res, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn().mockImplementation(function (this: typeof res, payload: unknown) {
      this.body = payload;
      return this;
    }),
  };
  return res;
}

function createMockReq(options: {
  user?: { id: string; role: string };
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}): express.Request {
  return {
    user: options.user,
    params: options.params ?? {},
    query: options.query ?? {},
    body: options.body ?? {},
  } as unknown as express.Request;
}

function createAdminClientMock(config: {
  roleKey?: string;
  targetProfileRole?: string;
} = {}) {
  const roleKey = config.roleKey ?? 'manager';
  const targetProfileRole = config.targetProfileRole ?? 'employe';

  return {
    rpc: vi.fn().mockResolvedValue({ data: { ok: true }, error: null }),
    from: vi.fn((table: string) => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(async () => {
          if (table === 'access_roles') {
            return { data: { id: ROLE_UUID, role_key: roleKey }, error: null };
          }
          if (table === 'profiles') {
            return { data: { id: TARGET_UUID, role: targetProfileRole }, error: null };
          }
          return { data: null, error: null };
        }),
      };
      return chain;
    }),
  };
}

describe('access-control.handlers — anti-élévation et validation UUID', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSupabaseAdmin.mockReturnValue(createAdminClientMock());
  });

  it('rejette les identifiants non-UUID avec HTTP 400', async () => {
    const res1 = createMockRes();
    await getRolePermissionsHandler(
      createMockReq({ params: { roleId: 'not-a-uuid' } }),
      res1 as unknown as express.Response
    );
    expect(res1.statusCode).toBe(400);

    const res2 = createMockRes();
    await getUserAccessHandler(
      createMockReq({ params: { userId: 'not-a-uuid' } }),
      res2 as unknown as express.Response
    );
    expect(res2.statusCode).toBe(400);

    const res3 = createMockRes();
    await listAccessAuditHandler(
      createMockReq({ query: { userId: 'bad-id' } }),
      res3 as unknown as express.Response
    );
    expect(res3.statusCode).toBe(400);
  });

  it('interdit à un non-admin de s’auto-attribuer un rôle (403)', async () => {
    const res = createMockRes();
    await assignAccessRoleHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { userId: CALLER_UUID },
        body: { roleId: ROLE_UUID },
      }),
      res as unknown as express.Response
    );
    expect(res.statusCode).toBe(403);
  });

  it('interdit à un non-admin d’attribuer le rôle admin à un tiers (403)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(createAdminClientMock({ roleKey: 'admin' }));
    const res = createMockRes();
    await assignAccessRoleHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { userId: TARGET_UUID },
        body: { roleId: ROLE_UUID },
      }),
      res as unknown as express.Response
    );
    expect(res.statusCode).toBe(403);
  });

  it('interdit à un non-admin de modifier ou révoquer le rôle d’un compte admin (403)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(createAdminClientMock({ roleKey: 'employe', targetProfileRole: 'admin' }));
    const resAssign = createMockRes();
    await assignAccessRoleHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { userId: TARGET_UUID },
        body: { roleId: ROLE_UUID },
      }),
      resAssign as unknown as express.Response
    );
    expect(resAssign.statusCode).toBe(403);

    const resRevoke = createMockRes();
    await revokeAccessRoleHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { userId: TARGET_UUID, roleId: ROLE_UUID },
      }),
      resRevoke as unknown as express.Response
    );
    expect(resRevoke.statusCode).toBe(403);
  });

  it('interdit à un non-admin de modifier les permissions du rôle admin ou d’attribuer access.* (403)', async () => {
    mockGetSupabaseAdmin.mockReturnValue(createAdminClientMock({ roleKey: 'admin' }));
    const resAdminRole = createMockRes();
    await replaceRolePermissionsHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { roleId: ROLE_UUID },
        body: { grants: [{ permissionKey: 'dossiers.read', scope: { type: 'all', version: 1 } }] },
      }),
      resAdminRole as unknown as express.Response
    );
    expect(resAdminRole.statusCode).toBe(403);

    mockGetSupabaseAdmin.mockReturnValue(createAdminClientMock({ roleKey: 'manager' }));
    const resPrivPerm = createMockRes();
    await replaceRolePermissionsHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { roleId: ROLE_UUID },
        body: { grants: [{ permissionKey: 'access.roles.manage', scope: { type: 'all', version: 1 } }] },
      }),
      resPrivPerm as unknown as express.Response
    );
    expect(resPrivPerm.statusCode).toBe(403);
  });

  it('interdit à un non-admin de définir ou révoquer un override sur soi-même, sur un admin ou sur access.* (403)', async () => {
    const resSelf = createMockRes();
    await setUserPermissionOverrideHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { userId: CALLER_UUID },
        body: { permissionKey: 'dossiers.read', effect: 'allow', scope: { type: 'all', version: 1 } },
      }),
      resSelf as unknown as express.Response
    );
    expect(resSelf.statusCode).toBe(403);

    const resPriv = createMockRes();
    await setUserPermissionOverrideHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { userId: TARGET_UUID },
        body: { permissionKey: 'access.users.assign_roles', effect: 'allow', scope: { type: 'all', version: 1 } },
      }),
      resPriv as unknown as express.Response
    );
    expect(resPriv.statusCode).toBe(403);

    mockGetSupabaseAdmin.mockReturnValue(createAdminClientMock({ targetProfileRole: 'admin' }));
    const resRevokeAdmin = createMockRes();
    await revokeUserPermissionOverrideHandler(
      createMockReq({
        user: { id: CALLER_UUID, role: 'manager' },
        params: { userId: TARGET_UUID, overrideId: OVERRIDE_UUID },
      }),
      resRevokeAdmin as unknown as express.Response
    );
    expect(resRevokeAdmin.statusCode).toBe(403);
  });
});
