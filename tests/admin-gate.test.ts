// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Secret entrance + page gate (`server/middleware/00-admin-gate.ts`).
 *
 * No Nitro server is started: the middleware is called with fake events that
 * mirror the node request/response pair (cookie header in, status/headers/body
 * recorder out), exactly like the other server-middleware tests. Route handlers
 * are invoked afterwards to prove that an allowed request really reaches them.
 *
 * Every credential, token and URL below is a fixture.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import adminLoginHandler from '../server/api/admin/login.post';
import adminMeHandler from '../server/api/admin/me.get';
import adminStatsHandler from '../server/api/admin/stats/index.get';
import adminGateMiddleware, {
  currentEntrance,
  gateRequestPath,
  handleAdminGate,
} from '../server/middleware/00-admin-gate';
import adminAuthMiddleware, { isPublicAdminApiPath } from '../server/middleware/01-admin-auth';
import {
  GATE_COOKIE,
  gateCookieHeader,
  hasValidGateCookie,
  isGateSigningUnavailable,
  issueGateToken,
  readGateCookieHeader,
  verifyGateToken,
} from '../server/utils/admin-gate';
import { GATE_TTL_MS, ADMIN_PATH_ENV } from '../core/utils/admin-entrance';
import { ADMIN_COOKIE, createSessionToken } from '../server/utils/admin-auth';
import { adminSessionRevocations } from '../server/utils/session-revocation';
import { createLoginThrottle } from '../server/utils/login-throttle';
import { TRUSTED_IP_HEADER_ENV } from '../server/utils/client-ip';
import { openDb, type SubhubDb } from '../server/db';
import { __setServerDbForTest } from '../server/utils/db';
import { users } from '../server/db/schema';

/** Fixture password (the same one the login tests use). */
const PASSWORD = 'correct-horse-battery';
const SECRET = 'test-signing-secret';

const ENV_KEYS = [ADMIN_PATH_ENV, 'SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV', TRUSTED_IP_HEADER_ENV] as const;
let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = PASSWORD;
  process.env.SUBHUB_SECRET = SECRET;
  delete process.env.NODE_ENV;
  delete process.env[ADMIN_PATH_ENV];
  delete process.env[TRUSTED_IP_HEADER_ENV];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeEvent {
  node: {
    req: { method: string; url: string; headers: Record<string, string> };
    res: {
      statusCode: number;
      setHeader(name: string, value: string | number): void;
      end(body?: string): void;
    };
  };
  path: string;
  /** Recorded by the fake response. */
  headers: Record<string, string>;
  /** Body written by `end()`, `undefined` when nothing was written. */
  body?: string;
  ended: boolean;
}

/** Fake Nitro event for `GET path`, optionally carrying cookies. */
function makeEvent(
  path: string,
  options: { cookies?: Record<string, string | null> } = {},
): FakeEvent {
  const headers: Record<string, string> = { host: 'localhost' };
  const jar = Object.entries(options.cookies ?? {}).filter(([, value]) => value !== null);
  if (jar.length > 0) {
    headers.cookie = jar.map(([name, value]) => `${name}=${value}`).join('; ');
  }

  const eventHeaders: Record<string, string> = {};
  const event = {
    node: {
      req: { method: 'GET', url: path, headers },
      res: {
        statusCode: 200,
        setHeader(name: string, value: string | number) {
          eventHeaders[name.toLowerCase()] = String(value);
        },
        end(body?: string) {
          event.ended = true;
          event.body = body ?? '';
        },
      },
    },
    path,
    headers: eventHeaders,
    body: undefined as string | undefined,
    ended: false,
  };
  return event as FakeEvent;
}

