import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpstashRateLimitStore } from './upstash-rate-limit.store';

describe('UpstashRateLimitStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('increments a namespaced shared counter atomically and returns its reset time', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'test-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: [1, 60_000] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const store = new UpstashRateLimitStore('transmex:test:');
    store.init({ windowMs: 60_000 });
    const beforeRequest = Date.now();

    const result = await store.increment('203.0.113.7');

    expect(result.totalHits).toBe(1);
    if (!result.resetTime) throw new Error('Le store doit retourner une date de remise à zéro.');
    expect(result.resetTime.getTime()).toBeGreaterThanOrEqual(beforeRequest + 60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestOptions = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestOptions?.body).toContain('"transmex:test:203.0.113.7"');
    expect(requestOptions?.body).toContain('"60000"');
    expect(requestOptions?.headers).toEqual({
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    });
  });

  it('reports missing Upstash credentials instead of silently using process-local storage', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

    const store = new UpstashRateLimitStore('transmex:test:');
    store.init({ windowMs: 60_000 });

    await expect(store.increment('203.0.113.7')).rejects.toThrow(
      'UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN doivent être configurés.'
    );
  });
});
