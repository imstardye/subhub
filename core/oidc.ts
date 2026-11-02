// SPDX-License-Identifier: AGPL-3.0-only
/**
 * XAuth (OpenID Connect) login for the `/my` user center — pure decision logic.
 *
 * XAuth authenticates *users*, never the admin console. subhub users are always
 * pre-provisioned by the admin: there is no just-in-time registration, and an
 * OIDC identity that matches nobody is rejected (`unbound`), never created.
 *
 * Binding model (one claim, then bound forever):
 * - the admin pre-fills `users.oidc_email` (the expected email, lower-cased);
 * - the FIRST XAuth login whose verified token carries that email (and
 *   `email_verified === true`) claims the binding: `users.oidc_sub` = the token
 *   `sub`. Every later login matches by `sub` alone (the email may drift);
 * - the admin can unbind (`oidc_sub` cleared, the email kept) or change the
 *   email (which also unbinds, so the next verified email claims it again).
 *
 * A bound user's password login is disabled (`oidc-only`): the stored hash is
 * kept, so unbinding restores it. There is **no** self-service binding flow.
 *
 * This file has no Node/Vue imports so the page helpers and the server can both
 * use it and the vitest suite can test it directly.
 */

/** `users.oidc_sub` claim states, as the admin users page spells them. */
export type OidcBindingState = 'unbound' | 'pending' | 'bound';

/** Chinese labels of `OidcBindingState` (admin users page + DTO docs). */
export const OIDC_BINDING_LABELS: Record<OidcBindingState, string> = {
  unbound: '未预绑',
  pending: '待认领',
  bound: '已绑定',
};

/**
 * Binding state of one user row: `bound` when a `sub` was claimed, `pending`
 * when only the expected email is filled, `unbound` otherwise.
 */
export function oidcBindingState(user: {
  oidcSub?: string | null;
  oidcEmail?: string | null;
}): OidcBindingState {
  if (user.oidcSub) return 'bound';
  if (user.oidcEmail) return 'pending';
  return 'unbound';
}

/** Email shape accepted for a pre-filled binding (deliberately permissive). */
export const OIDC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const OIDC_EMAIL_MAX_LENGTH = 254;

/** Canonical stored form of an expected email: trimmed and lower-cased. */
export function normalizeOidcEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when `raw` (already trimmed) is a usable email address. */
export function isValidOidcEmail(raw: string): boolean {
  const value = raw.trim();
  return value.length > 0 && value.length <= OIDC_EMAIL_MAX_LENGTH && OIDC_EMAIL_PATTERN.test(value);
}

/** Claims a login attempt resolved from the validated ID token (+ userinfo). */
export interface OidcIdentityClaims {
  sub: string | null;
  email: string | null;
  /** Only the literal `true` counts; anything else is not verified. */
  emailVerified: boolean;
}

/** One user row as the resolution sees it (only the fields that matter). */
export interface OidcCandidateUser {
  id: number;
  enabled: boolean;
  oidcSub: string | null;
  oidcEmail: string | null;
}

/**
 * Resolution outcome. `unbound` = no identity matched (unknown user, or the
 * email is missing / not verified / not pre-filled); `conflict` = more than one
 * unclaimed user carries the same pre-filled email. Neither is ever
 * auto-provisioned.
 */
export type OidcResolution =
  | { kind: 'login'; userId: number; claimSub: boolean }
  | { kind: 'error'; code: 'unbound' | 'conflict' };

/**
 * Resolve a verified identity against the user table.
 *
 * 1. a user whose `oidc_sub` equals the token `sub` (and is enabled) logs in;
 * 2. otherwise the email must be present AND `email_verified === true`: the
 *    candidates are the ENABLED, not-yet-claimed users whose `oidc_email`
 *    equals the (lower-cased) email. Exactly one claims the binding; zero is
 *    `unbound`, more than one is `conflict` (the admin must fix the data);
 * 3. anything else is `unbound`.
 *
 * A DISABLED bound user is not matched by sub and cannot claim (step 2 only
 * looks at enabled users), so they always end with `unbound` — the caller maps
 * that to the friendly "disabled" page.
 */
