import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response as ExpressResponse } from 'express';
import { createDossierHandler, listDossiersHandler } from './dossiers';

interface QueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
  count?: number | null;
}

const createResponse = (): ExpressResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } => {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as ExpressResponse & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
};

const createRequest = (values: Record<string, unknown> = {}): Request => ({
  query: {},
  body: {},
  ip: '127.0.0.1',
  ...values,
} as unknown as Request);

describe('dossier handlers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let testProjectNumber = 0;

  beforeEach(() => {
    testProjectNumber += 1;
    vi.stubEnv('SUPABASE_URL', `https://test-project-${testProjectNumber}.supabase.co`);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method || 'GET';
      if (url.pathname.endsWith('/dossiers') && method === 'GET') {
        const rows = url.searchParams.get('no_dossier')?.startsWith('eq.')
          ? []
          : [{
            id: 'dossier-1',
            no_dossier: 'DOS-001',
            client: 'Client test',
            statut: 'ouvert',
            description: 'Dossier de test',
            created_by: 'user-1',
            created_at: '2026-10-01T10:00:00Z',
            updated_at: '2026-10-01T10:00:00Z',
          }];
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-range': '0-0/1' },
        });
      }
      if (url.pathname.endsWith('/dossiers') && method === 'POST') {
        return new Response(JSON.stringify({
          id: 'dossier-2',
          no_dossier: 'DOS-002',
          client: null,
          statut: 'ouvert',
          description: null,
          created_by: 'user-1',
          created_at: '2026-10-02T10:00:00Z',
          updated_at: '2026-10-02T10:00:00Z',
        }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  const stubProspectLinkRequests = (
    role: string,
    prospectExists = true,
    dossierAlreadyExists = false
  ): void => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method || 'GET';
      if (url.pathname.endsWith('/profiles')) {
        return new Response(JSON.stringify([{ id: 'user-1', role, is_active: true }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/access_user_roles') || url.pathname.endsWith('/access_user_overrides')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.pathname.endsWith('/prospects')) {
        const prospects = prospectExists ? [{
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Prospect test',
          company_name: 'Client de test',
        }] : [];
        return new Response(JSON.stringify(prospects), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/dossiers') && method === 'GET') {
        const duplicateLookup = url.searchParams.get('no_dossier')?.startsWith('eq.');
        const dossiers = dossierAlreadyExists && duplicateLookup ? [{ id: 'dossier-existing' }] : [];
        return new Response(JSON.stringify(dossiers), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/dossiers') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: 'dossier-linked',
          ...body,
          statut: 'ouvert',
          created_at: '2026-10-03T10:00:00Z',
          updated_at: '2026-10-03T10:00:00Z',
        }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists dossiers with bounded pagination and search', async () => {
    const response = createResponse();

    await listDossiersHandler(createRequest({
      query: { limit: '25', offset: '10', search: 'DOS-' },
    }), response);

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toBe('/rest/v1/dossiers');
    expect(requestUrl.searchParams.get('limit')).toBe('25');
    expect(requestUrl.searchParams.get('offset')).toBe('10');
    expect(requestUrl.searchParams.get('no_dossier')).toBe('ilike.%DOS-%');
    expect(response.json).toHaveBeenCalledWith({
      dossiers: [{
        id: 'dossier-1',
        noDossier: 'DOS-001',
        client: 'Client test',
        statut: 'ouvert',
        description: 'Dossier de test',
        createdBy: 'user-1',
        createdAt: '2026-10-01T10:00:00Z',
        updatedAt: '2026-10-01T10:00:00Z',
      }],
      total: 1,
      limit: 25,
      offset: 10,
    });
  });

  it('rejects an empty dossier number without querying the database', async () => {
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: { noDossier: '  ' },
      user: { id: 'user-1' },
    }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'Le numéro de dossier doit contenir entre 1 et 100 caractères.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an authenticated actor before creating a dossier', async () => {
    const response = createResponse();

    await createDossierHandler(createRequest({ body: { noDossier: 'DOS-001' } }), response);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a dossier number that already exists', async () => {
    stubProspectLinkRequests('admin', true, true);
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: {
        noDossier: 'DOS-001',
        prospectId: '11111111-1111-4111-8111-111111111111',
      },
      user: { id: 'user-1', role: 'admin' },
    }), response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(fetchMock.mock.calls.some((call) =>
      new URL(String(call[0])).pathname.endsWith('/dossiers') && call[1]?.method === 'POST'
    )).toBe(false);
  });

  it('creates and audits a dossier with a trimmed number', async () => {
    stubProspectLinkRequests('admin');
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: {
        noDossier: ' DOS-002 ',
        prospectId: '11111111-1111-4111-8111-111111111111',
      },
      user: { id: 'user-1', email: 'user@example.test', role: 'admin' },
    }), response);

    const insertRequest = fetchMock.mock.calls.find((call) => {
      const url = new URL(String(call[0]));
      return url.pathname.endsWith('/dossiers') && call[1]?.method === 'POST';
    });
    expect(JSON.parse(String(insertRequest?.[1]?.body))).toEqual({
      no_dossier: 'DOS-002',
      client: 'Client de test',
      description: null,
      created_by: 'user-1',
      prospect_id: '11111111-1111-4111-8111-111111111111',
    });
    const auditRequest = fetchMock.mock.calls.find((call) => new URL(String(call[0])).pathname.endsWith('/audit_logs'));
    expect(JSON.parse(String(auditRequest?.[1]?.body))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'CREATE_DOSSIER',
        entity_type: 'dossier',
        entity_id: 'dossier-linked',
      }),
    ]));
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith({
      dossier: {
        id: 'dossier-linked',
        prospectId: '11111111-1111-4111-8111-111111111111',
        noDossier: 'DOS-002',
        client: 'Client de test',
        statut: 'ouvert',
        description: null,
        createdBy: 'user-1',
        createdAt: '2026-10-03T10:00:00Z',
        updatedAt: '2026-10-03T10:00:00Z',
      },
    });
  });

  it('rejects an invalid prospect ID before making database requests', async () => {
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: { noDossier: 'DOS-003', prospectId: 'not-a-uuid' },
      user: { id: 'user-1', role: 'manager' },
    }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'La sélection d’un prospect valide est obligatoire.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses dossier creation when no prospect is selected', async () => {
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: { noDossier: 'DOS-007' },
      user: { id: 'user-1', role: 'admin' },
    }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: 'La sélection d’un prospect valide est obligatoire.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to associate a prospect when the actor lacks prospect read permission', async () => {
    stubProspectLinkRequests('caissiere');
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: {
        noDossier: 'DOS-004',
        prospectId: '11111111-1111-4111-8111-111111111111',
      },
      user: { id: 'user-1', role: 'caissiere' },
    }), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(fetchMock.mock.calls.some((call) => new URL(String(call[0])).pathname.endsWith('/dossiers'))).toBe(false);
  });

  it('refuses to associate a prospect that does not exist', async () => {
    stubProspectLinkRequests('manager', false);
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: {
        noDossier: 'DOS-005',
        prospectId: '11111111-1111-4111-8111-111111111111',
      },
      user: { id: 'user-1', role: 'manager' },
    }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: 'Le prospect sélectionné est introuvable.' });
    expect(fetchMock.mock.calls.some((call) =>
      new URL(String(call[0])).pathname.endsWith('/dossiers') && call[1]?.method === 'POST'
    )).toBe(false);
  });

  it('creates a dossier linked to an existing prospect for an authorized manager', async () => {
    stubProspectLinkRequests('manager');
    const response = createResponse();

    await createDossierHandler(createRequest({
      body: {
        noDossier: 'DOS-006',
        prospectId: '11111111-1111-4111-8111-111111111111',
      },
      user: { id: 'user-1', role: 'manager' },
    }), response);

    const insertRequest = fetchMock.mock.calls.find((call) =>
      new URL(String(call[0])).pathname.endsWith('/dossiers') && call[1]?.method === 'POST'
    );
    expect(JSON.parse(String(insertRequest?.[1]?.body))).toMatchObject({
      no_dossier: 'DOS-006',
      client: 'Client de test',
      prospect_id: '11111111-1111-4111-8111-111111111111',
      created_by: 'user-1',
    });
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith({
      dossier: expect.objectContaining({
        id: 'dossier-linked',
        noDossier: 'DOS-006',
        prospectId: '11111111-1111-4111-8111-111111111111',
      }),
    });
  });
});