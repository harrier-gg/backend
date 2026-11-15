/**
 * Counts failures per key in a time window. Bounded: when it is full of live counters, unknown
 * keys count as blocked (fail closed) instead of pushing out counters that protect real accounts.
 * ponytail: in memory of this instance; a shared store when identity scales out.
 */
export class FailureLimit {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) return entry.count >= this.limit;
    if (this.entries.size < this.maxKeys) return false;
    for (const [k, v] of this.entries) if (v.resetAt <= now) this.entries.delete(k);
    return this.entries.size >= this.maxKeys;
  }

  fail(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) entry.count++;
    else this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  /** Takes back a failure that wasn't one (the request was turned away before checking). */
  forgive(key: string) {
    const entry = this.entries.get(key);
    if (entry && --entry.count <= 0) this.entries.delete(key);
  }

  clear(key: string) {
    this.entries.delete(key);
  }
}

/** IPv6 clients usually own a whole /64; limiting single addresses would be easy to dodge. */
export function clientKey(address: string | undefined): string {
  if (!address) return '';
  const plain = address.replace(/^::ffff:/, '');
  return plain.includes(':') ? `${plain.split(':').slice(0, 4).join(':')}::/64` : plain;
}
