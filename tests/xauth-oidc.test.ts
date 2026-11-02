// SPDX-License-Identifier: AGPL-3.0-only
/**
 * XAuth (OIDC) pure logic: binding resolution, settings normalisation, the
 * locked-screen / logout decisions, the admin form payload and the standalone
 * error page text.
 *
 * Everything here is a plain function (no HTTP, no DB); the protocol itself is
 * covered end-to-end by `tests/xauth-login.test.ts` against the stub IdP.
 */
import { describe, expect, it } from 'vitest';
import {
  OIDC_DEFAULT_SCOPES,
  OIDC_BINDING_LABELS,
  effectiveOidcConfig,
  isValidOidcEmail,
  normalizeOidcEmail,
  normalizeOidcIssuer,
  normalizeOidcScopes,
  oidcBindingState,
  oidcErrorPage,
  oidcPostLogoutUri,
  oidcRedirectUri,
  parseOidcScopes,
  resolveOidcIdentity,
  scopesRequestOfflineAccess,
  xauthReturnPath,
  type OidcCandidateUser,
} from '../core/oidc';
import {
  isXAuthOnlyLocked,
  lockedScreenMode,
  logoutPlan,
  oidcAdminUrls,
  oidcBindingLabel,
  oidcSavePayload,
  oidcSecretLabel,
  shouldOfferXAuth,
  xauthLoginUrl,
  xauthLogoutUrl,
} from '../core/utils/oidc';
import { oidcConfigKey } from '../server/utils/oidc';

const users: OidcCandidateUser[] = [
  { id: 1, enabled: true, oidcSub: 'sub-bound', oidcEmail: 'bound@example.com' },
  { id: 2, enabled: true, oidcSub: null, oidcEmail: 'pending@example.com' },
  { id: 3, enabled: true, oidcSub: null, oidcEmail: 'dup@example.com' },
  { id: 4, enabled: true, oidcSub: null, oidcEmail: 'dup@example.com' },
  { id: 5, enabled: false, oidcSub: 'sub-disabled', oidcEmail: 'disabled@example.com' },
  { id: 6, enabled: true, oidcSub: null, oidcEmail: null },
];

describe('identity resolution', () => {
  it('logs in a bound user by sub alone, whatever the email says', () => {
    expect(
      resolveOidcIdentity(users, { sub: 'sub-bound', email: 'drifted@elsewhere.com', emailVerified: true }),
    ).toEqual({ kind: 'login', userId: 1, claimSub: false });
    // Even without a verified email (an old token): sub is enough once bound.
    expect(resolveOidcIdentity(users, { sub: 'sub-bound', email: null, emailVerified: false })).toEqual({
      kind: 'login',
      userId: 1,
      claimSub: false,
    });
  });

  it('claims the binding only with a verified, pre-filled email (case-insensitive)', () => {
    expect(
      resolveOidcIdentity(users, { sub: 'new-sub', email: 'Pending@Example.COM', emailVerified: true }),
    ).toEqual({ kind: 'login', userId: 2, claimSub: true });
  });

  it('never claims on email_verified !== true or a missing email', () => {
    for (const claims of [
      { sub: 'new-sub', email: 'pending@example.com', emailVerified: false },
      { sub: 'new-sub', email: null, emailVerified: true },
      { sub: 'new-sub', email: '', emailVerified: true },
    ]) {
      expect(resolveOidcIdentity(users, claims)).toEqual({ kind: 'error', code: 'unbound' });
    }
  });

  it('answers unbound for an unknown identity and conflict for a duplicate email', () => {
    expect(resolveOidcIdentity(users, { sub: 'nobody', email: 'nobody@example.com', emailVerified: true })).toEqual({
      kind: 'error',
      code: 'unbound',
    });
    expect(resolveOidcIdentity(users, { sub: 'new-sub', email: 'dup@example.com', emailVerified: true })).toEqual({
      kind: 'error',
      code: 'conflict',
    });
  });

  it('never matches or claims a disabled user', () => {
    expect(resolveOidcIdentity(users, { sub: 'sub-disabled', email: null, emailVerified: false })).toEqual({
      kind: 'error',
      code: 'unbound',
    });
    expect(
      resolveOidcIdentity(users, { sub: 'other', email: 'disabled@example.com', emailVerified: true }),
    ).toEqual({ kind: 'error', code: 'unbound' });
  });

  it('treats a claimed email as unavailable for a second identity', () => {
    // The bound user's email is pre-filled but already claimed: no new claim.
    expect(resolveOidcIdentity(users, { sub: 'other', email: 'bound@example.com', emailVerified: true })).toEqual({
      kind: 'error',
      code: 'unbound',
    });
  });

  it('classifies the admin binding states', () => {
    expect(oidcBindingState({ oidcSub: null, oidcEmail: null })).toBe('unbound');
    expect(oidcBindingState({ oidcSub: null, oidcEmail: 'a@b.c' })).toBe('pending');
    expect(oidcBindingState({ oidcSub: 'sub', oidcEmail: 'a@b.c' })).toBe('bound');
    expect(OIDC_BINDING_LABELS.pending).toBe('待认领');
  });
});

