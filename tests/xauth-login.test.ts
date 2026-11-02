// SPDX-License-Identifier: AGPL-3.0-only
/**
 * XAuth (OIDC) login for the `/my` user center — integration suite.
 *
 * A tiny **real-HTTP** stub IdP (`tests/helpers/stub-idp.ts`: discovery doc,
 * `/authorize`, `/token` issuing RS256 ID tokens signed with a generated key,
 * `/keys` JWKS, `/userinfo`, `/end_session`) drives the actual route handlers, so
 * openid-client performs genuine discovery, JWKS fetching and ID-token
 * verification — nothing about the protocol is mocked.
 *
 * Asserted (brief): the authorize URL carries S256 + state + nonce; the first
 * login claims the binding (sub written, session minted, lands on /my/<token>);
 * a later login matches by sub even when the email drifts; unverified email /
 * unknown identity → unbound; duplicate pre-filled email → conflict; state
 * mismatch → rejected; disabled user → rejected; a bound user's password unlock
 * is 401 `oidc-only`, unbinding restores it; settings GET never contains the
 * secret; /auth/login 404s while inactive; the gate lets /auth/login through
 * without the knock cookie; logout builds the exact end_session URL.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SubhubDb } from '../server/db';
import { settings, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import {
  OIDC_FLOW_COOKIE,
  OIDC_IDT_COOKIE,
  activeOidcConfig,
  invalidateOidcConfigCache,
  readFlowCookie,
  readIdTokenCookie,
} from '../server/utils/oidc';
import { USER_SESSION_COOKIE, verifyUserSession } from '../server/utils/user-session';
import authLoginHandler from '../server/routes/auth/login.get';
import authCallbackHandler from '../server/routes/auth/callback.get';
import authLogoutHandler from '../server/routes/auth/logout.get';
import authLoggedOutPage from '../server/routes/auth/logged-out.get';
import authErrorPage from '../server/routes/auth/error.get';
import userCenterReadHandler from '../server/api/user/[token].get';
import userUnlockHandler from '../server/api/user/[token]/unlock.post';
import userPasswordSetupHandler from '../server/api/user/[token]/password.post';
import userLogoutHandler from '../server/api/user/[token]/logout.post';
import adminSettingsGetHandler from '../server/api/admin/settings/index.get';
import adminSettingsPutHandler from '../server/api/admin/settings/index.put';
import usersCreateHandler from '../server/api/admin/users/index.post';
import userUpdateHandler from '../server/api/admin/users/[id].patch';
import { hashPassword } from '../server/utils/user-password';
import {
  flowCookieValue,
  startStubBrowserServer,
  startStubIdp,
  type StubBrowserServer,
  type StubIdp,
  type StubIdentity,
} from './helpers/stub-idp';
import {
  headerOf,
  routeEvent,
  runGate,
  runMiddlewares,
  setCookiesOf,
  type RecordedResponse,
} from './helpers/route-event';
import { authenticatedEvent } from './helpers/admin-api';

const TOKEN = 'xauth0000token0000alice0000000001';
const TOKEN_BOB = 'xauth0000token0000bobby0000000002';
const PASSWORD = 'correct horse battery';
/** The secret the stub actually accepts (exposed by the helper). */
let CLIENT_SECRET = '';

const dirs: string[] = [];
let db: SubhubDb;
let idp: StubIdp;
let browserOrigin: StubBrowserServer;

beforeAll(async () => {
  idp = await startStubIdp();
  CLIENT_SECRET = idp.clientSecret;
  browserOrigin = await startStubBrowserServer();
});

afterAll(async () => {
  await idp.close();
  await browserOrigin.close();
});

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'subhub-xauth-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
  idp.authorizeRequests.length = 0;
  idp.tokenRequests.length = 0;
  idp.userinfoRequests.length = 0;
  idp.endSessionRequests.length = 0;
  idp.nextAuthorize = null;
  idp.nextToken = null;
  seedSettings();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  invalidateOidcConfigCache();
});

/* ----------------------------------------------------------------- setup -- */

function seedSettings(enabled = true) {
  const rows: Array<[string, string]> = [
    ['oidc_enabled', enabled ? '1' : '0'],
    ['oidc_issuer', idp.issuer],
    ['oidc_client_id', idp.clientId],
    ['oidc_client_secret', encrypt(CLIENT_SECRET)],
  ];
  for (const [key, value] of rows) {
    db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
  }
}

