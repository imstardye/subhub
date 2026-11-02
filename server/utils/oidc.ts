// SPDX-License-Identifier: AGPL-3.0-only
/**
 * XAuth (OpenID Connect) login for the `/my` user center — server side.
 *
 * The admin console does **not** use OIDC: this module only ever authenticates
 * a *user* (by token→user binding, see `core/oidc.ts`) and then mints the very
 * same `subhub_my` session cookie a successful password unlock mints, so the
 * existing user-center guard (`handleUserRequest`) is satisfied unchanged.
 *
 * Protocol (the `openid-client` v6 **function** API — never hand-rolled):
 * - discovery → `Configuration` cached in memory, keyed by the client
 *   fingerprint (issuer + client id + secret + scopes); a settings change makes
 *   a different key, so the next request rediscovers (and the stale entry is
 *   dropped). The cache keeps the `Configuration` instance so its internal JWKS
 *   cache survives between logins.
 * - authorization code flow + PKCE **S256** is mandatory: every authorize URL
 *   carries `code_challenge` + `code_challenge_method=S256`, and `state` and
 *   `nonce` are generated per attempt.
 * - the client is a confidential web client: openid-client's default client
 *   authentication (`ClientSecretPost` using `client_secret`) is used.
 * - ID token verification (JWKS signature RS256, `iss`, `aud`, `exp`, `nonce`,
 *   `at_hash` when present) is openid-client's job: `authorizationCodeGrant`
 *   runs the OIDC checks with `expectedState`/`expectedNonce`/`pkceCodeVerifier`
 *   and the library fetches + validates the JWKS itself.
 * - `/userinfo` is only consulted when the ID token carries no email, and then
 *   with `expectedSubject = sub` (the library rejects a mismatched subject).
 *
 * Secrets: the client secret comes from the encrypted setting
 * (`server/utils/settings.ts`), the flow cookie is encrypted + signed, and the
 * logout cookie (`subhub_oidc_idt`) carries `{ userId, idToken }` encrypted.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import * as client from 'openid-client';
import type { SubhubDb } from '../db';
import { decrypt, encrypt, DEV_SECRET } from '../db/crypto';
import { users, type User } from '../db/schema';
import {
  OIDC_DEFAULT_SCOPES,
  normalizeOidcEmail,
  normalizeOidcIssuer,
  normalizeOidcScopes,
  oidcPostLogoutUri,
  resolveOidcIdentity,
  type OidcIdentityClaims,
  type OidcResolution,
} from '../../core/oidc';
import { getOidcRawSettings, readOidcClientSecret } from './settings';
import {
  USER_SESSION_COOKIE,
  verifyUserSession,
  type UserSessionOptions,
} from './user-session';

/* ------------------------------------------------------------- settings -- */

/** Active client configuration (plaintext secret; never serialised). */
export interface ActiveOidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
}

/**
 * The active OIDC client, or `null` when XAuth is off/incomplete (the
 * `/auth/*` routes then answer 404 and no UI surfaces it). `active` requires
 * enabled + issuer + client id + a decryptable client secret.
 */
export function activeOidcConfig(db: SubhubDb): ActiveOidcConfig | null {
  const raw = getOidcRawSettings(db);
  if (raw.enabled !== '1') return null;
  const issuer = raw.issuer ? normalizeOidcIssuer(raw.issuer) : null;
  const clientId = (raw.clientId ?? '').trim();
  if (!issuer || !clientId) return null;
  const clientSecret = readOidcClientSecret(db);
  if (!clientSecret) return null;
  return {
    issuer,
    clientId,
    clientSecret,
    scopes: normalizeOidcScopes(raw.scopes ?? OIDC_DEFAULT_SCOPES),
  };
}

/** True when XAuth is usable right now (`activeOidcConfig` !== null). */
export function isOidcLoginActive(db: SubhubDb): boolean {
  return activeOidcConfig(db) !== null;
}

/* ---------------------------------------------------------- discovery -- */

