// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin login skeleton (P3): password check, signed session cookie,
 * `requireAdmin` gate and the three /api/admin handlers.
 *
 * No Nuxt/Nitro server is started: handlers are called with fake node events
 * that mirror what Nitro provides (the login body arrives as a readable
 * stream, request cookies in the `cookie` header). Every credential is a
 * fixture.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import adminLoginHandler from '../server/api/admin/login.post';
import adminLogoutHandler from '../server/api/admin/logout.post';
import adminMeHandler from '../server/api/admin/me.get';
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  DEV_ADMIN_PASSWORD,
  createSessionToken,
  isAdmin,
  isSessionSigningUnavailable,
  login,
  logoutCookieHeader,
  me,
  readCookie,
  requireAdmin,
  resolveAdminPassword,
  sessionCookieHeader,
  verifyAdminPassword,
  verifySessionToken,
} from '../server/utils/admin-auth';
import { LOGIN_MISCONFIGURED_ERROR } from '../server/api/admin/login.post';
import {
  createLoginThrottle,
  LOGIN_GLOBAL_KEY,
  LOGIN_MAX_FAILURES_PER_IP,
  LOGIN_UNKNOWN_IP_KEY,
} from '../server/utils/login-throttle';

const PASSWORD = 'correct-horse-battery';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = PASSWORD;
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

type HeaderStore = Record<string, string>;

/**
 * Fake Nitro event. With `streamBody` the body is emitted asynchronously like
 * a real node request; with `jsonBody: null` there is no payload at all.
 */
function makeEvent(
  options: {
    method?: string;
    cookie?: string;
    /** Object payload (sent as JSON) or a raw string. */
    body?: unknown;
    /** Skip sending any body / content-length (stream case). */
    noBody?: boolean;
    /** Socket peer used as the login throttle key. */
    remoteAddress?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: 'localhost',
  };
  if (options.cookie) headers.cookie = options.cookie;

  let payload: string | undefined;
  if (!options.noBody && options.body !== undefined) {
    payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    headers['content-length'] = String(Buffer.byteLength(payload));
  }

  const req = Object.assign(new EventEmitter(), {
    method: options.method ?? 'GET',
    url: '/',
    headers,
    socket: options.remoteAddress ? { remoteAddress: options.remoteAddress } : undefined,
  });

  const responseHeaders: HeaderStore = {};
  const event = {
    node: {
      req,
      res: {
        statusCode: 200,
        setHeader(name: string, value: string) {
          responseHeaders[name.toLowerCase()] = String(value);
        },
      },
    },
  };

  if (payload !== undefined) {
    // Emit after the handler has attached its listeners.
    setImmediate(() => {
      req.emit('data', Buffer.from(payload));
      req.emit('end');
    });
  } else {
    // A bodyless request still ends the stream.
    setImmediate(() => req.emit('end'));
  }

  return { event, headers: responseHeaders };
}

/** Event carrying a freshly signed session cookie. */
function authenticatedEvent(now?: () => number) {
  const token = createSessionToken({ now });
  return makeEvent({ cookie: `${ADMIN_COOKIE}=${token}` });
}

describe('admin password', () => {
  it('accepts exactly the configured SUBHUB_ADMIN_PASSWORD', () => {
    expect(verifyAdminPassword(PASSWORD)).toBe(true);
    expect(verifyAdminPassword('correct-horse-batterY')).toBe(false);
    expect(verifyAdminPassword('')).toBe(false);
    expect(verifyAdminPassword(undefined)).toBe(false);
    expect(verifyAdminPassword(null)).toBe(false);
    expect(verifyAdminPassword(123)).toBe(false);
  });

  it('can refuse the local test password for non-browser callers', () => {
    delete process.env.SUBHUB_ADMIN_PASSWORD;
    expect(verifyAdminPassword(DEV_ADMIN_PASSWORD, { allowDevDefault: false })).toBe(false);
    process.env.SUBHUB_ADMIN_PASSWORD = PASSWORD;
    expect(verifyAdminPassword(PASSWORD, { allowDevDefault: false })).toBe(true);
  });

  it('uses the fixed local test password when none is configured', () => {
    delete process.env.SUBHUB_ADMIN_PASSWORD;
    expect(resolveAdminPassword()).toBe(DEV_ADMIN_PASSWORD);
    expect(verifyAdminPassword(DEV_ADMIN_PASSWORD)).toBe(true);
  });

  it('fails closed in production when no password is configured', () => {
    delete process.env.SUBHUB_ADMIN_PASSWORD;
    process.env.NODE_ENV = 'production';
    expect(resolveAdminPassword()).toBeNull();
    expect(verifyAdminPassword(DEV_ADMIN_PASSWORD)).toBe(false);
    expect(verifyAdminPassword('anything')).toBe(false);
  });
});

