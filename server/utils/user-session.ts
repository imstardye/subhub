// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Signed session cookie for the user center (`/my/<token>`).
 *
 * Format: `v1.<userId>.<passwordVersion>.<expiresAtSeconds>.<hmac>`, signed with
 * HMAC-SHA256 keyed by `SUBHUB_SECRET` (same development fallback and
 * fail-closed production rule as `admin-auth.ts` / `admin-gate.ts`). The payload
 * carries no subscription token: it is bound to the user id and the current
 * password version, so token rotation keeps the session while a password
 * change/reset invalidates it.
 *
 * The cookie is `subhub_my`, HttpOnly, SameSite=Lax, Path=/, 30 days. It is
 * only ever set by the setup/unlock/change-password endpoints.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DEV_SECRET } from '../db/crypto';
import {
  decodeUserSessionPayload,
  encodeUserSessionPayload,
  type UserSessionPayload,
} from '../../core/utils/user-session';

/** Cookie name carrying the signed user-center session. */
export const USER_SESSION_COOKIE = 'subhub_my';

/** Session lifetime: 30 days. */
export const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Bumped when the token format changes, invalidating old cookies. */
const SESSION_VERSION = 'v1';

/** Fixed key for the length-normalising comparison hash. */
const COMPARE_KEY = 'subhub/user-center/compare';

/** Signing key when SUBHUB_SECRET is unset (local development and tests only). */
const DEV_SIGNING_KEY = DEV_SECRET;

export interface UserSessionOptions {
  /** Explicit signing secret override (tests); defaults to SUBHUB_SECRET. */
  secret?: string | null;
  /** NODE_ENV override (tests). */
  nodeEnv?: string | null;
  /** Clock override for tests. */
  now?: () => number;
}

/** Minimal node request view shared by Nitro events and test doubles. */
export interface UserSessionRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** Minimal h3/Nitro event shape used by this module. */
export interface UserSessionEvent {
  node: { req: UserSessionRequest; res: { statusCode: number; setHeader(name: string, value: string): unknown } };
}

function env(opts: UserSessionOptions) {
  return {
    nodeEnv: opts.nodeEnv ?? process.env.NODE_ENV ?? '',
    secret: opts.secret !== undefined ? opts.secret : process.env.SUBHUB_SECRET,
  };
}

function signingKey(opts: UserSessionOptions): string | null {
  const { nodeEnv, secret } = env(opts);
  if (secret && secret.length > 0) return secret;
  if (nodeEnv === 'production') return null;
  return DEV_SIGNING_KEY;
}

/** True when production has no SUBHUB_SECRET, so no session can exist. */
export function isUserSessionSigningUnavailable(opts: UserSessionOptions = {}): boolean {
  return signingKey(opts) === null;
}

function sign(payload: string, opts: UserSessionOptions): string | null {
  const key = signingKey(opts);
  if (key === null) return null;
  return createHmac('sha256', key).update(`subhub/user-center/${payload}`).digest('base64url');
}

/** Constant-time, length-safe comparison (both values hashed first). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const hashA = createHmac('sha256', COMPARE_KEY).update(bufA).digest();
  const hashB = createHmac('sha256', COMPARE_KEY).update(bufB).digest();
  return timingSafeEqual(hashA, hashB) && bufA.length === bufB.length;
}

/**
 * Mint a session token for a user at their current password version.
 * Throws in production without SUBHUB_SECRET (a real cookie must never be
 * signed with the public development key).
 */
export function issueUserSession(
  user: { id: number; passwordVersion?: number | null },
  opts: UserSessionOptions = {},
): { token: string; payload: UserSessionPayload; expiresAtMs: number } {
  if (isUserSessionSigningUnavailable(opts)) {
    throw new Error('SUBHUB_SECRET is required in production');
  }
  const now = (opts.now ?? Date.now)();
  const expiresAt = Math.floor(now / 1000) + USER_SESSION_TTL_SECONDS;
  const version = user.passwordVersion ?? 0;
  const payload = encodeUserSessionPayload({
    userId: user.id,
    passwordVersion: version,
    expiresAtSeconds: expiresAt,
  });
  const signature = sign(payload, opts);
  if (signature === null) throw new Error('SUBHUB_SECRET is required in production');
  return {
    token: `${payload}.${signature}`,
    payload: { userId: user.id, passwordVersion: version, expiresAtMs: expiresAt * 1000 },
    expiresAtMs: expiresAt * 1000,
  };
}

/** Verify signature + expiry; returns the decoded payload or `null`. */
export function verifyUserSession(
  token: string | null | undefined,
  opts: UserSessionOptions = {},
): UserSessionPayload | null {
  if (!token || token.length > 512) return null;
  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  const decoded = decodeUserSessionPayload(payload);
  if (!decoded) return null;
  const expected = sign(payload, opts);
  if (expected === null || !safeEqual(signature, expected)) return null;
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  if (decoded.expiresAtSeconds <= now) return null;
  return {
    userId: decoded.userId,
    passwordVersion: decoded.passwordVersion,
    expiresAtMs: decoded.expiresAtSeconds * 1000,
  };
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Read one cookie from the request `Cookie` header. */
export function readUserSessionCookie(
  event: { node: { req: UserSessionRequest } },
  name = USER_SESSION_COOKIE,
): string | undefined {
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

/** The verified session carried by the request, or `null`. */
export function userSessionFromEvent(
  event: { node: { req: UserSessionRequest } },
  opts: UserSessionOptions = {},
): UserSessionPayload | null {
  return verifyUserSession(readUserSessionCookie(event), opts);
}

/** `Set-Cookie` value for a successful setup/unlock/password change. */
export function userSessionCookieHeader(token: string, opts: UserSessionOptions = {}): string {
  const attrs = [
    `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${USER_SESSION_TTL_SECONDS}`,
  ];
  if ((opts.nodeEnv ?? process.env.NODE_ENV) === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

/** `Set-Cookie` value that clears the session cookie. */
export function clearUserSessionCookieHeader(): string {
  return `${USER_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Authentication failure of the user-center gate. A distinct 401 response with
 * a machine-readable `status` so the page can render 设置密码 vs 输入密码:
 * `needs-setup`, `needs-password` or `wrong-password`.
 */
export class UserCenterAuthError extends Error {
  readonly statusCode = 401 as const;

  constructor(
    message: string,
    readonly status: 'needs-setup' | 'needs-password' | 'wrong-password',
  ) {
    super(message);
    this.name = 'UserCenterAuthError';
  }
}
