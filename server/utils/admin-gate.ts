// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Signed cookie for the secret admin entrance (`subhub_gate`).
 *
 * The entrance path is a secret, so the cookie must not contain it: anyone
 * could paste `<cookie>=admin` (or whatever they guessed) and walk in. The
 * value is instead a stateless, signed marker minted only by the knock
 * handler:
 *
 *   `v1.<issuedAtSeconds>.<expiresAtSeconds>.<hmac>`
 *
 * HMAC-SHA256 keyed with the same secret as the admin session
 * (`SUBHUB_SECRET`; identical development fallback, and fail-closed in
 * production when the secret is missing — nothing can be signed or verified).
 * The payload carries no session identity: it only says "this browser once
 * found the entrance". Login itself is still enforced by the admin session and
 * the existing `admin-auth` middleware.
 *
 * Verification is constant-time and checks the signature, the 30-day lifetime
 * and a tolerance for a clock that is slightly ahead.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEV_SECRET } from '../db/crypto';
import { GATE_COOKIE, GATE_TTL_MS } from '../../core/utils/admin-entrance';

export { GATE_COOKIE };

/** Bumped when the payload format changes, invalidating old cookies. */
const GATE_VERSION = 'v1';

/** Signature key when SUBHUB_SECRET is unset (local development and tests only). */
const DEV_SIGNING_KEY = DEV_SECRET;

/** Fixed key for the length-normalising comparison hash (as in admin-auth). */
const COMPARE_KEY = 'subhub/admin-entrance/compare';

/** How far in the future an issued-at timestamp may be (clock skew). */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface GateTokenOptions {
  /** Explicit signing secret override (tests); defaults to SUBHUB_SECRET. */
  secret?: string | null;
  /** NODE_ENV override (tests). */
  nodeEnv?: string | null;
  /** Clock override for tests. */
  now?: () => number;
}

function env(opts: GateTokenOptions) {
  return {
    nodeEnv: opts.nodeEnv ?? process.env.NODE_ENV ?? '',
    secret: opts.secret !== undefined ? opts.secret : process.env.SUBHUB_SECRET,
  };
}

/** Signing key, or `null` when production is missing SUBHUB_SECRET. */
function signingKey(opts: GateTokenOptions): string | null {
  const { nodeEnv, secret } = env(opts);
  if (secret && secret.length > 0) return secret;
  // Same convention as `admin-auth.ts` / `server/db/crypto.ts`: a fixed key
  // outside production, nothing at all in production.
  if (nodeEnv === 'production') return null;
  return DEV_SIGNING_KEY;
}

function sign(payload: string, opts: GateTokenOptions): string | null {
  const key = signingKey(opts);
  if (key === null) return null;
  return createHmac('sha256', key).update(`subhub/gate/${payload}`).digest('base64url');
}

/** Constant-time, length-safe comparison (both values hashed first). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const hashA = createHmac('sha256', COMPARE_KEY).update(bufA).digest();
  const hashB = createHmac('sha256', COMPARE_KEY).update(bufB).digest();
  return timingSafeEqual(hashA, hashB) && bufA.length === bufB.length;
}

/** True when production has no SUBHUB_SECRET, so no gate cookie can exist. */
export function isGateSigningUnavailable(opts: GateTokenOptions = {}): boolean {
  return signingKey(opts) === null;
}

/**
 * Mint a gate token. Returns `null` in production without SUBHUB_SECRET: the
 * entrance then cannot hand out access (fail closed), but nothing is broken —
 * the gate stays closed.
 */
export function issueGateToken(opts: GateTokenOptions = {}): string | null {
  const now = (opts.now ?? Date.now)();
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = Math.floor((now + GATE_TTL_MS) / 1000);
  const payload = `${GATE_VERSION}.${issuedAt}.${expiresAt}`;
  const signature = sign(payload, opts);
  if (signature === null) return null;
  return `${payload}.${signature}`;
}

/** Verify a gate token: signature + lifetime. `false` for anything else. */
export function verifyGateToken(
  token: string | null | undefined,
  opts: GateTokenOptions = {},
): boolean {
  if (!token || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 4) return false;
  const [version, issuedRaw, expiresRaw, signature] = parts;
  if (version !== GATE_VERSION) return false;
  const issuedAt = Number(issuedRaw);
  const expiresAt = Number(expiresRaw);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) return false;
  if (!Number.isInteger(expiresAt) || expiresAt <= issuedAt) return false;

  const expected = sign(`${version}.${issuedRaw}.${expiresRaw}`, opts);
  if (expected === null || !safeEqual(signature!, expected)) return false;

  const now = (opts.now ?? Date.now)();
  if (expiresAt * 1000 <= now) return false;
  // A cookie issued "in the future" is rejected (beyond clock skew).
  if (issuedAt * 1000 > now + MAX_CLOCK_SKEW_MS) return false;
  return true;
}

/**
 * `Set-Cookie` value for the entrance. HttpOnly, SameSite=Lax, Path=/, 30 days.
 * `Secure` is added in production, exactly like the session cookie (Nitro bakes
 * NODE_ENV into the bundle, so a built server always sends it behind TLS).
 */
export function gateCookieHeader(token: string, opts: GateTokenOptions = {}): string {
  const attrs = [
    `${GATE_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(GATE_TTL_MS / 1000)}`,
  ];
  if ((opts.nodeEnv ?? process.env.NODE_ENV) === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

/** Read one cookie value from a raw `Cookie` header (undecoded fallback). */
export function readGateCookieHeader(raw: string | string[] | undefined): string | undefined {
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== GATE_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** True when the request headers carry a valid gate cookie. */
export function hasValidGateCookie(
  headers: Record<string, string | string[] | undefined>,
  opts: GateTokenOptions = {},
): boolean {
  return verifyGateToken(readGateCookieHeader(headers.cookie ?? headers.Cookie), opts);
}