/** Extract the token from a recorded `Set-Cookie` value. */
function cookieToken(setCookie: string): string {
  const match = new RegExp(`^${GATE_COOKIE}=([^;]*);`).exec(setCookie);
  expect(match, `unexpected Set-Cookie: ${setCookie}`).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

/** The cookie jar a browser would hold after one knock at the entrance. */
function knock(): { token: string; cookie: string } {
  const event = makeEvent('/admin');
  adminGateMiddleware(event);
  expect(event.headers['set-cookie']).toBeTruthy();
  const cookie = event.headers['set-cookie']!;
  return { token: cookieToken(cookie), cookie };
}

describe('gate cookie', () => {
  it('is HttpOnly, SameSite=Lax, Path=/ and 30 days, and does not contain the path', () => {
    const token = issueGateToken({ now: () => 1_700_000_000_000 });
    expect(token).toBeTruthy();
    const header = gateCookieHeader(token!);
    expect(header).toContain(`${GATE_COOKIE}=`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain(`Max-Age=${Math.floor(GATE_TTL_MS / 1000)}`);
    expect(header).toContain('Max-Age=2592000');
    // Only the credential is in the value: neither the entrance nor the slash.
    expect(decodeURIComponent(header.split(';')[0]!.split('=').slice(1).join('='))).not.toContain(
      'admin',
    );
    expect(token).toMatch(/^v1\.\d+\.\d+\.[A-Za-z0-9_-]+$/);
  });

  it('adds Secure only in production', () => {
    const token = issueGateToken({ secret: SECRET, nodeEnv: 'development' })!;
    expect(gateCookieHeader(token, { nodeEnv: 'development' })).not.toContain('Secure');
    expect(gateCookieHeader(token, { nodeEnv: 'production' })).toContain('Secure');
  });

  it('verifies its own token and rejects tampering, expiry and the raw path', () => {
    const now = 1_700_000_000_000;
    const token = issueGateToken({ secret: SECRET, now: () => now })!;
    expect(verifyGateToken(token, { secret: SECRET, now: () => now })).toBe(true);
    // Still valid a day later, expired after 30 days.
    expect(verifyGateToken(token, { secret: SECRET, now: () => now + 86_400_000 })).toBe(true);
    expect(verifyGateToken(token, { secret: SECRET, now: () => now + GATE_TTL_MS + 1000 })).toBe(false);

    const [version, issued, expires, signature] = token.split('.');
    expect(verifyGateToken(`${version}.${issued}.${expires}.${signature}x`, { secret: SECRET })).toBe(false);
    expect(verifyGateToken(`v1.${issued}.${expires}.${signature}`, { secret: SECRET })).toBe(false);
    expect(verifyGateToken(`${version}.${issued}.${Number(expires) + 60}.${signature}`, { secret: SECRET })).toBe(
      false,
    );
    // A different secret (rotated) invalidates the cookie.
    expect(verifyGateToken(token, { secret: 'rotated-secret', now: () => now })).toBe(false);
    // The path itself can never be a valid cookie.
    for (const forged of ['admin', 'hx', '/admin', 'v1.admin.admin.deadbeef', '']) {
      expect(verifyGateToken(forged, { secret: SECRET })).toBe(false);
    }
  });

  it('fails closed in production without SUBHUB_SECRET (no fallback to the dev key)', () => {
    const opts = { secret: null, nodeEnv: 'production' } as const;
    expect(isGateSigningUnavailable(opts)).toBe(true);
    expect(issueGateToken(opts)).toBeNull();
    // A cookie minted with the public development key is rejected too.
    const devToken = issueGateToken({ secret: null, nodeEnv: 'development' })!;
    expect(verifyGateToken(devToken, opts)).toBe(false);
  });

  it('reads the cookie from the header only by exact name', () => {
    expect(readGateCookieHeader(`${GATE_COOKIE}=abc; ${ADMIN_COOKIE}=xyz`)).toBe('abc');
    expect(readGateCookieHeader(`x${GATE_COOKIE}=abc`)).toBeUndefined();
    expect(readGateCookieHeader(undefined)).toBeUndefined();
    expect(hasValidGateCookie({ cookie: `${GATE_COOKIE}=admin` }, { secret: SECRET })).toBe(false);
    expect(
      hasValidGateCookie({ cookie: `${GATE_COOKIE}=${issueGateToken({ secret: SECRET })}` }, { secret: SECRET }),
    ).toBe(true);
  });
});

describe('admin gate middleware', () => {
  it('blanks the homepage without a cookie: 200, empty HTML body', () => {
    const event = makeEvent('/');
    handleAdminGate(event);
    expect(event.ended).toBe(true);
    expect(event.node.res.statusCode).toBe(200);
    expect(event.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(event.body).toBe('');
    expect(event.headers['cache-control']).toBe('no-store');
    // No redirect, no error text, no JSON.
    expect(event.headers.location).toBeUndefined();
    expect(JSON.stringify(event.headers)).not.toContain('login');
  });

  it('blanks /login and other admin pages without a cookie', () => {
    for (const path of ['/login', '/users', '/sources', '/profiles', '/logs', '/preview']) {
      const event = makeEvent(path);
      handleAdminGate(event);
      expect(event.ended, path).toBe(true);
      expect(event.node.res.statusCode, path).toBe(200);
      expect(event.body, path).toBe('');
      expect(event.headers.location, path).toBeUndefined();
    }
  });

  it('blanks /api/admin/stats without a cookie (HTML 200, not JSON 401)', () => {
    const event = makeEvent('/api/admin/stats');
    handleAdminGate(event);
    expect(event.ended).toBe(true);
    expect(event.node.res.statusCode).toBe(200);
    expect(event.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(event.body).toBe('');
  });

  it('blanks an admin page even with a raw, forged cookie', () => {
    const event = makeEvent('/users', { cookies: { [GATE_COOKIE]: 'admin' } });
    handleAdminGate(event);
    expect(event.ended).toBe(true);
    expect(event.node.res.statusCode).toBe(200);
    expect(event.body).toBe('');
  });

  it('issues the cookie and redirects to /login on the entrance', () => {
    const event = makeEvent('/admin');
    handleAdminGate(event);
    expect(event.ended).toBe(true);
    expect(event.node.res.statusCode).toBe(302);
    expect(event.headers.location).toBe('/login');
    const setCookie = event.headers['set-cookie']!;
    expect(setCookie).toContain(`${GATE_COOKIE}=`);
    // The value is a signed token derived from SUBHUB_SECRET, not the path.
    const token = cookieToken(setCookie);
    expect(token).not.toBe('admin');
    expect(verifyGateToken(token, { secret: SECRET })).toBe(true);
  });

  it('keeps the entrance blank in production without SUBHUB_SECRET', () => {
    delete process.env.SUBHUB_SECRET;
    process.env.NODE_ENV = 'production';
    const spied = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = makeEvent('/admin');
    handleAdminGate(event);
    expect(event.node.res.statusCode).toBe(200);
    expect(event.body).toBe('');
    expect(event.headers['set-cookie']).toBeUndefined();
    expect(spied).toHaveBeenCalled();
    spied.mockRestore();
  });

  it('lets the real /login page through once the cookie is held', () => {
    const { token } = knock();
    const event = makeEvent('/login', { cookies: { [GATE_COOKIE]: token } });
    expect(handleAdminGate(event)).toBe(false);
    // Untouched: no status, no headers, no body written by the gate.
    expect(event.ended).toBe(false);
    expect(event.node.res.statusCode).toBe(200);
    expect(Object.keys(event.headers)).toHaveLength(0);
  });

  it('reaches /api/admin/login with the gate cookie (and still needs the password)', async () => {
    const { token } = knock();
    const event = makeEvent('/api/admin/login', { cookies: { [GATE_COOKIE]: token } });
    // Gate and admin-auth middleware both pass it.
    expect(handleAdminGate(event)).toBe(false);
    expect(isPublicAdminApiPath(event.path)).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'subhub-gate-'));
    dirs.push(dir);
    const db: SubhubDb = openDb({ path: join(dir, 'subhub.sqlite') });
    expect(db).toBeTruthy();

    const req = event.node.req as typeof event.node.req & { body?: unknown };
    req.body = { password: PASSWORD };
    const result = await adminLoginHandler(event as never, {
      throttle: createLoginThrottle(),
      sleep: async () => {},
    });
    expect(result).toEqual({ ok: true });
    expect(event.headers['set-cookie']).toContain(`${ADMIN_COOKIE}=`);
  });

  it('lets /api/admin/me through the gate and then answers with the session state', () => {
    const { token } = knock();
    const event = makeEvent('/api/admin/me', { cookies: { [GATE_COOKIE]: token } });
    expect(handleAdminGate(event)).toBe(false);
    expect(adminMeHandler(event as never)).toEqual({ authenticated: false });
  });

  it('serves /api/admin/stats to a fully logged-in browser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-gate-'));
    dirs.push(dir);
    const db = openDb({ path: join(dir, 'subhub.sqlite') });
    db.insert(users).values({ name: 'fixture-user', token: 'a'.repeat(32), enabled: true }).run();
    __setServerDbForTest(db);
    try {
      const { token } = knock();
      const session = createSessionToken({ secret: SECRET });
      const event = makeEvent('/api/admin/stats', {
        cookies: { [GATE_COOKIE]: token, [ADMIN_COOKIE]: session },
      });
      expect(handleAdminGate(event)).toBe(false);
      // The existing session middleware is happy, and the handler runs.
      expect(adminAuthMiddleware(event as never)).toBeUndefined();
      expect(event.ended).toBe(false);
      const stats = (await adminStatsHandler(event as never, {
        db,
        revocations: adminSessionRevocations,
      })) as { users: number };
      expect(stats.users).toBe(1);
      expect(event.node.res.statusCode).toBe(200);
    } finally {
      __setServerDbForTest(null);
    }
  });

  it('never gates a subscription export, even without any cookie', () => {
    // Public by design: the gate does not even look at the cookie.
    for (const path of ['/s/a1b2c3d4e5f60718293a4b5c6d7e8f90', '/s/a1b2c3d4e5f60718293a4b5c6d7e8f90/clash']) {
      const event = makeEvent(path);
      expect(handleAdminGate(event)).toBe(false);
      expect(event.ended).toBe(false);
      expect(Object.keys(event.headers)).toHaveLength(0);
    }
  });

  it('serves no assets without the cookie but does with it', () => {
    const blocked = makeEvent('/_nuxt/entry.js');
    handleAdminGate(blocked);
    expect(blocked.ended).toBe(true);
    expect(blocked.node.res.statusCode).toBe(404);
    expect(blocked.body).toBe('');

    const { token } = knock();
    const allowed = makeEvent('/_nuxt/entry.js', { cookies: { [GATE_COOKIE]: token } });
    expect(handleAdminGate(allowed)).toBe(false);
    expect(allowed.ended).toBe(false);
  });

  it('never gates the login/logout endpoints (no cookie yet after a knock)', () => {
    for (const path of ['/api/admin/login', '/api/admin/logout']) {
      const event = makeEvent(path);
      expect(handleAdminGate(event), path).toBe(false);
      expect(event.ended, path).toBe(false);
    }
    // The rest of the admin API is still blanked.
    const stats = makeEvent('/api/admin/stats');
    handleAdminGate(stats);
    expect(stats.body).toBe('');
  });

  it('never gates other public API routes', () => {
    const event = makeEvent('/api/tasks/refresh-sources');
    expect(handleAdminGate(event)).toBe(false);
    expect(event.ended).toBe(false);
  });

  it('re-issues the cookie when the entrance is visited again', () => {
    const { token } = knock();
    const event = makeEvent('/admin', { cookies: { [GATE_COOKIE]: token } });
    handleAdminGate(event);
    expect(event.node.res.statusCode).toBe(302);
    expect(event.headers['set-cookie']).toContain(`${GATE_COOKIE}=`);
  });

  it('honours SUBHUB_ADMIN_PATH: the custom entrance knocks, /admin blanks', () => {
    process.env[ADMIN_PATH_ENV] = '/hx/panel/';
    expect(currentEntrance()).toBe('/hx/panel');

    const knockEvent = makeEvent('/hx/panel');
    handleAdminGate(knockEvent);
    expect(knockEvent.node.res.statusCode).toBe(302);
    expect(knockEvent.headers.location).toBe('/login');

    const oldDefault = makeEvent('/admin');
    handleAdminGate(oldDefault);
    expect(oldDefault.node.res.statusCode).toBe(200);
    expect(oldDefault.body).toBe('');
    expect(oldDefault.headers.location).toBeUndefined();
  });

  it('honours SUBHUB_ADMIN_PATH in the cookie check too', () => {
    process.env[ADMIN_PATH_ENV] = 'hx';
    const entrance = makeEvent('/hx');
    handleAdminGate(entrance);
    const token = cookieToken(entrance.headers['set-cookie']!);

    const allowed = makeEvent('/users', { cookies: { [GATE_COOKIE]: token } });
    expect(handleAdminGate(allowed)).toBe(false);
    const blocked = makeEvent('/users');
    handleAdminGate(blocked);
    expect(blocked.body).toBe('');
  });

  it('falls back to /admin and warns when SUBHUB_ADMIN_PATH is invalid', () => {
    process.env[ADMIN_PATH_ENV] = 'api';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(currentEntrance()).toBe('/admin');
    const event = makeEvent('/admin');
    handleAdminGate(event);
    expect(event.node.res.statusCode).toBe(302);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reads the path from the event or the raw URL', () => {
    const event = makeEvent('/login');
    expect(gateRequestPath(event)).toBe('/login');
    const bare = makeEvent('/');
    delete (bare as { path?: string }).path;
    expect(gateRequestPath(bare)).toBe('/');
  });
});