describe('session cookie', () => {
  it('signs a token that round-trips', () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
    expect(isAdmin(authenticatedEvent().event as never)).toBe(true);
    expect(me(authenticatedEvent().event as never)).toEqual({ authenticated: true });
  });

  it('rejects tampered, malformed and missing tokens', () => {
    const [version, expires, signature] = createSessionToken().split('.');
    const forgedExpiry = `${version}.${Number(expires) + 3600}.${signature}`;
    expect(verifySessionToken(forgedExpiry)).toBe(false);
    expect(verifySessionToken(`${version}.${expires}.${signature}x`)).toBe(false);
    expect(verifySessionToken('not-a-token')).toBe(false);
    expect(verifySessionToken('')).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
    expect(isAdmin(makeEvent().event as never)).toBe(false);
  });

  it('rejects tokens signed with another secret', () => {
    const token = createSessionToken({ secret: 'other-secret' });
    expect(verifySessionToken(token)).toBe(false);
  });

  it('rejects expired tokens', () => {
    const expired = createSessionToken({
      now: () => Date.now() - (ADMIN_SESSION_TTL_SECONDS + 60) * 1000,
    });
    expect(verifySessionToken(expired)).toBe(false);
  });

  it('sets HttpOnly/SameSite and Secure in production only', () => {
    const cookie = sessionCookieHeader(createSessionToken());
    expect(cookie.startsWith(`${ADMIN_COOKIE}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${ADMIN_SESSION_TTL_SECONDS}`);
    expect(cookie).not.toContain('Secure');

    const prodCookie = sessionCookieHeader(createSessionToken(), { nodeEnv: 'production' });
    expect(prodCookie).toContain('Secure');
  });

  it('clears the cookie on logout', () => {
    const cleared = logoutCookieHeader();
    expect(cleared.startsWith(`${ADMIN_COOKIE}=;`)).toBe(true);
    expect(cleared).toContain('Max-Age=0');
  });

  it('reads cookies from the Cookie header', () => {
    const event = makeEvent({ cookie: 'a=1; subhub_admin=xyz; b=2' }).event;
    expect(readCookie(event as never, ADMIN_COOKIE)).toBe('xyz');
    expect(readCookie(event as never, 'missing')).toBeUndefined();
  });
});