interface CachedConfig {
  /** Fingerprint of the settings the entry was built from. */
  key: string;
  config: Promise<client.Configuration>;
}

let cachedConfig: CachedConfig | null = null;

/** Fingerprint of a client configuration; any change forces a rediscovery. */
export function oidcConfigKey(config: ActiveOidcConfig): string {
  return [config.issuer, config.clientId, config.clientSecret, config.scopes].join('\u0000');
}

/**
 * Plain-HTTP issuers (a local development IdP, the test stub) are refused by
 * openid-client unless the configuration opts out.
 *
 * A deployed build (`NODE_ENV=production` at runtime) always requires HTTPS. A
 * locally run build and the vitest suite may opt in explicitly with
 * `SUBHUB_OIDC_ALLOW_INSECURE=1` for a loopback / test IdP; nothing enables it
 * by default, so a real deployment never talks plain HTTP to an issuer.
 */
function allowInsecureIssuer(): boolean {
  if ((process.env.NODE_ENV ?? '') !== 'production') return true;
  return process.env.SUBHUB_OIDC_ALLOW_INSECURE === '1';
}

/**
 * The openid-client `Configuration` for these settings, discovered once per
 * fingerprint and kept in memory (so the JWKS cache is reused). A settings
 * change produces a new key: the old entry is dropped and the caller gets a
 * fresh discovery. A failed discovery is not cached (the next request retries).
 */
export async function oidcConfiguration(config: ActiveOidcConfig): Promise<client.Configuration> {
  const key = oidcConfigKey(config);
  if (cachedConfig && cachedConfig.key === key) return cachedConfig.config;
  const issuer = new URL(config.issuer);
  // Confidential web client: openid-client's default client authentication
  // (ClientSecretPost with the client secret) is used, so the metadata carries
  // the secret explicitly rather than relying on a positional shorthand.
  const pending = client.discovery(
    issuer,
    config.clientId,
    { client_secret: config.clientSecret },
    undefined,
    issuer.protocol === 'http:' && allowInsecureIssuer() ? { execute: [client.allowInsecureRequests] } : undefined,
  );
  cachedConfig = { key, config: pending };
  try {
    return await pending;
  } catch (error) {
    // Discovery failed (bad issuer, offline IdP): let the next attempt retry.
    if (cachedConfig?.key === key) cachedConfig = null;
    throw error;
  }
}

/** Drop the cached discovery (settings save / tests). */
export function invalidateOidcConfigCache(): void {
  cachedConfig = null;
}

/* --------------------------------------------------------- flow cookie -- */

/** Cookie holding the per-attempt {state, nonce, verifier}; 10 minutes. */
export const OIDC_FLOW_COOKIE = 'subhub_oidc';
/** Encrypted cookie carrying `{ userId, idToken }` for the SSO logout. */
export const OIDC_IDT_COOKIE = 'subhub_oidc_idt';
/** Flow cookie lifetime (an abandoned login starts over). */
export const OIDC_FLOW_TTL_MS = 10 * 60 * 1000;

/** Payload of the flow cookie. */
export interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
  /** Creation time (epoch ms) — the cookie Max-Age is advisory only. */
  createdAt: number;
}

/** Payload of the logout cookie: who logged in and with which ID token. */
export interface OidcLogoutInfo {
  userId: number;
  idToken: string;
}

export interface OidcCookieOptions {
  /** Signing/encryption secret override (tests); defaults to SUBHUB_SECRET. */
  secret?: string | null;
  /** NODE_ENV override (tests). */
  nodeEnv?: string | null;
  /** Clock override for tests. */
  now?: () => number;
}

/** Fixed key for the length-normalising comparison hash. */
const COMPARE_KEY = 'subhub/oidc/compare';

function signingKey(opts: OidcCookieOptions): string | null {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV ?? '';
  const secret = opts.secret !== undefined ? opts.secret : process.env.SUBHUB_SECRET;
  if (secret && secret.length > 0) return secret;
  // Same convention as admin-auth / user-session: fixed dev key outside
  // production, nothing at all in production (fail closed).
  if (nodeEnv === 'production') return null;
  return DEV_SECRET;
}

