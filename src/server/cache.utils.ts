/**
 * Utilitaire de cache mémoire borné (Bounded LRU Cache)
 * Conforme à la règle de sécurité S11 :
 * - Taille maximale strictement bornée (défaut : 500 entrées) pour prévenir le déni de service mémoire (DoS OOM).
 * - Éviction automatique du plus ancien élément utilisé (Least Recently Used - LRU) dès que le plafond est atteint.
 * - Gestion granulaire du TTL (Time To Live) par entrée avec nettoyage automatique des données expirées.
 */

export interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface BoundedCacheOptions {
  maxSize?: number;
  defaultTtlMs?: number;
}

export class BoundedCache<K, V> {
  private readonly map = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(options?: BoundedCacheOptions) {
    const max = options?.maxSize ?? 500;
    this.maxSize = Number.isSafeInteger(max) && max > 0 ? max : 500;
    const ttl = options?.defaultTtlMs ?? 60_000;
    this.defaultTtlMs = Number.isSafeInteger(ttl) && ttl > 0 ? ttl : 60_000;
  }

  public get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    const now = Date.now();
    if (now > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Réordonnancement LRU : réinsérer la clé pour qu'elle devienne la plus récemment consultée
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  public set(key: K, value: V, ttlMs?: number): void {
    const effectiveTtl = (ttlMs !== undefined && Number.isSafeInteger(ttlMs) && ttlMs > 0)
      ? ttlMs
      : this.defaultTtlMs;
    const expiresAt = Date.now() + effectiveTtl;

    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Éviction LRU : suppression du premier élément (le plus ancien / moins récemment accédé)
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(key, { value, expiresAt });
  }

  public has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: K): boolean {
    return this.map.delete(key);
  }

  public clear(): void {
    this.map.clear();
  }

  public get size(): number {
    return this.map.size;
  }
}