export function resolveOidcIdentity(
  users: readonly OidcCandidateUser[],
  claims: OidcIdentityClaims,
): OidcResolution {
  const sub = claims.sub;
  if (sub) {
    const bound = users.find((user) => user.oidcSub === sub && user.enabled);
    if (bound) return { kind: 'login', userId: bound.id, claimSub: false };
  }
  if (!claims.emailVerified) return { kind: 'error', code: 'unbound' };
  const email = claims.email ? normalizeOidcEmail(claims.email) : '';
  if (!email || !sub) return { kind: 'error', code: 'unbound' };
  const candidates = users.filter(
    (user) => user.enabled && !user.oidcSub && (user.oidcEmail ?? '') !== '' && user.oidcEmail === email,
  );
  if (candidates.length === 1) {
    return { kind: 'login', userId: candidates[0]!.id, claimSub: true };
  }
  return { kind: 'error', code: candidates.length === 0 ? 'unbound' : 'conflict' };
}

/* ------------------------------------------------------------- settings -- */

/** Scope used when the admin leaves the field empty. No `offline_access`. */
export const OIDC_DEFAULT_SCOPES = 'openid profile email';

/** Hard cap for the stored scope string. */
export const OIDC_SCOPES_MAX_LENGTH = 256;

/** The five settings keys of the XAuth client (`settings` table). */
export const OIDC_SETTING_KEYS = {
  enabled: 'oidc_enabled',
  issuer: 'oidc_issuer',
  clientId: 'oidc_client_id',
  clientSecret: 'oidc_client_secret',
  scopes: 'oidc_scopes',
} as const;

/** Raw settings values as read from the store (`null` = unset). */
export interface OidcRawSettings {
  enabled: string | null;
  issuer: string | null;
  clientId: string | null;
  /** Ciphertext (never plaintext, never serialised). */
  clientSecret: string | null;
  scopes: string | null;
}

/** Normalise a scope string: split on whitespace, dedupe, keep order. */
export function normalizeOidcScopes(raw: string | null | undefined): string {
  const parts = (raw ?? '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const unique = [...new Set(parts)];
  // `openid` is mandatory in OIDC; empty falls back to the default set.
  if (unique.length === 0) return OIDC_DEFAULT_SCOPES;
  return unique.includes('openid') ? unique.join(' ') : ['openid', ...unique].join(' ');
}

/** Validate + normalise the admin scope field; `null` = invalid. */
export function parseOidcScopes(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > OIDC_SCOPES_MAX_LENGTH) return null;
  for (const scope of raw.split(/\s+/).filter(Boolean)) {
    if (!/^[a-zA-Z0-9._:-]+$/.test(scope)) return null;
  }
  return normalizeOidcScopes(raw);
}

/** Issuer as stored: trimmed, no trailing slashes, http(s) only. `null` = invalid. */
export function normalizeOidcIssuer(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, '');
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // h3 sends `event.path` WITHOUT the query string, and the callback keeps
    // `?code=…&state=…` — an issuer with a query would break the flow.
    if (url.search || url.hash) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Effective (secret-free) OIDC configuration. `active` is true only when the
 * setting is enabled AND issuer, client id and client secret are all present —
 * an inactive client answers 404 on every `/auth/*` route and is never
 * surfaced in the UI.
 */
export interface OidcEffectiveConfig {
  active: boolean;
  issuer: string | null;
  clientId: string | null;
  clientSecretConfigured: boolean;
  scopes: string;
}

export function effectiveOidcConfig(
  raw: OidcRawSettings,
  hasPlaintextSecret: boolean,
): OidcEffectiveConfig {
  const enabled = raw.enabled === '1';
  const issuerRaw = (raw.issuer ?? '').trim();
  const issuer = issuerRaw ? normalizeOidcIssuer(issuerRaw) : null;
  const clientId = (raw.clientId ?? '').trim() || null;
  const active = enabled && issuer !== null && clientId !== null && hasPlaintextSecret;
  return {
    active,
    issuer,
    clientId,
    clientSecretConfigured: hasPlaintextSecret,
    scopes: normalizeOidcScopes(raw.scopes),
  };
}