function sign(payload: string, opts: OidcCookieOptions): string | null {
  const key = signingKey(opts);
  if (key === null) return null;
  return createHmac('sha256', key).update(`subhub/oidc/${payload}`).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const hashA = createHmac('sha256', COMPARE_KEY).update(bufA).digest();
  const hashB = createHmac('sha256', COMPARE_KEY).update(bufB).digest();
  return timingSafeEqual(hashA, hashB) && bufA.length === bufB.length;
}

/** Raw secret material for `encrypt`/`decrypt` (same resolution as the signing key). */
function cryptoSecret(opts: OidcCookieOptions): string | undefined {
  const key = signingKey(opts);
  if (key === null) throw new Error('SUBHUB_SECRET is required in production');
  const explicit = opts.secret !== undefined ? opts.secret : process.env.SUBHUB_SECRET;
  return explicit && explicit.length > 0 ? explicit : undefined;
}

/** `v1.<body>.<hmac>` where `<body>` is the encrypted JSON payload. */
function sealJson(value: unknown, opts: OidcCookieOptions): string {
  const body = encrypt(JSON.stringify(value), { secret: cryptoSecret(opts) });
  const signature = sign(body, opts);
  if (signature === null) throw new Error('SUBHUB_SECRET is required in production');
  return `v1.${body}.${signature}`;
}

/** Inverse of `sealJson`; `null` for missing/tampered/foreign values. */
function openJson(token: string | null | undefined, opts: OidcCookieOptions): unknown {
  if (!token || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, body, signature] = parts as [string, string, string];
  const expected = sign(body, opts);
  if (expected === null || !safeEqual(signature, expected)) return null;
  try {
    return JSON.parse(decrypt(body, { secret: cryptoSecret(opts) }));
  } catch {
    return null;
  }
}

