// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Password hashing for the user center.
 *
 * scrypt with a fresh 16-byte random salt per password (node:crypto), stored as
 * `scrypt$<N>$<r>$<p>$<salt>$<hash>` (base64url). The parameters live in the
 * stored value, so a future cost increase can verify old hashes instead of
 * locking everyone out.
 *
 * Verification is constant-time (`timingSafeEqual`) and fails closed for empty
 * input, unknown formats or wrong lengths. Hashing is synchronous like the URL
 * encryption in `server/db/crypto.ts`; a login is rare enough that a few tens
 * of milliseconds on the event loop is acceptable for this single-process app.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 64;
export const SCRYPT_SALT_BYTES = 16;

const HASH_NAME = 'scrypt';
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, keyLength: number, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, keyLength, { N: n, r, p, maxmem: MAX_MEMORY });
}

/** Hash a password with a fresh random salt. */
export function hashPassword(password: string): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('hashPassword expects a non-empty string');
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = derive(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    HASH_NAME,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/** True when a value looks like a stored scrypt hash (does not verify it). */
export function isPasswordHash(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${HASH_NAME}$`);
}

/**
 * Verify `password` against a stored hash. Returns `false` for a wrong
 * password and for anything malformed — never throws.
 */
export function verifyPassword(password: unknown, stored: unknown): boolean {
  if (typeof password !== 'string' || password.length === 0) return false;
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [name, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (name !== HASH_NAME) return false;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![n, r, p].every((value) => Number.isSafeInteger(value) && value > 0)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltRaw!, 'base64url');
    expected = Buffer.from(hashRaw!, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = derive(password, salt, expected.length, n, r, p);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
