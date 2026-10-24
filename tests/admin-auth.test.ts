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
  createKeyedQueue,
  createLoginThrottle,
  LOGIN_GLOBAL_KEY,
  LOGIN_MAX_FAILURES_PER_IP,
  LOGIN_SLOWDOWN_BASE_MS,
  LOGIN_SLOWDOWN_MAX_MS,
  LOGIN_UNKNOWN_IP_KEY,
} from '../server/utils/login-throttle';
import { TRUSTED_IP_HEADER_ENV } from '../server/utils/client-ip';
import { createFakeClock, flushMicrotasks } from './helpers/fake-clock';

const PASSWORD = 'correct-horse-battery';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV', TRUSTED_IP_HEADER_ENV] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = PASSWORD;
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;
  delete process.env[TRUSTED_IP_HEADER_ENV];
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
    /** Value for the trusted forwarding header (see TRUSTED_IP_HEADER_ENV). */
    forwardedFor?: string;
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
  if (options.forwardedFor) headers['x-forwarded-for'] = options.forwardedFor;

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
    // Authenticated answers also carry the effective subscription prefix
    // (`subPath`; the layout seeds its link-building state from it).
    expect(adminMeHandler(authed as never)).toEqual({ authenticated: true, subPath: 's' });
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

  /** Fake slowdown: records the requested delays instead of waiting. */
  function makeSleeper() {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
  }

  async function attempt(
    throttle: ReturnType<typeof createLoginThrottle>,
    password: unknown,
    remoteAddress = '203.0.113.7',
    sleep: (ms: number) => Promise<void> = async () => {},
  ) {
    const { event, headers } = makeEvent({
      method: 'POST',
      body: { password },
      remoteAddress,
    });
    const body = await adminLoginHandler(event as never, { throttle, sleep });
    return { body, status: event.node.res.statusCode, headers };
  }

  it('slows down instead of answering 429 after 5 failures from one IP', async () => {
    const { throttle } = freshThrottle();
    const sleeper = makeSleeper();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      const res = await attempt(throttle, 'wrong', '203.0.113.7', sleeper.sleep);
      expect(res).toMatchObject({ body: { error: 'invalid password' }, status: 401 });
    }
    expect(sleeper.waits).toEqual([]);

    const slowed = await attempt(throttle, 'wrong', '203.0.113.7', sleeper.sleep);
    // Still a normal password failure, never a rejection.
    expect(slowed.status).toBe(401);
    expect(slowed.body).toEqual({ error: 'invalid password' });
    expect(slowed.headers['set-cookie']).toBeUndefined();
    expect(slowed.headers['cache-control']).toBe('no-store');
    expect(slowed.headers['retry-after']).toMatch(/^\d+$/);
    expect(sleeper.waits).toHaveLength(1);
    expect(sleeper.waits[0]).toBeGreaterThanOrEqual(LOGIN_SLOWDOWN_BASE_MS);
  });

  it('never locks out the correct password while the IP is over the limit', async () => {
    const { throttle } = freshThrottle();
    const sleeper = makeSleeper();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP + 3; i += 1) {
      await attempt(throttle, 'wrong', '203.0.113.7', sleeper.sleep);
    }
    const ok = await attempt(throttle, PASSWORD, '203.0.113.7', sleeper.sleep);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(ok.headers['set-cookie']).toContain(`${ADMIN_COOKIE}=`);
    // The successful attempt was slowed too, but it still went through.
    expect(sleeper.waits.length).toBeGreaterThan(0);
    expect(Math.max(...sleeper.waits)).toBeLessThanOrEqual(LOGIN_SLOWDOWN_MAX_MS);
  });

  it('keeps slowing down with a capped, growing delay', async () => {
    const { throttle } = freshThrottle();
    const delays: number[] = [];
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      delays.push(throttle.consume('203.0.113.7').delayMs);
    }
    expect(delays.every((ms) => ms === 0)).toBe(true);
    // Enough over-limit requests to reach the capped delay.
    for (let i = 0; i < 12; i += 1) {
      const decision = throttle.consume('203.0.113.7');
      expect(decision.allowed).toBe(true);
      expect(decision.throttled).toBe(true);
      expect(decision.delayMs).toBeGreaterThanOrEqual(LOGIN_SLOWDOWN_BASE_MS);
      expect(decision.delayMs).toBeLessThanOrEqual(LOGIN_SLOWDOWN_MAX_MS);
      delays.push(decision.delayMs);
    }
    const slowed = delays.filter((ms) => ms > 0);
    expect(slowed[0]).toBe(LOGIN_SLOWDOWN_BASE_MS);
    expect(slowed.at(-1)).toBe(LOGIN_SLOWDOWN_MAX_MS);
  });

  it('does not count successful logins and refunds their attempt', async () => {
    const { throttle } = freshThrottle();
    const sleeper = makeSleeper();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP - 1; i += 1) {
      await attempt(throttle, 'wrong', '203.0.113.7', sleeper.sleep);
    }
    const ok = await attempt(throttle, PASSWORD, '203.0.113.7', sleeper.sleep);
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']).toContain(`${ADMIN_COOKIE}=`);
    // One failure left without a slowdown, then the next one is slowed:
    // success did not consume the budget.
    expect((await attempt(throttle, 'wrong', '203.0.113.7', sleeper.sleep)).status).toBe(401);
    expect(sleeper.waits).toEqual([]);
    expect((await attempt(throttle, 'wrong', '203.0.113.7', sleeper.sleep)).status).toBe(401);
    expect(sleeper.waits).toHaveLength(1);
  });

  it('keeps IP buckets independent', async () => {
    const { throttle } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      await attempt(throttle, 'wrong', '198.51.100.1');
    }
    expect((await attempt(throttle, 'wrong', '198.51.100.1')).status).toBe(401);
    const sleeper = makeSleeper();
    expect((await attempt(throttle, 'wrong', '198.51.100.1', sleeper.sleep)).status).toBe(401);
    expect(sleeper.waits).toHaveLength(1);
    const other = makeSleeper();
    expect((await attempt(throttle, 'wrong', '198.51.100.2', other.sleep)).status).toBe(401);
    expect(other.waits).toEqual([]);
  });

  it('shares one bucket for requests without a client address', async () => {
    const { throttle } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      expect(throttle.consume('').allowed).toBe(true);
    }
    expect(throttle.consume('')).toMatchObject({ allowed: true, throttled: true });
    expect(throttle.consume(LOGIN_UNKNOWN_IP_KEY)).toMatchObject({
      allowed: true,
      throttled: true,
    });
  });

  it('enforces the global failure cap across many IPs', async () => {
    let clock = 0;
    const throttle = createLoginThrottle({ now: () => clock, maxGlobal: 3, maxPerIp: 2 });
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.consume(`ip-${i}`).allowed).toBe(true);
    }
    const blocked = throttle.consume('ip-3');
    // Never rejected: the request is only slowed down.
    expect(blocked.allowed).toBe(true);
    expect(blocked.throttled).toBe(true);
    expect(blocked.delayMs).toBe(LOGIN_SLOWDOWN_BASE_MS);
    expect(blocked.retryAfter).toBe(15 * 60);
    // The slowed IP still owns a bucket, but the map stays bounded.
    expect(throttle.size()).toBe(4 + 1);
    clock += 15 * 60 * 1000;
    expect(throttle.consume('ip-3').allowed).toBe(true);
  });

  it('opens a new window after 15 minutes', () => {
    const { throttle, advance } = freshThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      expect(throttle.consume('203.0.113.9').allowed).toBe(true);
    }
    expect(throttle.consume('203.0.113.9')).toMatchObject({ throttled: true });
    advance(15 * 60 * 1000 - 1);
    expect(throttle.consume('203.0.113.9')).toMatchObject({ throttled: true });
    advance(1);
    expect(throttle.consume('203.0.113.9')).toMatchObject({ throttled: false, delayMs: 0 });
  });

  it('bounds the map of tracked IPs', () => {
    const throttle = createLoginThrottle({ maxPerIp: 1, maxKeys: 4, maxGlobal: 1_000_000 });
    for (let i = 0; i < 1_000; i += 1) throttle.consume(`10.0.0.${i}`);
    // 4 IP buckets + the single global bucket.
    expect(throttle.size()).toBe(4 + 1);
    expect(LOGIN_GLOBAL_KEY).toBe('global');
  });
});

