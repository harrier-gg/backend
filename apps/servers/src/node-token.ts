import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Agent tokens (ADR 0004): "hrr_<nodeId>_<secret>". Only SHA-256(secret) is stored.
const PREFIX = 'hrr_';
const TOKEN = /^hrr_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export function newSecret(): { secret: string; hash: Uint8Array<ArrayBuffer> } {
  const secret = randomBytes(32).toString('base64url'); // 256 bits → 43 characters
  return { secret, hash: hashSecret(secret) };
}

export function formatToken(nodeId: string, secret: string): string {
  return `${PREFIX}${nodeId}_${secret}`;
}

export function parseToken(token: string): { nodeId: string; secret: string } | null {
  const match = TOKEN.exec(token);
  return match ? { nodeId: match[1], secret: match[2] } : null;
}

export function hashSecret(secret: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(secret).digest()); // the shape Prisma expects for Bytes
}

/** Constant-time comparison, so response times do not leak how much of a secret matched. */
export function secretMatches(secret: string, storedHash: Uint8Array): boolean {
  const hash = hashSecret(secret);
  return storedHash.length === hash.length && timingSafeEqual(hash, storedHash);
}