describe('settings normalisation', () => {
  it('normalises and validates the expected email', () => {
    expect(normalizeOidcEmail('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(isValidOidcEmail('alice@example.com')).toBe(true);
    for (const bad of ['alice', 'alice@', '@example.com', 'alice@example', '']) {
      expect(isValidOidcEmail(bad), bad).toBe(false);
    }
  });

  it('normalises the issuer and rejects query/hash/non-http values', () => {
    expect(normalizeOidcIssuer(' https://id.example.com/ ')).toBe('https://id.example.com');
    expect(normalizeOidcIssuer('http://localhost:8787')).toBe('http://localhost:8787');
    for (const bad of ['', 'not a url', 'ftp://id.example.com', 'https://id.example.com?a=1', 'https://id.example.com#x']) {
      expect(normalizeOidcIssuer(bad), bad).toBeNull();
    }
  });

  it('keeps scopes deduped, openid-first and never adds offline_access', () => {
    expect(normalizeOidcScopes(null)).toBe(OIDC_DEFAULT_SCOPES);
    expect(normalizeOidcScopes('  ')).toBe(OIDC_DEFAULT_SCOPES);
    expect(normalizeOidcScopes('profile  email profile')).toBe('openid profile email');
    expect(normalizeOidcScopes('email')).toBe('openid email');
    expect(parseOidcScopes('openid profile email')).toBe('openid profile email');
    expect(parseOidcScopes('openid bad scope!')).toBeNull();
    expect(parseOidcScopes('x'.repeat(300))).toBeNull();
    expect(scopesRequestOfflineAccess(OIDC_DEFAULT_SCOPES)).toBe(false);
  });

  it('is active only when enabled and every client value is present', () => {
    const raw = {
      enabled: '1',
      issuer: 'https://id.example.com/',
      clientId: 'client',
      clientSecret: 'ciphertext',
      scopes: null,
    };
    expect(effectiveOidcConfig(raw, true)).toMatchObject({
      active: true,
      issuer: 'https://id.example.com',
      clientId: 'client',
      clientSecretConfigured: true,
      scopes: OIDC_DEFAULT_SCOPES,
    });
    expect(effectiveOidcConfig({ ...raw, enabled: '0' }, true).active).toBe(false);
    expect(effectiveOidcConfig(raw, false).active).toBe(false);
    expect(effectiveOidcConfig({ ...raw, issuer: '' }, true).active).toBe(false);
    expect(effectiveOidcConfig({ ...raw, clientId: '' }, true).active).toBe(false);
    expect(effectiveOidcConfig({ ...raw, enabled: null }, true).active).toBe(false);
  });

  it('keys the discovery cache by every client-relevant value', () => {
    const base = { issuer: 'https://id.example.com', clientId: 'c', clientSecret: 's', scopes: 'openid' };
    const key = oidcConfigKey(base);
    expect(oidcConfigKey({ ...base })).toBe(key);
    for (const changed of [
      { ...base, issuer: 'https://other.example.com' },
      { ...base, clientId: 'c2' },
      { ...base, clientSecret: 's2' },
      { ...base, scopes: 'openid email' },
    ]) {
      expect(oidcConfigKey(changed)).not.toBe(key);
    }
  });
});

describe('locked screen decisions', () => {
  const active = { oidcEnabled: true, oidcBound: false };
  const bound = { oidcEnabled: true, oidcBound: true };

  it('shows ONLY the XAuth button for a bound user', () => {
    expect(lockedScreenMode('oidc-only', bound)).toEqual({ xauthOnly: true, passwordForm: false, xauthButton: true });
    // Even if the booleans were missing, the oidc-only status means "bound".
    expect(lockedScreenMode('oidc-only', null).xauthOnly).toBe(true);
    expect(isXAuthOnlyLocked(bound)).toBe(true);
  });

  it('keeps the password form and adds the button for a not-yet-bound user', () => {
    expect(lockedScreenMode('needs-password', active)).toEqual({
      xauthOnly: false,
      passwordForm: true,
      xauthButton: true,
    });
    expect(lockedScreenMode('needs-setup', active).xauthButton).toBe(true);
    expect(shouldOfferXAuth(active)).toBe(true);
  });

  it('renders exactly today\'s UI when XAuth is inactive', () => {
    expect(lockedScreenMode('needs-password', { oidcEnabled: false, oidcBound: false })).toEqual({
      xauthOnly: false,
      passwordForm: true,
      xauthButton: false,
    });
    expect(lockedScreenMode('needs-setup', null).xauthButton).toBe(false);
  });

  it('builds absolute XAuth URLs', () => {
    expect(xauthLoginUrl('https://hub.example.com/')).toBe('https://hub.example.com/auth/login');
    expect(xauthLogoutUrl('https://hub.example.com')).toBe('https://hub.example.com/auth/logout');
    expect(xauthReturnPath('tok/en')).toBe('/my/tok%2Fen');
    expect(oidcRedirectUri('https://hub.example.com/')).toBe('https://hub.example.com/auth/callback');
    expect(oidcPostLogoutUri('https://hub.example.com')).toBe('https://hub.example.com/auth/logged-out');
  });
});

describe('logout affordance', () => {
  it('uses SSO logout for an XAuth session and local logout otherwise', () => {
    const sso = logoutPlan({ sessionOidc: true }, '/api/user/t/logout');
    expect(sso).toMatchObject({ sso: true, path: '/auth/logout', label: '退出 XAuth 登录' });
    const local = logoutPlan({ sessionOidc: false }, '/api/user/t/logout');
    expect(local).toMatchObject({ sso: false, path: '/api/user/t/logout', label: '退出登录' });
    expect(logoutPlan(null, '/api/user/t/logout').sso).toBe(false);
  });
});

describe('admin form', () => {
  it('omits a blank secret (keep) and flags an explicit clear', () => {
    const base = { enabled: true, issuer: ' https://id.example.com ', clientId: ' c ', clientSecret: '', clearClientSecret: false, scopes: ' openid profile email ' };
    expect(oidcSavePayload(base)).toEqual({
      enabled: true,
      issuer: 'https://id.example.com',
      clientId: 'c',
      scopes: 'openid profile email',
    });
    expect(oidcSavePayload({ ...base, clientSecret: 'new-secret' })).toMatchObject({ clientSecret: 'new-secret' });
    expect(oidcSavePayload({ ...base, clientSecret: 'ignored', clearClientSecret: true })).toEqual({
      enabled: true,
      issuer: 'https://id.example.com',
      clientId: 'c',
      scopes: 'openid profile email',
      clearClientSecret: true,
    });
  });

  it('derives the two URLs from the current origin and labels the secret', () => {
    expect(oidcAdminUrls('https://hub.example.com')).toEqual({
      redirectUri: 'https://hub.example.com/auth/callback',
      postLogoutUri: 'https://hub.example.com/auth/logged-out',
    });
    expect(oidcSecretLabel(true)).toBe('已配置');
    expect(oidcSecretLabel(false)).toBe('未配置');
  });

  it('labels the user binding', () => {
    expect(oidcBindingLabel({ oidcBound: true, oidcEmail: 'a@b.c' })).toBe('已绑定');
    expect(oidcBindingLabel({ oidcBound: false, oidcEmail: 'a@b.c' })).toBe('待认领');
    expect(oidcBindingLabel({ oidcBound: false, oidcEmail: null })).toBe('未预绑');
  });
});

describe('error page', () => {
  it('renders whitelisted codes only and asks to contact the admin', () => {
    expect(oidcErrorPage('unbound')).toMatchObject({ contact: '请联系管理员' });
    expect(oidcErrorPage('conflict')).toMatchObject({ contact: '请联系管理员' });
    expect(oidcErrorPage('state').contact).toBe('');
    // Unknown / hostile input degrades to the generic text (never reflected).
    for (const code of ['<script>', '', undefined, 'toString', 'constructor']) {
      const page = oidcErrorPage(code);
      expect(page.title).toBe('登录失败');
      expect(JSON.stringify(page)).not.toContain('<script>');
    }
  });
});