describe('login slowdown: serialized waiting', () => {
  /**
   * A throttle with the default limits, a fake clock, and a login handler whose
   * `sleep` is driven by that clock: every blocked request really waits until
   * the test advances time, so "pending" means genuinely pending.
   */
  function harness(options: { maxGlobal?: number; maxPerIp?: number } = {}) {
    let clock = 1_000_000;
    const throttle = createLoginThrottle({ now: () => clock, ...options });
    const timer = createFakeClock();
    return { throttle, timer, advance: (ms: number) => (clock += ms) };
  }

  /**
   * Start a login from `ip`. The fake events expose no socket peer, so the IP
   * is passed through the trusted forwarding header (the same path a proxied
   * deployment uses); the env var is restored in afterEach.
   */
  function start(
    throttle: ReturnType<typeof createLoginThrottle>,
    timer: ReturnType<typeof createFakeClock>,
    password: unknown,
    ip: string,
  ) {
    process.env[TRUSTED_IP_HEADER_ENV] = 'x-forwarded-for';
    const { event, headers } = makeEvent({
      method: 'POST',
      body: { password },
      forwardedFor: ip,
    });
    return adminLoginHandler(event as never, { throttle, sleep: timer.sleep }).then((body) => ({
      body,
      status: event.node.res.statusCode,
      headers,
    }));
  }

  /** Tag a promise so the test can tell "pending" from "settled". */
  function track<T>(promise: Promise<T>) {
    const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    promise.then(
      (value) => {
        state.settled = true;
        state.value = value;
      },
      (error) => {
        state.settled = true;
        state.error = error;
      },
    );
    return state;
  }

  it('keeps a throttled correct login pending until the delay really elapses', async () => {
    const { throttle, timer } = harness();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      expect((await start(throttle, timer, 'wrong', '203.0.113.7')).status).toBe(401);
    }
    // The failures were not slowed, so nothing is waiting yet.
    expect(timer.intervals).toHaveLength(0);

    const login = track(start(throttle, timer, PASSWORD, '203.0.113.7'));
    await flushMicrotasks();
    // Inside the delay window: no password check, no response yet.
    expect(login.settled).toBe(false);
    expect(timer.intervals).toEqual([
      { start: 0, duration: LOGIN_SLOWDOWN_BASE_MS, end: undefined },
    ]);

    // Still pending one tick before the delay ends.
    timer.tick(LOGIN_SLOWDOWN_BASE_MS - 1);
    await flushMicrotasks();
    expect(login.settled).toBe(false);

    timer.tick(1);
    await flushMicrotasks();
    expect(login.settled).toBe(true);
    const result = login.value!;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.headers['set-cookie']).toContain(`${ADMIN_COOKIE}=`);
    expect(result.headers['retry-after']).toMatch(/^\d+$/);
    // Never a 429, before or after the limit.
    expect(result.status).not.toBe(429);
  });

  it('serializes concurrent throttled requests from one IP (no overlap)', async () => {
    const { throttle, timer } = harness();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      await start(throttle, timer, 'wrong', '203.0.113.7');
    }

    // A burst of 4: one correct password hidden in the middle.
    const burst = [
      track(start(throttle, timer, 'wrong', '203.0.113.7')),
      track(start(throttle, timer, PASSWORD, '203.0.113.7')),
      track(start(throttle, timer, 'wrong', '203.0.113.7')),
      track(start(throttle, timer, 'wrong', '203.0.113.7')),
    ];
    await flushMicrotasks();

    // Only the first request is waiting; the others are queued behind it.
    expect(timer.intervals).toHaveLength(1);
    expect(burst.every((entry) => !entry.settled)).toBe(true);

    // Drain step by step: every fired delay releases exactly one request and
    // starts exactly one more, so the intervals never overlap.
    for (let step = 0; step < burst.length; step += 1) {
      expect(timer.intervals).toHaveLength(step + 1);
      expect(burst.filter((entry) => entry.settled)).toHaveLength(step);
      timer.tick(timer.intervals.at(-1)!.duration);
      await flushMicrotasks();
      expect(burst.filter((entry) => entry.settled)).toHaveLength(step + 1);
    }

    // Intervals are contiguous and non-overlapping: total wait = sum of delays.
    const intervals = timer.intervals;
    expect(intervals).toHaveLength(burst.length);
    let cursor = 0;
    for (const interval of intervals) {
      expect(interval.start).toBe(cursor);
      expect(interval.end).toBe(interval.start + interval.duration);
      cursor = interval.end!;
    }
    const totalWait = intervals.reduce((sum, interval) => sum + interval.duration, 0);
    expect(timer.now()).toBe(totalWait);
    // The backoff grows, so all four waits are at least the base delay: a
    // parallel implementation would have finished the whole burst in <= base.
    expect(totalWait).toBeGreaterThanOrEqual(LOGIN_SLOWDOWN_BASE_MS * burst.length);
    expect(Math.max(...intervals.map((interval) => interval.duration))).toBeLessThanOrEqual(
      LOGIN_SLOWDOWN_MAX_MS,
    );

    // Every request completed normally; the correct one logged in, none got 429.
    const statuses = burst.map((entry) => entry.value!.status);
    expect(statuses).toEqual([401, 200, 401, 401]);
    expect(burst[1].value!.headers['set-cookie']).toContain(`${ADMIN_COOKIE}=`);
  });

  it('does not block other IPs while one IP is over its limit', async () => {
    const { throttle, timer } = harness();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      await start(throttle, timer, 'wrong', '198.51.100.1');
    }
    const slow = track(start(throttle, timer, 'wrong', '198.51.100.1'));
    await flushMicrotasks();
    expect(timer.intervals).toHaveLength(1);

    // Another IP still has budget: answered without any delay.
    const other = track(start(throttle, timer, 'wrong', '198.51.100.2'));
    await flushMicrotasks();
    expect(other.settled).toBe(true);
    expect(other.value!.status).toBe(401);
    expect(slow.settled).toBe(false);
    expect(timer.intervals).toHaveLength(1);
  });

  it('serializes globally when the global bucket is exhausted', async () => {
    const { throttle, timer } = harness({ maxGlobal: 2, maxPerIp: 10 });
    for (const ip of ['192.0.2.1', '192.0.2.2']) {
      expect((await start(throttle, timer, 'wrong', ip)).status).toBe(401);
    }

    const burst = ['192.0.2.3', '192.0.2.4', '192.0.2.5'].map((ip) =>
      track(start(throttle, timer, PASSWORD, ip)),
    );
    await flushMicrotasks();
    // Different IPs, but the global bucket is full: only one delay runs.
    expect(timer.intervals).toHaveLength(1);
    expect(burst.every((entry) => !entry.settled)).toBe(true);

    for (let step = 0; step < burst.length; step += 1) {
      timer.tick(timer.intervals.at(-1)!.duration);
      await flushMicrotasks();
      expect(burst.filter((entry) => entry.settled)).toHaveLength(step + 1);
    }
    const intervals = timer.intervals;
    expect(intervals).toHaveLength(burst.length);
    for (let i = 1; i < intervals.length; i += 1) {
      expect(intervals[i].start).toBe(intervals[i - 1].end);
    }
    expect(burst.map((entry) => entry.value!.status)).toEqual([200, 200, 200]);
  });

  it('marks only attempts that were actually counted', () => {
    const throttle = createLoginThrottle({ now: () => 0, maxGlobal: 1, maxPerIp: 1 });
    expect(throttle.consume('10.0.0.1')).toMatchObject({ throttled: false, counted: true });
    // Same IP again: the IP bucket is full (global too) — still over a limit.
    expect(throttle.consume('10.0.0.1')).toMatchObject({ throttled: true, counted: false });
    // Global bucket full and a fresh IP: the IP bucket still had room, so that
    // slot is counted (a correct password would give it back); the global
    // limit is reported separately.
    expect(throttle.consume('10.0.0.2')).toMatchObject({
      throttled: true,
      global: true,
      counted: true,
    });
    // IP bucket full, global still has room: the global slot is counted (and is
    // what a successful login would give back).
    const ipOnly = createLoginThrottle({ now: () => 0, maxGlobal: 10, maxPerIp: 1 });
    expect(ipOnly.consume('10.0.1.1').counted).toBe(true);
    expect(ipOnly.consume('10.0.1.1')).toMatchObject({
      throttled: true,
      global: false,
      counted: true,
    });
  });

  it('keeps the queue map bounded and drains it', async () => {
    const queue = createKeyedQueue(2);
    const gates: Array<() => void> = [];
    const gate = () => new Promise<void>((resolve) => gates.push(resolve));
    const a = queue.enqueue('ip:a', gate);
    const b = queue.enqueue('ip:b', gate);
    await flushMicrotasks();
    expect(queue.size()).toBe(2);
    // Over the cap: still delayed (runs unchained), but the map does not grow.
    const c = queue.enqueue('ip:c', gate);
    expect(queue.size()).toBe(2);
    gates.splice(0).forEach((release) => release());
    await Promise.all([a, b, c]);
    await flushMicrotasks();
    expect(queue.size()).toBe(0);
  });
});