function cookieAttributes(opts: OidcCookieOptions): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if ((opts.nodeEnv ?? process.env.NODE_ENV) === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

/** Read one cookie value from a raw `Cookie` header (decoded). */
export function readCookieHeader(
  raw: string | string[] | undefined,
  name: string,
): string | undefined {
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  for (const part of header.split(';')) {
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

/** `Set-Cookie` for the flow cookie: encrypted, signed, HttpOnly, 10 minutes. */
export function flowCookieHeader(flow: OidcFlow, opts: OidcCookieOptions = {}): string {
  const value = sealJson(flow, opts);
  return `${OIDC_FLOW_COOKIE}=${encodeURIComponent(value)}; ${cookieAttributes(opts)}; Max-Age=${Math.floor(OIDC_FLOW_TTL_MS / 1000)}`;
}

/** `Set-Cookie` that clears the flow cookie. */
export function clearFlowCookieHeader(opts: OidcCookieOptions = {}): string {
  return `${OIDC_FLOW_COOKIE}=; ${cookieAttributes(opts)}; Max-Age=0`;
}

/** `Set-Cookie` for the logout cookie (same lifetime as the /my session). */
export function idTokenCookieHeader(
  info: OidcLogoutInfo,
  opts: OidcCookieOptions = {},
): string {
  const value = sealJson(info, opts);
  const maxAge = 30 * 24 * 60 * 60;
  return `${OIDC_IDT_COOKIE}=${encodeURIComponent(value)}; ${cookieAttributes(opts)}; Max-Age=${maxAge}`;
}

/** `Set-Cookie` that clears the logout cookie. */
export function clearIdTokenCookieHeader(opts: OidcCookieOptions = {}): string {
  return `${OIDC_IDT_COOKIE}=; ${cookieAttributes(opts)}; Max-Age=0`;
}

/** Parse + validate the flow cookie (tampered/expired → `null`). */
export function readFlowCookie(
  value: string | null | undefined,
  opts: OidcCookieOptions = {},
): OidcFlow | null {
  const parsed = openJson(value, opts) as Partial<OidcFlow> | null;
  if (!parsed) return null;
  const { state, nonce, verifier, createdAt } = parsed;
  if (typeof state !== 'string' || !state) return null;
  if (typeof nonce !== 'string' || !nonce) return null;
  if (typeof verifier !== 'string' || !verifier) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  const now = (opts.now ?? Date.now)();
  if (createdAt > now + 60 * 1000) return null;
  if (now - createdAt > OIDC_FLOW_TTL_MS) return null;
  return { state, nonce, verifier, createdAt };
}

/** Parse the logout cookie; `null` when absent/tampered. */
export function readIdTokenCookie(
  value: string | null | undefined,
  opts: OidcCookieOptions = {},
): OidcLogoutInfo | null {
  const parsed = openJson(value, opts) as Partial<OidcLogoutInfo> | null;
  if (!parsed) return null;
  const { userId, idToken } = parsed;
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) return null;
  if (typeof idToken !== 'string' || !idToken) return null;
  return { userId, idToken };
}

/**
 * True when this request's `/my` session was minted by XAuth: the signed
 * `subhub_my` cookie is valid AND the encrypted `subhub_oidc_idt` cookie was
 * issued for the same user. Anything else is a password session.
 */
export function isOidcSession(
  headers: Record<string, string | string[] | undefined>,
  options: { session?: UserSessionOptions; cookies?: OidcCookieOptions } = {},
): boolean {
  const session = verifyUserSession(
    readCookieHeader(headers.cookie ?? headers.Cookie, USER_SESSION_COOKIE),
    options.session ?? {},
  );
  if (!session) return false;
  const info = readIdTokenCookie(readCookieHeader(headers.cookie, OIDC_IDT_COOKIE), options.cookies);
  return !!info && info.userId === session.userId;
}

/* ------------------------------------------------------------- routes -- */

/** Failure codes `/auth/error?code=` renders (whitelist, see core/oidc.ts). */
export type OidcErrorCode = 'unbound' | 'conflict' | 'state' | 'expired' | 'provider' | 'disabled';

/**
 * Begin a login attempt: fresh state/nonce/PKCE verifier, the authorization
 * URL (S256, no `offline_access` in v1) and the matching flow cookie.
 */
export async function beginOidcLogin(
  config: ActiveOidcConfig,
  redirectUri: string,
): Promise<{ url: URL; flow: OidcFlow; cookie: string }> {
  const discovered = await oidcConfiguration(config);
  const verifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(verifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(discovered, {
    redirect_uri: redirectUri,
    scope: config.scopes,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  const flow: OidcFlow = { state, nonce, verifier, createdAt: Date.now() };
  return { url, flow, cookie: flowCookieHeader(flow) };
}

/** Result of a code grant: the validated claims + the raw ID token. */
export interface OidcTokenResult {
  claims: OidcIdentityClaims;
  idToken: string;
}

function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Exchange the authorization response for tokens (real discovery, JWKS and
 * ID-token verification happen inside the library) and read the claims.
 *
 * The email falls back to `/userinfo` only when the ID token has none, and
 * `fetchUserInfo` is given the ID token's `sub` as the expected subject (the
 * library rejects a mismatch) — so userinfo can never switch identities.
 */
export async function completeOidcLogin(
  config: ActiveOidcConfig,
  currentUrl: URL,
  flow: OidcFlow,
): Promise<OidcTokenResult> {
  const discovered = await oidcConfiguration(config);
  const tokens = await client.authorizationCodeGrant(discovered, currentUrl, {
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    pkceCodeVerifier: flow.verifier,
    idTokenExpected: true,
  });
  const idClaims = (tokens.claims() ?? {}) as Record<string, unknown>;
  const sub = stringClaim(idClaims, 'sub');
  let email = stringClaim(idClaims, 'email');
  let emailVerified = idClaims.email_verified === true;
  if (!email && sub && tokens.access_token) {
    try {
      const info = (await client.fetchUserInfo(discovered, tokens.access_token, sub)) as Record<string, unknown>;
      email = stringClaim(info, 'email');
      emailVerified = info.email_verified === true;
    } catch {
      // Unusable userinfo: treat the email as absent (never a login shortcut).
      email = null;
      emailVerified = false;
    }
  }
  // `id_token` is required by `idTokenExpected`; the fallback only satisfies the
  // type checker and can never be reached for a successful grant.
  return { claims: { sub, email, emailVerified }, idToken: tokens.id_token ?? '' };
}

/** Outcome of resolving an identity to a user (see `resolveOidcIdentity`). */
export interface OidcLoginOutcome {
  resolution: OidcResolution;
  /** The matched user row (present for `login`, and for a disabled bind). */
  user?: User;
  /** Why a would-be login was refused as disabled (bound user only). */
  disabled?: boolean;
}

/**
 * Resolve + persist the binding claim.
 *
 * Step 1 of `resolveOidcIdentity` (match by `sub`) is repeated here verbatim so
 * a *disabled* bound user is distinguished from an unknown identity (both end
 * in `unbound` otherwise) — the page then says 账号已停用 instead of 未绑定.
 * A successful first claim writes `oidc_sub` only when the user is still
 * unbound, so a concurrent claim cannot be overwritten (the unique index is
 * the last line of defence).
 */
export function resolveOidcLogin(db: SubhubDb, claims: OidcIdentityClaims): OidcLoginOutcome {
  const rows = db
    .select({
      id: users.id,
      enabled: users.enabled,
      oidcSub: users.oidcSub,
      oidcEmail: users.oidcEmail,
    })
    .from(users)
    .all();
  if (claims.sub) {
    const boundRow = rows.find((row) => row.oidcSub === claims.sub);
    if (boundRow && !boundRow.enabled) {
      const disabledUser = db.select().from(users).where(eq(users.id, boundRow.id)).get();
      return { resolution: { kind: 'error', code: 'unbound' }, user: disabledUser, disabled: true };
    }
  }
  const resolution = resolveOidcIdentity(rows, claims);
  if (resolution.kind === 'error') {
    // A DISABLED user whose pre-filled email matches a verified identity is the
    // same person as a disabled bound user: say 账号已停用, not 未绑定.
    const email = claims.emailVerified ? normalizeOidcEmail(claims.email ?? '') : '';
    const disabledMatch = email
      ? rows.find((row) => !row.enabled && row.oidcEmail === email)
      : undefined;
    if (disabledMatch) {
      const disabledUser = db.select().from(users).where(eq(users.id, disabledMatch.id)).get();
      return { resolution, user: disabledUser, disabled: true };
    }
    return { resolution };
  }
  const user = db.select().from(users).where(eq(users.id, resolution.userId)).get();
  if (!user) return { resolution: { kind: 'error', code: 'unbound' } };
  if (resolution.claimSub) {
    db.update(users)
      .set({ oidcSub: claims.sub })
      .where(and(eq(users.id, user.id), isNull(users.oidcSub)))
      .run();
    return { resolution, user: { ...user, oidcSub: claims.sub } };
  }
  return { resolution, user };
}

/* ------------------------------------------------------------- logout -- */

/**
 * The exact `end_session` URL for a stored ID token, or `null` when the
 * discovered metadata has no `end_session_endpoint` (the caller then simply
 * lands on `/auth/logged-out`). `id_token_hint` + `post_logout_redirect_uri`
 * are built by `buildEndSessionUrl` (which also adds `client_id`).
 */
export async function oidcEndSessionUrl(
  config: ActiveOidcConfig,
  idToken: string,
  origin: string,
): Promise<URL | null> {
  const discovered = await oidcConfiguration(config);
  const metadata = discovered.serverMetadata();
  if (!metadata.end_session_endpoint) return null;
  return client.buildEndSessionUrl(discovered, {
    id_token_hint: idToken,
    post_logout_redirect_uri: oidcPostLogoutUri(origin),
  });
}


