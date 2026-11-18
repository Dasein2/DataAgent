/** Bounded identity-scoped TTL cache. Coalesces duplicate in-flight metadata requests. */
export class TtlCache {
  private readonly entries = new Map<string, { until: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private generation = 0;
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
  ) {}

  async get<T>(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
    if (refresh) this.entries.delete(key);
    const entry = this.entries.get(key);
    if (entry && entry.until > Date.now()) return structuredClone(entry.value) as T;
    const existing = this.pending.get(key);
    if (existing) return structuredClone(await existing) as T;
    const generation = this.generation;
    const promise = load();
    this.pending.set(key, promise);
    try {
      const value = await promise;
      if (generation === this.generation && this.ttlMs > 0) {
        this.entries.delete(key);
        this.entries.set(key, {
          until: Date.now() + this.ttlMs,
          value: structuredClone(value),
        });
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      }
      return structuredClone(value);
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
  }
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
  }
}