/** `offline_access` is deliberately never requested in v1 (local cookie only). */
export function scopesRequestOfflineAccess(scopes: string): boolean {
  return scopes.split(/\s+/).includes('offline_access');
}

/* ------------------------------------------------------------------ UI -- */

/**
 * Whether the page must render a "使用 XAuth 登录" button next to today's
 * password form: only for a not-yet-bound user while OIDC is active.
 */
export function shouldOfferXAuth(locked: { oidcEnabled: boolean; oidcBound: boolean } | null | undefined): boolean {
  return !!locked && locked.oidcEnabled && !locked.oidcBound;
}

/**
 * Whether the locked screen shows ONLY the XAuth button: a bound user cannot
 * use their password any more (the server answers `oidc-only`).
 */
export function isXAuthOnlyLocked(locked: { oidcEnabled: boolean; oidcBound: boolean } | null | undefined): boolean {
  return !!locked && locked.oidcBound;
}

/** Lock message of a bound user (only XAuth can open the page). */
export const XAUTH_ONLY_NOTICE = '该账号已绑定 XAuth 单点登录，请使用 XAuth 登录进入。';

/** Label of the XAuth login button (locked screen and logout button). */
export const XAUTH_LOGIN_LABEL = '使用 XAuth 登录';

/** Server route of the XAuth entry point (browser redirect, not JSON). */
export const XAUTH_LOGIN_PATH = '/auth/login';
/** Server route ending the session (clears cookies + IdP end_session). */
export const XAUTH_LOGOUT_PATH = '/auth/logout';

/**
 * Status of the password endpoints for a bound user. The server answers this
 * instead of checking the password, so a correct password changes nothing.
 */
export const OIDC_ONLY_STATUS = 'oidc-only' as const;

/** Friendly Chinese text of a `/auth/error?code=` failure (whitelisted codes). */
export const OIDC_ERROR_MESSAGES: Record<string, { title: string; detail: string; contact: boolean }> = {
  unbound: {
    title: '无法登录',
    detail: '该 XAuth 账号未绑定任何用户，或邮箱未通过验证。',
    contact: true,
  },
  conflict: {
    title: '无法登录',
    detail: '该邮箱对应多个待认领的用户，无法确定绑定对象。',
    contact: true,
  },
  disabled: {
    title: '账号已停用',
    detail: '该账号已被停用，请联系管理员。',
    contact: true,
  },
  state: {
    title: '登录已失效',
    detail: '登录请求校验失败（state 不匹配），请重新发起登录。',
    contact: false,
  },
  expired: {
    title: '登录已超时',
    detail: '登录请求已过期，请重新发起登录。',
    contact: false,
  },
  provider: {
    title: '登录失败',
    detail: 'XAuth 服务返回了错误或身份信息不完整，请稍后重试。',
    contact: false,
  },
};

/** Whitelisted `/auth/error` codes; anything else renders the generic page. */
export const OIDC_ERROR_CODES = Object.keys(OIDC_ERROR_MESSAGES);

/** Page content of `/auth/error?code=<code>`; never reflects raw provider data. */
export function oidcErrorPage(code: unknown): { title: string; detail: string; contact: string } {
  const known = typeof code === 'string' && Object.prototype.hasOwnProperty.call(OIDC_ERROR_MESSAGES, code)
    ? OIDC_ERROR_MESSAGES[code]!
    : { title: '登录失败', detail: '登录过程中出现错误，请重新发起登录。', contact: false };
  return { title: known.title, detail: known.detail, contact: known.contact ? '请联系管理员' : '' };
}

/** Absolute callback URL of this site (`<origin>/auth/callback`). */
export function oidcRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/auth/callback`;
}

/** Absolute post-logout URL of this site (`<origin>/auth/logged-out`). */
export function oidcPostLogoutUri(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/auth/logged-out`;
}

/**
 * Client path back to the user center after a successful XAuth login. The
 * token in the URL is the credential, exactly as in a password session.
 */
export function xauthReturnPath(token: string): string {
  return `/my/${encodeURIComponent(token)}`;
}
