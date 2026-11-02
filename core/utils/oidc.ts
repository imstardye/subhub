// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Page-side helpers for the XAuth (OIDC) login.
 *
 * The rules themselves live in `core/oidc.ts` (shared with the server); this
 * module owns the (pure) decisions the `/my` page and the admin settings page
 * make about them, kept out of the SFCs because there is no DOM test
 * environment. Import-relative, like the other `core/utils` modules, so the
 * root `tsc --noEmit` (no Nuxt alias table) type-checks it.
 */
import {
  OIDC_BINDING_LABELS,
  OIDC_ONLY_STATUS,
  XAUTH_LOGIN_PATH,
  XAUTH_LOGOUT_PATH,
  oidcBindingState,
  oidcPostLogoutUri,
  oidcRedirectUri,
  type OidcBindingState,
} from '../oidc';
import type { UserCenterLock } from './user-center';

export {
  OIDC_BINDING_LABELS,
  OIDC_ERROR_CODES,
  OIDC_ERROR_MESSAGES,
  OIDC_ONLY_STATUS,
  XAUTH_LOGIN_LABEL,
  XAUTH_LOGIN_PATH,
  XAUTH_LOGOUT_PATH,
  XAUTH_ONLY_NOTICE,
  isXAuthOnlyLocked,
  oidcBindingState,
  oidcErrorPage,
  shouldOfferXAuth,
  type OidcBindingState,
} from '../oidc';

/** The locked-screen facts the `/my` page needs while the user is locked. */
export interface UserCenterLockInfo {
  oidcEnabled: boolean;
  oidcBound: boolean;
}

/** Which parts of the locked screen to render. */
export interface LockedScreenMode {
  /** The bound-XAuth screen: only the XAuth button + the note. */
  xauthOnly: boolean;
  /** The password form (setup or entry) stays visible. */
  passwordForm: boolean;
  /** The "使用 XAuth 登录" button next to the password form. */
  xauthButton: boolean;
}

/**
 * What the locked screen shows, from the 401 status + its two booleans:
 * - bound user → ONLY the XAuth button (their password login answers
 *   `oidc-only`; a password field would be a dead end);
 * - not bound + XAuth active → today's password form PLUS the XAuth button;
 * - XAuth inactive → exactly today's UI (no button at all).
 * The `oidc-only` status alone already means "bound" (the server only answers
 * it for a user with `oidc_sub`), so an empty `{oidcBound:false}` payload can
 * never hide the button for that user.
 */
export function lockedScreenMode(
  lock: UserCenterLock | null,
  info: UserCenterLockInfo | null | undefined,
): LockedScreenMode {
  const bound = lock === OIDC_ONLY_STATUS || info?.oidcBound === true;
  if (bound) return { xauthOnly: true, passwordForm: false, xauthButton: true };
  const xauthButton = info?.oidcEnabled === true;
  return { xauthOnly: false, passwordForm: true, xauthButton };
}

/** Absolute XAuth entry URL of this site (plain browser redirect, no fetch). */
export function xauthLoginUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${XAUTH_LOGIN_PATH}`;
}

/** Absolute logout URL; used for an OIDC-backed session (SSO logout). */
export function xauthLogoutUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${XAUTH_LOGOUT_PATH}`;
}

/** How the account panel's logout control behaves. */
export interface LogoutPlan {
  /** End the SSO session at the IdP too (`/auth/logout`). */
  sso: boolean;
  label: string;
  hint: string;
  /** Where the browser must go (`/auth/logout` or the local `*_local` path). */
  path: string;
}

/**
 * The logout affordance of the signed-in area. An XAuth-backed session
 * (`user.sessionOidc`) logs out through `/auth/logout`, which clears the cookies
 * and — when the IdP advertises `end_session` — ends the SSO session. A password
 * session keeps today's local behaviour (`localPath`).
 */
export function logoutPlan(user: { sessionOidc?: boolean } | null, localPath: string): LogoutPlan {
  if (user?.sessionOidc) {
    return {
      sso: true,
      label: '退出 XAuth 登录',
      hint: '将同时结束 XAuth 单点登录会话，并清除本机登录状态。',
      path: XAUTH_LOGOUT_PATH,
    };
  }
  return {
    sso: false,
    label: '退出登录',
    hint: '仅清除本机登录状态，下次进入需重新输入密码。',
    path: localPath,
  };
}

/* ---------------------------------------------------------------- admin -- */

export interface OidcSettingsView {
  enabled: boolean;
  active: boolean;
  issuer: string;
  clientId: string;
  clientSecretSet: boolean;
  scopes: string;
  defaultScopes: string;
}

/** Body the XAuth form sends (secret write-only: blank = keep). */
export interface OidcSavePayload {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  clearClientSecret?: boolean;
  scopes: string;
}

/**
 * Build the PUT body from the form. `issuer` keeps its typed form (the server
 * validates it); a blank secret is omitted unless `clearSecret` is set, which is
 * the explicit clear affordance.
 */
export function oidcSavePayload(form: {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  clearClientSecret: boolean;
  scopes: string;
}): OidcSavePayload {
  const payload: OidcSavePayload = {
    enabled: form.enabled,
    issuer: form.issuer.trim(),
    clientId: form.clientId.trim(),
    scopes: form.scopes.trim(),
  };
  const secret = form.clientSecret.trim();
  if (form.clearClientSecret) payload.clearClientSecret = true;
  else if (secret) payload.clientSecret = secret;
  return payload;
}

/** The two read-only URLs the admin registers at the IdP (current origin). */
export function oidcAdminUrls(origin: string): { redirectUri: string; postLogoutUri: string } {
  return { redirectUri: oidcRedirectUri(origin), postLogoutUri: oidcPostLogoutUri(origin) };
}

/** Status line of the client secret field (never the value). */
export function oidcSecretLabel(secretSet: boolean): string {
  return secretSet ? '已配置' : '未配置';
}

/** Binding label for an admin user row (`core/oidc.ts` owns the states). */
export function oidcBindingLabel(user: {
  oidcBound?: boolean;
  oidcEmail?: string | null;
}): string {
  const state = oidcBindingState({
    oidcSub: user.oidcBound === true ? 'bound' : null,
    oidcEmail: user.oidcEmail ?? null,
  });
  return OIDC_BINDING_LABELS[state];
}
