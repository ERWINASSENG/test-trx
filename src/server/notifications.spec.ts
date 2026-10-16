import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response as ExpressResponse } from 'express';
import { createAppNotification } from './app-notifications';
import { getSupabaseAdmin } from './auth';
import {
  listAppNotificationsHandler,
  markAllAppNotificationsReadHandler,
  markAppNotificationReadHandler,
} from './notifications';

const userId = 'c0954185-ee6c-4252-8a40-20ef88d4ebc8';
const notificationId = '8f294938-ad1b-4160-b8ed-3626a8472c34';

const createResponse = (): ExpressResponse & {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} => {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as ExpressResponse & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
};

const createRequest = (values: Record<string, unknown> = {}): Request => ({
  params: {},
  ...values,
} as unknown as Request);

describe('persistent notification handlers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let testProjectNumber = 0;

  beforeEach(() => {
    testProjectNumber += 1;
    vi.stubEnv('SUPABASE_URL', `https://notifications-${testProjectNumber}.supabase.co`);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'PATCH') return new Response(null, { status: 204 });
      if (init?.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-range': '*/3' },
        });
      }
      return new Response(JSON.stringify([{
        id: notificationId,
        notification_type: 'assignment',
        title: 'Dossier attribué',
        message: 'Le dossier vous a été attribué.',
        href: '/dossiers',
        source_type: 'dossier',
        source_id: notificationId,
        read_at: null,
        created_at: '2026-10-15T10:00:00Z',
      }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists notifications and unread count only for the authenticated recipient', async () => {
    const response = createResponse();

    await listAppNotificationsHandler(createRequest({ user: { id: userId } }), response);

    expect(response.json).toHaveBeenCalledWith({
      notifications: [expect.objectContaining({ id: notificationId })],
      unreadCount: 3,
    });
    const queries = fetchMock.mock.calls.map((call) => new URL(String(call[0])).searchParams);
    expect(queries).toHaveLength(2);
    expect(queries.every((query) => query.get('recipient_id') === `eq.${userId}`)).toBe(true);
    expect(queries.some((query) => query.get('limit') === '50')).toBe(true);
    expect(queries.some((query) => query.get('read_at') === 'is.null')).toBe(true);
  });

  it('rejects an invalid notification ID before accessing the database', async () => {
    const response = createResponse();

    await markAppNotificationReadHandler(createRequest({
      params: { id: 'invalid' },
      user: { id: userId },
    }), response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks one notification read only when it belongs to the authenticated recipient', async () => {
    const response = createResponse();

    await markAppNotificationReadHandler(createRequest({
      params: { id: notificationId },
      user: { id: userId },
    }), response);

    const [url, init] = fetchMock.mock.calls[0];
    const requestUrl = new URL(String(url));
    expect(init?.method).toBe('PATCH');
    expect(requestUrl.searchParams.get('id')).toBe(`eq.${notificationId}`);
    expect(requestUrl.searchParams.get('recipient_id')).toBe(`eq.${userId}`);
    expect(requestUrl.searchParams.get('read_at')).toBe('is.null');
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });

  it('marks all unread notifications read only for the authenticated recipient', async () => {
    const response = createResponse();

    await markAllAppNotificationsReadHandler(createRequest({ user: { id: userId } }), response);

    const [url, init] = fetchMock.mock.calls[0];
    const requestUrl = new URL(String(url));
    expect(init?.method).toBe('PATCH');
    expect(requestUrl.searchParams.get('recipient_id')).toBe(`eq.${userId}`);
    expect(requestUrl.searchParams.get('read_at')).toBe('is.null');
    expect(response.json).toHaveBeenCalledWith({ success: true });
  });

  it('creates a notification with recipient-scoped idempotency', async () => {
    const admin = getSupabaseAdmin();
    if (!admin) throw new Error('Admin client was not initialized.');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(createAppNotification(admin, {
      recipientId: userId,
      actorId: null,
      notificationType: 'reminder',
      title: 'Relance à effectuer',
      message: 'La tâche arrive à échéance.',
      href: '/crm-commercial?view=activities',
      sourceType: 'sales_activity',
      sourceId: notificationId,
      dedupeKey: `sales-activity:${notificationId}:due`,
    })).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('on_conflict')).toBe('recipient_id,dedupe_key');
    expect(new Headers(init?.headers).get('Prefer')).toContain('resolution=ignore-duplicates');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      recipient_id: userId,
      source_id: notificationId,
      dedupe_key: `sales-activity:${notificationId}:due`,
    });
  });
});