function seedUser(options: {
  token?: string;
  name?: string;
  enabled?: boolean;
  password?: string | null;
  oidcEmail?: string | null;
  oidcSub?: string | null;
}) {
  return db
    .insert(users)
    .values({
      name: options.name ?? 'fixture-user',
      token: options.token ?? TOKEN,
      enabled: options.enabled ?? true,
      passwordHash: options.password ? hashPassword(options.password) : null,
      passwordVersion: options.password ? 1 : 0,
      oidcEmail: options.oidcEmail ?? null,
      oidcSub: options.oidcSub ?? null,
    })
    .returning()
    .get()!;
}

function userRow(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get()!;
}

/**
 * Run a route handler against the recorded event and return both the event
 * (status/headers/body) and the JSON body the API handlers return.
 *
 * The status is read from `event.node.res.statusCode` AFTER the handler
 * resolved: a JSON API handler returns its body and lets Nitro write it, so
 * `end()` never runs for those routes (and a status recorded only in `end()`
 * would stay 0).
 */
async function runRoute(
  handler: (event: never, options: { db: SubhubDb }) => unknown,
  url: string,
  options: {
    cookie?: string | null;
    host?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<RecordedResponse & { result: unknown }> {
  const recorded = routeEvent(url, options);
  const result = await handler(recorded.event, { db });

  return { ...recorded, result };
}

/** Cookie header carrying just these raw `Set-Cookie` values. */
function cookieHeader(setCookies: readonly string[], names: string[] = [OIDC_FLOW_COOKIE]): string {
  const pairs: string[] = [];
  for (const name of names) {
    const value = flowCookieValue(setCookies, name);
    if (value) pairs.push(`${name}=${encodeURIComponent(value)}`);
  }
  return pairs.join('; ');
}

interface LoginStep {
  login: RecordedResponse;
  authorizeUrl: URL;
  callbackUrl: string;
  flowCookie: string;
}

/**
 * GET /auth/login (real handler) → follow the stub's authorization redirect
 * exactly like a browser (`fetch`, manual redirect). The identity to authorize
 * as is registered with the stub BEFORE the authorize hit.
 */
async function startLogin(identity: StubIdentity, host = 'subhub.test'): Promise<LoginStep> {
  const login = await runRoute(authLoginHandler, '/auth/login', {
    host,
    headers: { 'x-forwarded-proto': 'http' },
  });
  expect(login.status, `login should redirect (${JSON.stringify(login.headers)})`).toBe(302);
  const authorizeUrl = new URL(headerOf(login, 'location')!);
  idp.nextAuthorize = { identity };
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  const callbackUrl = authorize.headers.get('location');
  expect(callbackUrl, 'stub /authorize must redirect back').toBeTruthy();
  const flowCookie = flowCookieValue(setCookiesOf(login), OIDC_FLOW_COOKIE);
  expect(flowCookie, 'login must set the flow cookie').toBeTruthy();
  return { login, authorizeUrl, callbackUrl: callbackUrl!, flowCookie: flowCookie! };
}

/** Full login: /auth/login → stub → /auth/callback; returns the callback reply. */
async function loginAs(identity: StubIdentity): Promise<{ step: LoginStep; callback: RecordedResponse }> {
  const step = await startLogin(identity);
  const callback = await runRoute(authCallbackHandler, step.callbackUrl, {
    cookie: `${OIDC_FLOW_COOKIE}=${encodeURIComponent(step.flowCookie)}`,
  });
  return { step, callback };
}

/** `subhub_my=…; subhub_oidc_idt=…` for a successful XAuth login. */
function sessionCookie(sets: readonly string[]): string {
  return cookieHeader(sets, [USER_SESSION_COOKIE, OIDC_IDT_COOKIE]);
}

/* ---------------------------------------------------------------- tests -- */

describe('authorize URL', () => {
  it('carries PKCE S256, per-attempt state and nonce, and the configured scope', async () => {
    const first = await runRoute(authLoginHandler, '/auth/login', { host: 'subhub.test' });
    const second = await runRoute(authLoginHandler, '/auth/login', { host: 'subhub.test' });
    const url = new URL(headerOf(first, 'location')!);
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('scope')).not.toContain('offline_access');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe('http://subhub.test/auth/callback');

    // Fresh value per attempt; the flow cookie holds them (encrypted+signed).
    const other = new URL(headerOf(second, 'location')!);
    expect(other.searchParams.get('state')).not.toBe(url.searchParams.get('state'));
    expect(other.searchParams.get('nonce')).not.toBe(url.searchParams.get('nonce'));
    const flow = readFlowCookie(flowCookieValue(setCookiesOf(first), OIDC_FLOW_COOKIE));
    expect(flow?.state).toBe(url.searchParams.get('state'));
    expect(flow?.nonce).toBe(url.searchParams.get('nonce'));
    expect(flow?.verifier).toBeTruthy();
  });

  it('uses the forwarded origin for redirect_uri behind a proxy', async () => {
    const response = await runRoute(authLoginHandler, '/auth/login', {
      host: '127.0.0.1:3000',
      headers: { 'x-forwarded-host': 'hub.example.com', 'x-forwarded-proto': 'https' },
    });
    const url = new URL(headerOf(response, 'location')!);
    expect(url.searchParams.get('redirect_uri')).toBe('https://hub.example.com/auth/callback');
  });

  it('404s (no redirect) whenever XAuth is inactive', async () => {
    seedSettings(false);
    const disabled = await runRoute(authLoginHandler, '/auth/login', {});
    expect(disabled.status).toBe(404);
    expect(headerOf(disabled, 'location')).toBeUndefined();
    // Enabled but missing the secret: still inactive.
    seedSettings(true);
    db.delete(settings).where(eq(settings.key, 'oidc_client_secret')).run();
    expect(await runRoute(authLoginHandler, '/auth/login', {})).toMatchObject({ status: 404 });
    // ...and the callback also 404s while inactive.
    seedSettings(false);
    const callback = await runRoute(authCallbackHandler, '/auth/callback?code=x&state=y', {});
    expect(callback.status).toBe(404);
    // Logout is deliberately exempt from the active check: ending a session (and
    // clearing the cookies) must never depend on the IdP still being configured.
    const logout = await runRoute(authLogoutHandler, '/auth/logout', {});
    expect(logout.status).toBe(302);
    expect(headerOf(logout, 'location')).toBe('/auth/logged-out');
  });
});

describe('binding lifecycle', () => {
  it('first login claims the pre-filled email, mints the /my session and lands on /my/<token>', async () => {
    const user = seedUser({ oidcEmail: 'alice@example.com', password: PASSWORD });
    const { step, callback } = await loginAs({ sub: 'sub-alice-1', email: 'Alice@Example.com', email_verified: true });

    expect(callback.status).toBe(302);
    expect(headerOf(callback, 'location')).toBe(`/my/${TOKEN}`);
    expect(userRow(user.id).oidcSub).toBe('sub-alice-1');

    // The grant carried the PKCE verifier and a client-authenticated request.
    const grant = idp.tokenRequests.at(-1)!;
    expect(grant.grant_type).toBe('authorization_code');
    expect(grant.code_verifier).toBeTruthy();
    expect(grant.client_id).toBe(idp.clientId);
    expect(grant.client_secret).toBe(CLIENT_SECRET);
    // The stub really was redirected with the S256 challenge by the server.
    expect(idp.authorizeRequests.at(-1)!.code_challenge_method).toBe('S256');

    const sets = setCookiesOf(callback);
    // The minted session is the existing one (user id + password version).
    const sessionToken = flowCookieValue(sets, USER_SESSION_COOKIE)!;
    const session = verifyUserSession(sessionToken);
    expect(session?.userId).toBe(user.id);
    const idt = readIdTokenCookie(flowCookieValue(sets, OIDC_IDT_COOKIE));
    expect(idt?.userId).toBe(user.id);
    expect(idt?.idToken.split('.')).toHaveLength(3);
    // The flow cookie is cleared on success.
    expect(sets.some((cookie) => cookie.startsWith(`${OIDC_FLOW_COOKIE}=;`))).toBe(true);

    // That cookie unlocks the existing user-center guard unchanged.
    const readCtx = routeEvent(`/api/user/${TOKEN}`, { cookie: sessionCookie(sets) });
    const payload = (await userCenterReadHandler(readCtx.event, { db })) as {
      user: { name: string; sessionOidc: boolean; oidcBound: boolean };
    };
    expect(payload.user.sessionOidc).toBe(true);
    expect(payload.user.oidcBound).toBe(true);

    // The very same route, anonymous, is now `oidc-only` (password disabled).
    const anonymous = routeEvent(`/api/user/${TOKEN}`);
    const anonymousBody = await userCenterReadHandler(anonymous.event, { db });
    expect(anonymous.status).toBe(401);
    expect(anonymousBody).toMatchObject({ status: 'oidc-only', oidcEnabled: true, oidcBound: true });
    void step;
  });

  it('a claimed user who never set a password can use the callback-minted session', async () => {
    // Regression: the password-era `userSessionMatches` required a password
    // hash, so a password-less claim landed on /my only to be answered
    // 401 oidc-only by the guard — an infinite login loop (caught by the
    // built-server smoke, whose user had no password).
    const user = seedUser({ oidcEmail: 'alice@example.com' });
    expect(userRow(user.id).passwordHash).toBeNull();
    const { callback } = await loginAs({ sub: 'sub-alice-nopw', email: 'alice@example.com', email_verified: true });
    expect(headerOf(callback, 'location')).toBe(`/my/${TOKEN}`);
    expect(userRow(user.id).oidcSub).toBe('sub-alice-nopw');

    const sets = setCookiesOf(callback);
    const readCtx = routeEvent(`/api/user/${TOKEN}`, { cookie: sessionCookie(sets) });
    const payload = (await userCenterReadHandler(readCtx.event, { db })) as {
      user: { sessionOidc: boolean; oidcBound: boolean };
    };
    expect(payload.user.sessionOidc).toBe(true);
    expect(payload.user.oidcBound).toBe(true);
  });

  it('matches by sub afterwards, even when the IdP reports a different email', async () => {
    const user = seedUser({ oidcEmail: 'alice@example.com', oidcSub: 'sub-alice-2' });
    const { callback } = await loginAs({ sub: 'sub-alice-2', email: 'renamed@example.org', email_verified: true });
    expect(headerOf(callback, 'location')).toBe(`/my/${TOKEN}`);
    expect(userRow(user.id).oidcSub).toBe('sub-alice-2');
    expect(userRow(user.id).oidcEmail).toBe('alice@example.com');
  });

  it('falls back to /userinfo when the ID token has no email (subject must match)', async () => {
    const user = seedUser({ oidcEmail: 'info@example.com' });
    const { callback } = await loginAs({
      sub: 'sub-info',
      email: 'info@example.com',
      email_verified: true,
      emailInUserinfoOnly: true,
    });
    expect(headerOf(callback, 'location')).toBe(`/my/${TOKEN}`);
    expect(userRow(user.id).oidcSub).toBe('sub-info');
    expect(idp.userinfoRequests).toHaveLength(1);
    expect(idp.userinfoRequests[0]!.authorization).toMatch(/^Bearer at-/);
  });

  it('never claims with email_verified !== true', async () => {
    const user = seedUser({ oidcEmail: 'alice@example.com' });
    for (const identity of [
      { sub: 'sub-x', email: 'alice@example.com', email_verified: false },
      { sub: 'sub-y', email: 'alice@example.com' },
    ]) {
      const { callback } = await loginAs(identity);
      expect(headerOf(callback, 'location')).toBe('/auth/error?code=unbound');
      expect(userRow(user.id).oidcSub).toBeNull();
      // No session is ever minted for a rejected identity.
      expect(setCookiesOf(callback).some((cookie) => cookie.startsWith(`${USER_SESSION_COOKIE}=`))).toBe(false);
    }
  });

  it('rejects an unknown identity (no JIT provisioning)', async () => {
    const before = db.select().from(users).all().length;
    const { callback } = await loginAs({ sub: 'stranger', email: 'stranger@example.com', email_verified: true });
    expect(headerOf(callback, 'location')).toBe('/auth/error?code=unbound');
    expect(db.select().from(users).all()).toHaveLength(before);
  });

  it('answers conflict when two users hold the same pre-filled email', async () => {
    const a = seedUser({ oidcEmail: 'dup@example.com' });
    const b = seedUser({ token: TOKEN_BOB, name: 'bob', oidcEmail: 'dup@example.com' });
    const { callback } = await loginAs({ sub: 'sub-dup', email: 'dup@example.com', email_verified: true });
    expect(headerOf(callback, 'location')).toBe('/auth/error?code=conflict');
    expect(userRow(a.id).oidcSub).toBeNull();
    expect(userRow(b.id).oidcSub).toBeNull();
  });

  it('rejects a disabled user (bound or not)', async () => {
    const bound = seedUser({ oidcSub: 'sub-disabled', enabled: false });
    const unbound = seedUser({ token: TOKEN_BOB, name: 'bob', oidcEmail: 'bob@example.com', enabled: false });
    const boundLogin = await loginAs({ sub: 'sub-disabled', email: 'x@example.com', email_verified: true });
    expect(headerOf(boundLogin.callback, 'location')).toBe('/auth/error?code=disabled');
    const unboundLogin = await loginAs({ sub: 'sub-bob', email: 'bob@example.com', email_verified: true });
    expect(headerOf(unboundLogin.callback, 'location')).toBe('/auth/error?code=disabled');
    expect(userRow(bound.id).oidcSub).toBe('sub-disabled');
    expect(userRow(unbound.id).oidcSub).toBeNull();
  });

  it('rejects a state mismatch and a missing/tampered flow cookie', async () => {
    seedUser({ oidcEmail: 'alice@example.com' });
    const step = await startLogin({ sub: 'sub-state', email: 'alice@example.com', email_verified: true });
    const tampered = new URL(step.callbackUrl);
    tampered.searchParams.set('state', 'attacker-state');
    const mismatch = await runRoute(authCallbackHandler, tampered.toString(), {
      cookie: `${OIDC_FLOW_COOKIE}=${encodeURIComponent(step.flowCookie)}`,
    });
    expect(headerOf(mismatch, 'location')).toBe('/auth/error?code=state');
    // No token exchange is even attempted for a mismatched state.
    expect(idp.tokenRequests).toHaveLength(0);

    const missing = await runRoute(authCallbackHandler, step.callbackUrl, {});
    expect(headerOf(missing, 'location')).toBe('/auth/error?code=state');

    const forged = await runRoute(authCallbackHandler, step.callbackUrl, {
      cookie: `${OIDC_FLOW_COOKIE}=v1.${Buffer.from('{"state":"x"}').toString('base64')}.forged`,
    });
    expect(headerOf(forged, 'location')).toBe('/auth/error?code=state');
  });

  it('maps a provider error response to the provider code', async () => {
    seedUser({ oidcEmail: 'alice@example.com' });
    const login = await runRoute(authLoginHandler, '/auth/login', {});
    const authorizeUrl = new URL(headerOf(login, 'location')!);
    idp.nextAuthorize = { error: 'access_denied' };
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    const callback = await runRoute(authCallbackHandler, authorize.headers.get('location')!, {
      cookie: `${OIDC_FLOW_COOKIE}=${encodeURIComponent(flowCookieValue(setCookiesOf(login), OIDC_FLOW_COOKIE)!)}`,
    });
    expect(headerOf(callback, 'location')).toBe('/auth/error?code=state');
  });
});

describe('password login of a bound user', () => {
  it('rejects unlock/setup with 401 oidc-only even for the correct password', async () => {
    seedUser({ password: PASSWORD, oidcSub: 'sub-alice', oidcEmail: 'alice@example.com' });
    const unlock = routeEvent(`/api/user/${TOKEN}/unlock`, { method: 'POST', body: { password: PASSWORD } });
    const unlockBody = await userUnlockHandler(unlock.event, { db });
    expect(unlock.status).toBe(401);
    expect(unlockBody).toEqual({
      error: '该账号已绑定 XAuth 单点登录，请使用 XAuth 登录',
      status: 'oidc-only',
      oidcEnabled: true,
      oidcBound: true,
    });
    expect(setCookiesOf(unlock)).toHaveLength(0);

    // Setup (no password) is refused the same way.
    const bob = seedUser({ token: TOKEN_BOB, name: 'bob', oidcSub: 'sub-bob' });
    const setup = routeEvent(`/api/user/${TOKEN_BOB}/password`, { method: 'POST', body: { password: PASSWORD } });
    const setupBody = await userPasswordSetupHandler(setup.event, { db });
    expect(setup.status).toBe(401);
    expect(setupBody).toMatchObject({ status: 'oidc-only' });
    expect(userRow(bob.id).passwordHash).toBeNull();
  });

  it('restores password login after the admin unbinds', async () => {
    const user = seedUser({ password: PASSWORD, oidcSub: 'sub-alice', oidcEmail: 'alice@example.com' });
    // Admin unbind through the real PATCH route.
    const { event } = authenticatedEvent({ url: `/api/admin/users/${user.id}`, method: 'PATCH', body: { unbind: true } });
    const patched = (await userUpdateHandler(event, { db })) as { item: { oidcBound: boolean; oidcEmail: string } };
    expect(patched.item.oidcBound).toBe(false);
    expect(patched.item.oidcEmail).toBe('alice@example.com');
    expect(userRow(user.id).oidcSub).toBeNull();

    const unlock = routeEvent(`/api/user/${TOKEN}/unlock`, { method: 'POST', body: { password: PASSWORD } });
    await userUnlockHandler(unlock.event, { db });
    expect(unlock.status).toBe(200);
    expect(flowCookieValue(setCookiesOf(unlock), USER_SESSION_COOKIE)).toBeTruthy();
  });
});

describe('admin settings', () => {
  it('never returns the client secret, only clientSecretSet', async () => {
    const { event } = authenticatedEvent({ url: '/api/admin/settings' });
    const settingsView = (await adminSettingsGetHandler(event, { db })) as {
      oidc: Record<string, unknown>;
    };
    expect(settingsView.oidc).toEqual({
      enabled: true,
      active: true,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecretSet: true,
      scopes: 'openid profile email',
      defaultScopes: 'openid profile email',
    });
    const serialised = JSON.stringify(settingsView);
    expect(serialised).not.toContain(CLIENT_SECRET);
    expect(serialised).not.toContain('oidc_client_secret');
    expect(serialised).not.toContain('v1:'); // no ciphertext either
  });

  it('keeps the secret on a blank field, replaces it on a value, clears it explicitly', async () => {
    const put = async (body: Record<string, unknown>) => {
      const { event } = authenticatedEvent({ url: '/api/admin/settings', method: 'PUT', body: { oidc: body } });
      return (await adminSettingsPutHandler(event, { db })) as {
        oidc: { active: boolean; clientSecretSet: boolean; scopes: string; issuer: string };
      };
    };
    const kept = await put({ enabled: true, issuer: idp.issuer, clientId: idp.clientId, clientSecret: '', scopes: '' });
    expect(kept.oidc).toMatchObject({ clientSecretSet: true, active: true, scopes: 'openid profile email' });

    const replaced = await put({ clientSecret: 'rotated-secret' });
    expect(replaced.oidc).toMatchObject({ clientSecretSet: true, active: true });
    expect(activeOidcConfig(db)?.clientSecret).toBe('rotated-secret');
    expect(JSON.stringify(replaced)).not.toContain('rotated-secret');

    const cleared = await put({ clearClientSecret: true });
    expect(cleared.oidc).toMatchObject({ clientSecretSet: false, active: false });

  });

  it('validates issuer and scopes (400)', async () => {
    for (const body of [{ issuer: 'not a url' }, { scopes: 'openid bad scope!' }, { enabled: 'yes' }]) {
      const { event } = authenticatedEvent({ url: '/api/admin/settings', method: 'PUT', body: { oidc: body } });
      const result = await adminSettingsPutHandler(event, { db });
      expect(event.node.res.statusCode, JSON.stringify(body)).toBe(400);
      expect(result).toMatchObject({ error: expect.any(String) });
    }
  });

  it('accepts the pre-bound email on create and rejects duplicates/invalid shapes', async () => {
    const create = async (body: Record<string, unknown>) => {
      const { event } = authenticatedEvent({ url: '/api/admin/users', method: 'POST', body });
      const result = await usersCreateHandler(event, { db });
      return { status: event.node.res.statusCode, result };
    };
    const created = await create({ name: 'first', bindEmail: ' First@Example.com ' });
    expect(created.status).toBe(201);
    expect((created.result as { item: { oidcEmail: string; oidcBound: boolean } }).item).toMatchObject({
      oidcEmail: 'first@example.com',
      oidcBound: false,
    });
    expect((created.result as { item: Record<string, unknown> }).item).not.toHaveProperty('oidcSub');

    expect((await create({ name: 'second', bindEmail: 'FIRST@example.com' })).status).toBe(400);
    expect((await create({ name: 'third', bindEmail: 'not-an-email' })).status).toBe(400);
  });
});

describe('gate exemption', () => {
  it('lets /auth/* through both server middlewares without the admin knock cookie', async () => {
    for (const path of ['/auth/login', '/auth/callback?code=x&state=y', '/auth/logout', '/auth/logged-out', '/auth/error?code=unbound']) {
      expect(runGate(path, null), path).toBeNull();
      // 00-admin-gate AND 01-admin-auth (the admin-API auth middleware) naively treats them as public
      expect(runMiddlewares(path, null), path).toBeNull();
    }
    // Admin surface is still blanked (sanity that the gate is really running).
    expect(runGate('/users', null)?.status).toBe(200);
  });

  it('GET /auth/login answers 302 without any cookie (real middleware + route)', async () => {
    expect(runGate('/auth/login', null)).toBeNull();
    const login = await runRoute(authLoginHandler, '/auth/login', {});
    expect(login.status).toBe(302);
  });
});

describe('logout', () => {
  it('builds the exact end_session URL with the stored id_token hint', async () => {
    const user = seedUser({ oidcEmail: 'alice@example.com' });
    const { callback } = await loginAs({ sub: 'sub-logout', email: 'alice@example.com', email_verified: true });
    const sets = setCookiesOf(callback);
    const idToken = readIdTokenCookie(flowCookieValue(sets, OIDC_IDT_COOKIE))!.idToken;
    expect(userRow(user.id).oidcSub).toBe('sub-logout');

    const logout = await runRoute(authLogoutHandler, '/auth/logout', { cookie: sessionCookie(sets) });
    expect(logout.status).toBe(302);
    const location = new URL(headerOf(logout, 'location')!);
    expect(location.origin + location.pathname).toBe(`${idp.issuer}/end_session`);
    expect(location.searchParams.get('id_token_hint')).toBe(idToken);
    expect(location.searchParams.get('post_logout_redirect_uri')).toBe('http://subhub.test/auth/logged-out');
    expect(location.searchParams.get('client_id')).toBe(idp.clientId);
    // Both local cookies are cleared.
    const cleared = setCookiesOf(logout);
    expect(cleared.some((cookie) => cookie.startsWith(`${USER_SESSION_COOKIE}=;`) && /Max-Age=0/.test(cookie))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith(`${OIDC_IDT_COOKIE}=;`) && /Max-Age=0/.test(cookie))).toBe(true);

    // Following the redirect really reaches the stub (it records the hint).
    await fetch(location, { redirect: 'manual' });
    expect(idp.endSessionRequests.at(-1)!.get('id_token_hint')).toBe(idToken);
  });

  it('lands on /auth/logged-out directly for a local/password session', async () => {
    const logout = await runRoute(authLogoutHandler, '/auth/logout', { cookie: `${USER_SESSION_COOKIE}=whatever` });
    expect(headerOf(logout, 'location')).toBe('/auth/logged-out');
    expect(idp.endSessionRequests).toHaveLength(0);
  });

  it('POST /api/user/:token/logout clears the local cookies', async () => {
    seedUser({ password: PASSWORD });
    const recorded = routeEvent(`/api/user/${TOKEN}/logout`, { method: 'POST' });
    await userLogoutHandler(recorded.event, { db });
    expect(recorded.status).toBe(200);
    const cleared = setCookiesOf(recorded);
    expect(cleared.some((cookie) => cookie.startsWith(`${USER_SESSION_COOKIE}=;`))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith(`${OIDC_IDT_COOKIE}=;`))).toBe(true);
  });
});

describe('standalone pages', () => {
  it('renders the logged-out and the whitelisted error pages without reflecting input', async () => {
    const loggedOut = await runRoute(authLoggedOutPage, '/auth/logged-out', {});
    expect(loggedOut.status).toBe(200);
    expect(headerOf(loggedOut, 'content-type')).toContain('text/html');
    expect(loggedOut.body).toContain('已退出登录');

    const unbound = await runRoute(authErrorPage, '/auth/error?code=unbound', {});
    expect(unbound.body).toContain('请联系管理员');
    const unknown = await runRoute(authErrorPage, '/auth/error?code=%3Cscript%3Ealert(1)%3C%2Fscript%3E', {});
    expect(unknown.body).not.toContain('<script>');
    expect(unknown.body).toContain('登录失败');
  });
});
