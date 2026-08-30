/**
 * A small TTL cache with LRU eviction — the parts of
 * `apps/extensions/utils/cache.ts` a sandboxed source actually needs.
 *
 * Deliberately smaller than the original: no background prune timer (the sandbox child is
 * killed and respawned often enough that a long-lived interval buys nothing) and no
 * stale-while-revalidate (a refresh running after the parent has already killed the child
 * is wasted work). Expired entries are dropped on read, and the size cap keeps memory
 * bounded — the child runs under `--max-old-space-size=256`.
 */
type Entry<V> = { value: V; expiresAt: number };

export class TTLCache<K, V> {
  private readonly store = new Map<K, Entry<V>>();
  private readonly inFlight = new Map<K, Promise<V>>();

  constructor(
    private readonly defaultTtlMs: number = 60_000,
    private readonly maxSize: number = 300,
  ) {}

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Re-insert so Map insertion order doubles as the LRU order.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V, ttlMs?: number): void {
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });

    while (this.store.size > this.maxSize) {
      const oldest = this.store.keys().next();
      if (oldest.done) {
        break;
      }
      this.store.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inFlight.clear();
  }

  /**
   * Returns the cached value, or computes and caches it. Concurrent callers for the same
   * key share one in-flight promise — without that, a browse page requesting several
   * pages at once would fire the same upstream request several times.
   */
  async getOrSet(key: K, factory: () => Promise<V>, ttlMs?: number): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const promise = factory()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }
}
