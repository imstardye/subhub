// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin session skeleton (P3, first slice).
 *
 * Password comes from `SUBHUB_ADMIN_PASSWORD` and is compared in constant time.
 * A successful login sets the httpOnly cookie `subhub_admin` holding an
 * HMAC-SHA256 signed session value; the server stays stateless (no session
 * table yet). The signing key derives from `SUBHUB_SECRET`, so rotating the
 * secret invalidates every existing session.
 *
 * The cookie/event helpers are written against plain node request/response
 * objects (like `refresh-sources.post.ts`) and h3 is only imported as a type,
 * so this module and its tests need neither auto-imports nor the generated
 * `.nuxt` types. Session payloads are signed, not encrypted, and carry nothing
 * but a version marker and an expiry timestamp.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEV_SECRET } from '../db/crypto';

/** Cookie name carrying the signed admin session. */
export const ADMIN_COOKIE = 'subhub_admin';

/** Session lifetime: 7 days. */
export const ADMIN_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Fixed development password. Only used when `SUBHUB_ADMIN_PASSWORD` is unset
 * and NODE_ENV is not production — local development and tests only. Never a
 * deployment default; production without the env var refuses every login.
 */
export const DEV_ADMIN_PASSWORD = 'subhub-dev-admin';

/** Signing key when SUBHUB_SECRET is unset (local development and tests only). */
const DEV_SIGNING_KEY = DEV_SECRET;

/** Bumped when the payload format changes, invalidating old cookies. */
const SESSION_VERSION = 'v1';

/** Fixed key for the length-normalising comparison hash. */
const COMPARE_KEY = 'subhub/admin/compare';

export interface AdminAuthOptions {
  /** Explicit password override (tests); defaults to SUBHUB_ADMIN_PASSWORD. */
  password?: string | null;
  /** Explicit signing secret override (tests); defaults to SUBHUB_SECRET. */
  secret?: string | null;
  /** NODE_ENV override (tests). */
  nodeEnv?: string | null;
  /** Allow the fixed local password outside production (default true). */
  allowDevDefault?: boolean;
  /** Clock override for tests. */
  now?: () => number;
}

/** Minimal node request view shared by Nitro events and test doubles. */
export interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** Minimal node response view shared by Nitro events and test doubles. */
export interface MinimalResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
}

/** Minimal h3/Nitro event shape used by this module. */
export interface AdminEvent {
  node: { req: MinimalRequest; res: MinimalResponse };
}

function env(opts: AdminAuthOptions) {
  return {
    nodeEnv: opts.nodeEnv ?? process.env.NODE_ENV ?? '',
    password:
      opts.password !== undefined ? opts.password : process.env.SUBHUB_ADMIN_PASSWORD,
    secret: opts.secret !== undefined ? opts.secret : process.env.SUBHUB_SECRET,
  };
}

/**
 * Effective admin password. Returns `null` in production when unset, which
 * makes every login attempt fail (fail closed). Outside production a fixed test
 * password is used so a fresh checkout can log in; see DEV_ADMIN_PASSWORD.
 *
 * Note: Nitro inlines NODE_ENV at build time (`nuxt build` -> production), so a
 * production bundle refuses the dev password even when run locally.
 */
export function resolveAdminPassword(opts: AdminAuthOptions = {}): string | null {
  const { nodeEnv, password } = env(opts);
  if (password && password.length > 0) return password;
  if (nodeEnv === 'production' || opts.allowDevDefault === false) return null;
  return DEV_ADMIN_PASSWORD;
}

function signingKey(opts: AdminAuthOptions): string {
  const { secret } = env(opts);
  // Mirrors server/db/crypto.ts: a public development key when unset, so a
  // missing SUBHUB_SECRET degrades to "password only" rather than breaking.
  return secret && secret.length > 0 ? secret : DEV_SIGNING_KEY;
}

function sign(payload: string, opts: AdminAuthOptions): string {
  return createHmac('sha256', signingKey(opts)).update(payload).digest('base64url');
}

