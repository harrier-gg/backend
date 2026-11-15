import { isIPv4, isIPv6 } from 'node:net';

/**
 * Counts failures per key in a time window. Bounded: when full, expired counters go first, then
 * the one with the fewest failures. A flood of one-off guesses can neither fill the memory nor
 * push out a counter that is being attacked, and nobody is locked out because the map is full.
 * ponytail: in memory of this instance; a shared store when identity scales out.
 */
export class FailureLimit {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Failures of `key` in the current window. */
  count(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    return entry && entry.resetAt > now ? entry.count : 0;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.count(key, now) >= this.limit;
  }

  fail(key: string, now = Date.now()) {
    const entry = this.entries.get(key);
    if (entry && entry.resetAt > now) return void entry.count++;
    if (!entry && this.entries.size >= this.maxKeys) this.makeRoom(now);
    this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  // Evicting a counter with n failures takes maxKeys counters with more failures inside one window
  // (10,000 × n checked passwords, each a slow hash), which the hashing limit makes impossible.
  private makeRoom(now: number) {
    for (const [k, v] of this.entries) if (v.resetAt <= now) this.entries.delete(k);
    if (this.entries.size < this.maxKeys) return;
    let fewest: string | undefined;
    for (const [k, v] of this.entries) if (fewest === undefined || v.count < this.entries.get(fewest)!.count) fewest = k;
    this.entries.delete(fewest!);
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

/**
 * The client address to limit by, or null without a usable one. IPv6 clients usually own a whole
 * /64, so limiting single addresses would be easy to dodge.
 */
export function clientKey(address: string | undefined): string | null {
  const plain = address?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!plain) return null;
  if (isIPv4(plain)) return plain;
  if (!isIPv6(plain) || plain.includes('.')) return null;
  const [head, tail] = plain.toLowerCase().split('::');
  const [front, back] = [head ? head.split(':') : [], tail ? tail.split(':') : []];
  const groups = tail === undefined ? front : [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
