import type { Options, Store, ClientRateLimitInfo } from 'express-rate-limit';

const INCREMENT_SCRIPT = `
local total = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if total == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = redis.call('PTTL', KEYS[1])
end
return { total, ttl }
`;

const GET_SCRIPT = `
local total = redis.call('GET', KEYS[1])
if not total then
  return { 0, -2 }
end
return { tonumber(total), redis.call('PTTL', KEYS[1]) }
`;

const DECREMENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local total = redis.call('DECR', KEYS[1])
if total <= 0 then
  redis.call('DEL', KEYS[1])
end
return total
`;

interface UpstashResult {
  result?: unknown;
  error?: unknown;
}

export class UpstashRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 0;
  private lastFailureLoggedAt = 0;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Pick<Options, 'windowMs'>): void {
    this.windowMs = options.windowMs;
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const [totalHits, ttl] = await this.runScript(GET_SCRIPT, key);
    if (totalHits === 0) return undefined;

    return {
      totalHits,
      resetTime: new Date(Date.now() + Math.max(0, ttl)),
    };
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const [totalHits, ttl] = await this.runScript(INCREMENT_SCRIPT, key, String(this.windowMs));
    return {
      totalHits,
      resetTime: new Date(Date.now() + Math.max(0, ttl)),
    };
  }

  async decrement(key: string): Promise<void> {
    const { endpoint, token } = this.getCredentials();
    const result = await this.executeCommand(endpoint, token, [
      'EVAL',
      DECREMENT_SCRIPT,
      '1',
      this.prefix + key,
    ]);
    const totalHits = Number(result);
    if (!Number.isSafeInteger(totalHits) || totalHits < 0) {
      throw new Error('Compteur invalide retourné par le store Upstash de limitation de débit.');
    }
  }

  async resetKey(key: string): Promise<void> {
    const { endpoint, token } = this.getCredentials();
    await this.executeCommand(endpoint, token, ['DEL', this.prefix + key]);
  }

  private async runScript(script: string, key: string, ...args: string[]): Promise<[number, number]> {
    const { endpoint, token } = this.getCredentials();
    const result = await this.executeCommand(endpoint, token, [
      'EVAL',
      script,
      '1',
      this.prefix + key,
      ...args,
    ]);
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('Réponse invalide du store Upstash de limitation de débit.');
    }

    const totalHits = Number(result[0]);
    const ttl = Number(result[1]);
    if (!Number.isSafeInteger(totalHits) || totalHits < 0 || !Number.isFinite(ttl)) {
      throw new Error('Compteurs invalides retournés par le store Upstash de limitation de débit.');
    }

    return [totalHits, ttl];
  }

  private getCredentials(): { endpoint: string; token: string } {
    const endpoint = process.env['UPSTASH_REDIS_REST_URL'];
    const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
    if (endpoint && token) return { endpoint, token };

    const error = new Error('UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN doivent être configurés.');
    this.reportFailure(error);
    throw error;
  }

  private async executeCommand(endpoint: string, token: string, command: string[]): Promise<unknown> {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        throw new Error(`Échec du store Upstash de limitation de débit (HTTP ${response.status}).`);
      }

      const payload = await response.json() as UpstashResult;
      if (payload.error !== undefined) {
        throw new Error(`Échec de la commande Upstash de limitation de débit: ${String(payload.error)}`);
      }
      if (this.lastFailureLoggedAt > 0) {
        console.info('[RATE_LIMIT_STORE] Connexion Upstash rétablie; les limites distribuées sont actives.');
        this.lastFailureLoggedAt = 0;
      }
      return payload.result;
    } catch (error: unknown) {
      this.reportFailure(error);
      throw error;
    }
  }

  private reportFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLoggedAt < 60_000) return;

    console.error(
      '[RATE_LIMIT_STORE] Upstash indisponible; les appels API continuent sans limite distribuée.',
      error
    );
    this.lastFailureLoggedAt = now;
  }
}