/**
 * Constant-time comparison. Both values are hashed first so differing lengths
 * do not short-circuit, then the original length is compared as well.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const hashA = createHmac('sha256', COMPARE_KEY).update(bufA).digest();
  const hashB = createHmac('sha256', COMPARE_KEY).update(bufB).digest();
  return timingSafeEqual(hashA, hashB) && bufA.length === bufB.length;
}

/** Check a submitted password against the configured one (fail closed). */
export function verifyAdminPassword(
  submitted: unknown,
  opts: AdminAuthOptions = {},
): boolean {
  const expected = resolveAdminPassword(opts);
  if (expected === null) return false;
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  return safeEqual(submitted, expected);
}

/** Build a signed session token `v1.<expiresAtSeconds>.<hmac>`. */
export function createSessionToken(opts: AdminAuthOptions = {}): string {
  const now = (opts.now ?? Date.now)();
  const expiresAt = Math.floor(now / 1000) + ADMIN_SESSION_TTL_SECONDS;
  const payload = `${SESSION_VERSION}.${expiresAt}`;
  return `${payload}.${sign(payload, opts)}`;
}

/** Verify signature and expiry of a session token. */
export function verifySessionToken(
  token: string | null | undefined,
  opts: AdminAuthOptions = {},
): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [version, expiresRaw, signature] = parts;
  if (version !== SESSION_VERSION) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) return false;
  if (!safeEqual(signature, sign(`${version}.${expiresRaw}`, opts))) return false;

  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  return expiresAt > now;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Password presented via the `x-admin-password` header (non-browser API
 * callers, e.g. the refresh task trigger). Never accepted for the cookie flow.
 */
export function adminPasswordFromHeader(req: MinimalRequest): string | undefined {
  return headerValue(req.headers, 'x-admin-password');
}

/** Read a cookie from the request `Cookie` header. */
export function readCookie(event: AdminEvent, name: string): string | undefined {
  const raw = headerValue(event.node.req.headers, 'cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

/** True when the request carries a valid admin session cookie. */
export function isAdmin(event: AdminEvent, opts: AdminAuthOptions = {}): boolean {
  return verifySessionToken(readCookie(event, ADMIN_COOKIE), opts);
}

/** Error shape Nitro renders as a 401 response. */
export interface UnauthorizedError extends Error {
  statusCode: 401;
  statusMessage: 'Unauthorized';
}

/**
 * Throw a 401 unless the request carries a valid admin session. The thrown
 * object has `statusCode`/`statusMessage`, which Nitro/h3 turn into a 401.
 */
export function requireAdmin(event: AdminEvent, opts: AdminAuthOptions = {}): void {
  if (isAdmin(event, opts)) return;
  const error = new Error('Unauthorized') as UnauthorizedError;
  error.statusCode = 401;
  error.statusMessage = 'Unauthorized';
  throw error;
}

/** `Set-Cookie` value for a successful login. */
export function sessionCookieHeader(token: string, opts: AdminAuthOptions = {}): string {
  const attrs = [
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
  ];
  // Secure only helps over HTTPS; behind a TLS-terminating proxy the request
  // itself is plain HTTP. Nitro bakes NODE_ENV into the bundle, so `nuxt build`
  // always produces Secure cookies (production); `nuxt dev` does not.
  if ((opts.nodeEnv ?? process.env.NODE_ENV) === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

/** `Set-Cookie` value that clears the session cookie. */
export function logoutCookieHeader(): string {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Verify the password and return a session on success. Returns `null` when the
 * password is wrong; no cookie is ever produced for a failed attempt.
 */
export function login(
  password: unknown,
  opts: AdminAuthOptions = {},
): { token: string; cookie: string } | null {
  if (!verifyAdminPassword(password, opts)) return null;
  const token = createSessionToken(opts);
  return { token, cookie: sessionCookieHeader(token, opts) };
}

/** Minimal view of the current admin session for GET /api/admin/me. */
export function me(event: AdminEvent, opts: AdminAuthOptions = {}): { authenticated: boolean } {
  return { authenticated: isAdmin(event, opts) };
}
