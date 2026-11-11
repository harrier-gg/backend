// Password hashing and tokens (ADR 0006). Standard library only.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP-recommended scrypt parameters (N=2^15, r=8, p=3): about 32 MB of memory per hash.
const PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LENGTH = 32;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

function derive(password: string, salt: Buffer, length: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, length, { N, r, p, maxmem: 256 * N * r }, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = PARAMS;
  const hash = await derive(password, salt, KEY_LENGTH, N, r, p);
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Verifies with the parameters stored in the hash, so they can be raised later without breaking old hashes. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const params = [Number(n), Number(r), Number(p)];
  if (expected.length === 0 || params.some((x) => !Number.isInteger(x) || x < 1)) return false;
  const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length, params[0], params[1], params[2]);
  return timingSafeEqual(actual, expected);
}

/** A random 256-bit token (session or setup) and the SHA-256 that is stored instead of it. */
export function newToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(token).digest());
}

/** Constant-time comparison of two tokens (hashing first gives both the same length). */
export function tokensMatch(a: string, b: string): boolean {
  return timingSafeEqual(hashToken(a), hashToken(b));
}