describe('requireAdmin', () => {
  it('throws 401 without a session', () => {
    expect(() => requireAdmin(makeEvent().event as never)).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
    expect(me(makeEvent().event as never)).toEqual({ authenticated: false });
  });

  it('throws 401 for an invalid session cookie', () => {
    const { event } = makeEvent({ cookie: `${ADMIN_COOKIE}=bogus` });
    expect(() => requireAdmin(event as never)).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('throws 401 for an expired session', () => {
    const expired = createSessionToken({
      now: () => Date.now() - (ADMIN_SESSION_TTL_SECONDS + 60) * 1000,
    });
    const { event } = makeEvent({ cookie: `${ADMIN_COOKIE}=${expired}` });
    expect(() => requireAdmin(event as never)).toThrowError(
      expect.objectContaining({ statusCode: 401 }),
    );
  });

  it('passes with a valid session', () => {
    expect(() => requireAdmin(authenticatedEvent().event as never)).not.toThrow();
  });
});

describe('missing SUBHUB_SECRET in production', () => {
  beforeEach(() => {
    delete process.env.SUBHUB_SECRET;
    process.env.NODE_ENV = 'production';
  });

  it('refuses to sign a new session', () => {
    expect(isSessionSigningUnavailable()).toBe(true);
    expect(() => createSessionToken()).toThrowError(/SUBHUB_SECRET/);
    expect(login(PASSWORD)).toBeNull();
  });

  it('refuses to verify a session (fail closed)', () => {
    // A token signed with the public dev key must not be accepted either.
    const devToken = createSessionToken({
      nodeEnv: 'development',
      secret: null,
    });
    expect(verifySessionToken(devToken)).toBe(false);
    expect(isAdmin(makeEvent({ cookie: `${ADMIN_COOKIE}=${devToken}` }).event as never)).toBe(
      false,
    );
    const { event } = makeEvent({ cookie: `${ADMIN_COOKIE}=${devToken}` });
    expect(me(event as never)).toEqual({ authenticated: false });
  });

  it('login answers 500 and sets no cookie', async () => {
    const { event, headers } = makeEvent({ method: 'POST', body: { password: PASSWORD } });
    const body = await adminLoginHandler(event as never);
    expect(event.node.res.statusCode).toBe(500);
    // Generic message: the missing setting is a server-side detail only.
    expect(body).toEqual({ error: LOGIN_MISCONFIGURED_ERROR });
    expect(JSON.stringify(body)).not.toContain('SUBHUB_SECRET');
    expect(headers['set-cookie']).toBeUndefined();
    expect(headers['cache-control']).toBe('no-store');
  });

  it('still signs normally outside production or with a secret', () => {
    process.env.NODE_ENV = 'development';
    expect(isSessionSigningUnavailable()).toBe(false);
    expect(verifySessionToken(createSessionToken())).toBe(true);

    process.env.NODE_ENV = 'production';
    process.env.SUBHUB_SECRET = 'test-signing-secret';
    expect(isSessionSigningUnavailable()).toBe(false);
    expect(verifySessionToken(createSessionToken())).toBe(true);
  });
});

describe('login', () => {
  it('returns a cookie only for the right password', () => {
    const ok = login(PASSWORD);
    expect(ok).not.toBeNull();
    expect(verifySessionToken(ok!.token)).toBe(true);
    expect(login('wrong')).toBeNull();
    expect(login('')).toBeNull();
  });
});

describe('/api/admin handlers', () => {
  it('login 200 + HttpOnly Set-Cookie on the right password', async () => {
    const { event, headers } = makeEvent({ method: 'POST', body: { password: PASSWORD } });
    expect(await adminLoginHandler(event as never)).toEqual({ ok: true });
    expect(event.node.res.statusCode).toBe(200);
    const cookie = headers['set-cookie'];
    expect(cookie).toContain(`${ADMIN_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(headers['cache-control']).toBe('no-store');

    // The cookie grants access; the response body never echoes the token.
    const token = cookie.split(';')[0].split('=')[1];
    const { event: authed } = makeEvent({ cookie: `${ADMIN_COOKIE}=${token}` });
    expect(adminMeHandler(authed as never)).toEqual({ authenticated: true });
  });

  it('login 401 without setting a cookie on a wrong password', async () => {
    const { event, headers } = makeEvent({ method: 'POST', body: { password: 'wrong' } });
    expect(await adminLoginHandler(event as never)).toEqual({ error: 'invalid password' });
    expect(event.node.res.statusCode).toBe(401);
    expect(headers['set-cookie']).toBeUndefined();
  });

  it('login 400 when the password is missing or malformed', async () => {
    for (const body of [{}, { password: '' }, { password: 42 }, 'not json']) {
      const { event, headers } = makeEvent({ method: 'POST', body });
      expect(await adminLoginHandler(event as never)).toEqual({ error: 'password required' });
      expect(event.node.res.statusCode).toBe(400);
      expect(headers['set-cookie']).toBeUndefined();
    }
    const { event } = makeEvent({ method: 'POST' });
    expect(await adminLoginHandler(event as never)).toEqual({ error: 'password required' });
    expect(event.node.res.statusCode).toBe(400);
  });

  it('login rejects an oversized body', async () => {
    const { event, headers } = makeEvent({
      method: 'POST',
      body: { password: 'x'.repeat(5000) },
    });
    expect(await adminLoginHandler(event as never)).toEqual({ error: 'password required' });
    expect(event.node.res.statusCode).toBe(400);
    expect(headers['set-cookie']).toBeUndefined();
  });

  it('me reports false anonymously and true with a session', () => {
    const anon = makeEvent();
    expect(adminMeHandler(anon.event as never)).toEqual({ authenticated: false });
    expect(anon.headers['cache-control']).toBe('no-store');
    expect(
      adminMeHandler(makeEvent({ cookie: `${ADMIN_COOKIE}=bogus` }).event as never),
    ).toEqual({ authenticated: false });
  });

  it('logout clears the cookie', () => {
    const { event, headers } = makeEvent({ method: 'POST' });
    expect(adminLogoutHandler(event as never)).toEqual({ ok: true });
    expect(headers['set-cookie']).toContain(`${ADMIN_COOKIE}=;`);
    expect(headers['set-cookie']).toContain('Max-Age=0');
  });
});

describe('login brute-force throttle', () => {
  function freshThrottle() {
    let clock = 1_000_000;
    const throttle = createLoginThrottle({ now: () => clock });
    return { throttle, advance: (ms: number) => (clock += ms) };
  }

  function attempt(
    throttle: ReturnType<typeof createLoginThrottle>,
    password: unknown,
    remoteAddress = '203.0.113.7',
  ) {
    const { event, headers } = makeEvent({
      method: 'POST',
      body: { password },
      remoteAddress,
    });
    return adminLoginHandler(event as never, { throttle }).then((body) => ({
      body,
      status: event.node.res.statusCode,
      headers,
    }));
  }

  it('answers 429 after 5 failures from one IP and sets no cookie', async () => {
    const { throttle } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      expect(await attempt(throttle, 'wrong')).toMatchObject({
        body: { error: 'invalid password' },
        status: 401,
      });
    }
    const blocked = await attempt(throttle, 'wrong');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'too many attempts' });
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(blocked.headers['set-cookie']).toBeUndefined();
  });

  it('blocks the correct password too while the IP is over the limit', async () => {
    const { throttle } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) await attempt(throttle, 'wrong');
    expect(await attempt(throttle, PASSWORD)).toMatchObject({ status: 429 });
  });

  it('does not count successful logins and refunds their attempt', async () => {
    const { throttle } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP - 1; i += 1) {
      await attempt(throttle, 'wrong');
    }
    const ok = await attempt(throttle, PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']).toContain(`${ADMIN_COOKIE}=`);
    // One failure left, then blocked: success did not consume it.
    expect((await attempt(throttle, 'wrong')).status).toBe(401);
    expect((await attempt(throttle, 'wrong')).status).toBe(429);
  });

  it('keeps IP buckets independent', async () => {
    const { throttle } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      await attempt(throttle, 'wrong', '198.51.100.1');
    }
    expect((await attempt(throttle, 'wrong', '198.51.100.1')).status).toBe(429);
    expect((await attempt(throttle, 'wrong', '198.51.100.2')).status).toBe(401);
  });

  it('shares one bucket for requests without a client address', async () => {
    const { throttle } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      expect(throttle.consume('').allowed).toBe(true);
    }
    expect(throttle.consume('')).toMatchObject({ allowed: false });
    expect(throttle.consume(LOGIN_UNKNOWN_IP_KEY)).toMatchObject({ allowed: false });
  });

  it('enforces the global failure cap across many IPs', async () => {
    let clock = 0;
    const throttle = createLoginThrottle({ now: () => clock, maxGlobal: 3, maxPerIp: 2 });
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.consume(`ip-${i}`).allowed).toBe(true);
    }
    const blocked = throttle.consume('ip-3');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(15 * 60);
    // The refused IP still owns an (unused) bucket, but the map stays bounded.
    expect(throttle.size()).toBe(4 + 1);
    clock += 15 * 60 * 1000;
    expect(throttle.consume('ip-3').allowed).toBe(true);
  });

  it('opens a new window after 15 minutes', () => {
    const { throttle, advance } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      expect(throttle.consume('203.0.113.9').allowed).toBe(true);
    }
    expect(throttle.consume('203.0.113.9').allowed).toBe(false);
    advance(15 * 60 * 1000 - 1);
    expect(throttle.consume('203.0.113.9').allowed).toBe(false);
    advance(1);
    expect(throttle.consume('203.0.113.9').allowed).toBe(true);
  });

  it('bounds the map of tracked IPs', () => {
    const throttle = createLoginThrottle({ maxPerIp: 1, maxKeys: 4, maxGlobal: 1_000_000 });
    for (let i = 0; i < 1_000; i += 1) throttle.consume(`10.0.0.${i}`);
    // 4 IP buckets + the single global bucket.
    expect(throttle.size()).toBe(4 + 1);
    expect(LOGIN_GLOBAL_KEY).toBe('global');
  });
});
