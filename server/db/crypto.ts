// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Symmetric encryption for secrets at rest (subscription source URLs).
 *
 * AES-256-GCM keyed by a scrypt-derived key from `SUBHUB_SECRET`.
 * Ciphertext format: `v1:` + base64( [12-byte iv][16-byte tag][data] ).
 *
 * When SUBHUB_SECRET is unset, a fixed development-only key is used unless
 * NODE_ENV=production, in which case construction fails. The dev key must never
 * be used to protect real data and is intentionally not a deployment default.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_SALT = 'subhub/secret/v1';

/** Fixed, non-secret test key; only for local development and tests. */
export const DEV_SECRET = 'subhub-dev-only-insecure-secret';

export interface CryptoOptions {
  /** Raw secret material (SUBHUB_SECRET). */
  secret?: string | null;
  /** NODE_ENV; production without a secret throws. */
  nodeEnv?: string | null;
}

let cachedKey: Buffer | null = null;
let cachedSecret: string | null = null;

function resolveSecret(opts: CryptoOptions = {}): string {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const secret = opts.secret ?? process.env.SUBHUB_SECRET;
  if (secret && secret.length > 0) return secret;
  if (nodeEnv === 'production') {
    throw new Error('SUBHUB_SECRET is required in production');
  }
  return DEV_SECRET;
}

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SCRYPT_SALT, KEY_LEN);
}

function getKey(opts: CryptoOptions = {}): Buffer {
  const secret = resolveSecret(opts);
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = deriveKey(secret);
  cachedSecret = secret;
  return cachedKey;
}

/** Encrypt a UTF-8 string; returns `v1:<base64>`. */
export function encrypt(plaintext: string, opts: CryptoOptions = {}): string {
  if (typeof plaintext !== 'string') throw new TypeError('encrypt expects a string');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', getKey(opts), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, data]).toString('base64');
}

/** Decrypt output of `encrypt`. Throws on tampering or wrong key. */
export function decrypt(payload: string, opts: CryptoOptions = {}): string {
  if (typeof payload !== 'string' || !payload.startsWith(PREFIX)) {
    throw new Error('decrypt: unsupported or malformed ciphertext');
  }
  const buf = Buffer.from(payload.slice(PREFIX.length), 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('decrypt: ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', getKey(opts), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** True when a value looks like output of `encrypt` (does not verify the tag). */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Forget the cached derived key (used by tests when swapping secrets). */
export function resetCryptoCache(): void {
  cachedKey = null;
  cachedSecret = null;
}
