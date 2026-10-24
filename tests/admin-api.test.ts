// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin API gate + CRUD for users and sources (P3).
 *
 * No Nuxt/Nitro server runs: routes are called with fake events
 * (tests/helpers/admin-api.ts) and an in-memory SQLite database. Every user,
 * token and URL below is a fixture (`example.com`, fake hex tokens).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import adminLoginHandler from '../server/api/admin/login.post';
import adminLogoutHandler from '../server/api/admin/logout.post';
import adminMeHandler from '../server/api/admin/me.get';
import usersListHandler from '../server/api/admin/users/index.get';
import usersCreateHandler from '../server/api/admin/users/index.post';
import userGetHandler from '../server/api/admin/users/[id].get';
import userUpdateHandler from '../server/api/admin/users/[id].patch';
import userDeleteHandler from '../server/api/admin/users/[id].delete';
import userResetTokenHandler from '../server/api/admin/users/[id]/reset-token.post';
import sourcesListHandler from '../server/api/admin/sources/index.get';
import sourcesCreateHandler from '../server/api/admin/sources/index.post';
import sourceGetHandler from '../server/api/admin/sources/[id].get';
import sourceUpdateHandler from '../server/api/admin/sources/[id].patch';
import sourceDeleteHandler from '../server/api/admin/sources/[id].delete';
import adminApiMiddleware, {
  adminApiAuth,
  isPublicAdminApiPath,
} from '../server/middleware/admin-auth';
import {
  ADMIN_COOKIE,
  createSessionToken,
  issueSessionToken,
  login,
  verifySessionToken,
} from '../server/utils/admin-auth';
import {
  adminSessionRevocations,
  createSessionRevocationStore,
  MAX_REVOKED_SESSIONS,
  type SessionRevocationStore,
} from '../server/utils/session-revocation';
import {
  generateUserToken,
  maskUrl,
  parseSourceUrl,
  TOKEN_BYTES,
} from '../server/utils/admin-validation';
import { openDb, type SubhubDb } from '../server/db';
import { resetCryptoCache } from '../server/db/crypto';
import { sources, users } from '../server/db/schema';
import type { AdminApiEvent } from '../server/utils/admin-api';
import { authenticatedEvent, makeApiEvent } from './helpers/admin-api';

const PASSWORD = 'correct-horse-battery';
const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;

type AdminApiHandler = (
  event: AdminApiEvent,
  options?: { db?: SubhubDb; revocations?: SessionRevocationStore },
) => unknown;

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let db: SubhubDb;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = PASSWORD;
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;
  adminSessionRevocations.reset();

  const dir = mkdtempSync(join(tmpdir(), 'subhub-admin-api-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });

  base = { db, options: { db, revocations: createSessionRevocationStore() } };
});

afterEach(() => {
  adminSessionRevocations.reset();
  resetCryptoCache();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Call a handler with the shared test DB and return the recorded response. */
/**
 * Route options. `db` and `revocations` are injected so the fake session
 * cookies are checked against a store this test controls.
 */
let base: {
  db: SubhubDb;
  options: { db: SubhubDb; revocations: ReturnType<typeof createSessionRevocationStore> };
};

function authed(options: { url: string; method?: string; body?: unknown }) {
  return authenticatedEvent(options, base.options.revocations);
}

function authedAndAnon(url: string, method = 'GET', body?: unknown) {
  return {
    authed: authed({ url, method, body }),
    anon: makeApiEvent({ url, method, body }),
  };
}

/** Create a fixture user through the API (admin) and return it. */
async function createFixtureUser(name = 'fixture-user') {
  const { event, headers } = authed({
    url: '/api/admin/users',
    method: 'POST',
    body: { name },
  });
  const res = await usersCreateHandler(event, base.options);
  expect(event.node.res.statusCode).toBe(201);
  expect(headers['cache-control']).toBe('no-store');
  return (res as { item: Record<string, unknown> }).item;
}

async function createFixtureSource(overrides: Record<string, unknown> = {}) {
  const { event } = authed({
    url: '/api/admin/sources',
    method: 'POST',
    body: {
      name: 'fixture-source',
      url: 'https://example.com/subscribe?id=fixture-token',
      ...overrides,
    },
  });
  const res = await sourcesCreateHandler(event, base.options);
  expect(event.node.res.statusCode).toBe(201);
  return (res as { item: Record<string, unknown> }).item;
}

describe('admin API middleware', () => {
  function run(url: string, cookie?: string) {
    const { event } = makeApiEvent({ url, sessionToken: cookie });
    const req = event.node.req as unknown as {
      headers: Record<string, string | string[] | undefined>;
      url?: string;
    };
    req.url = url;
    let nexted = false;
    let ended: string | undefined;
    interface TestResponse {
      statusCode: number;
      headers: Record<string, string>;
      setHeader(name: string, value: string): void;
      end(body?: string): void;
    }
    const res: TestResponse = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      end(body?: string) {
        ended = body;
      },
    };
    (adminApiMiddleware as unknown as (
      req: { headers: Record<string, string | string[] | undefined>; url?: string },
      res: TestResponse,
      next: () => void,
    ) => void)(req, res, () => {
      nexted = true;
    });
    return { nexted, ended, status: res.statusCode, res };
  }

  it('lets login and logout through without a session', () => {
    expect(isPublicAdminApiPath('/api/admin/login')).toBe(true);
    expect(isPublicAdminApiPath('/api/admin/login/?x=1')).toBe(true);
    expect(isPublicAdminApiPath('/api/admin/users')).toBe(false);
    expect(run('/api/admin/login').nexted).toBe(true);
    expect(run('/api/admin/logout').nexted).toBe(true);
  });

  it('answers 401 JSON for every other /api/admin route without a session', () => {
    for (const url of [
      '/api/admin/me',
      '/api/admin/users',
      '/api/admin/users/1',
      '/api/admin/users/1/reset-token',
      '/api/admin/sources',
      '/api/admin/sources/9',
    ]) {
      const result = run(url);
      expect(result.nexted).toBe(false);
      expect(result.status).toBe(401);
      expect(JSON.parse(result.ended!)).toEqual({ error: 'unauthorized' });
      expect(result.res.headers['cache-control']).toBe('no-store');
    }
    const bogus = run('/api/admin/users', 'not-a-token');
    expect(bogus.status).toBe(401);
    expect(bogus.nexted).toBe(false);
  });

  it('passes valid sessions and non-admin paths through', () => {
    const token = createSessionToken();
    expect(run('/api/admin/users', token).nexted).toBe(true);
    expect(run('/s/abc').nexted).toBe(true);
  });

  it('rejects a revoked session', () => {
    // Default store (what the middleware uses) + explicit revoke.
    const revocations = adminSessionRevocations;
    const { token, payload } = issueSessionToken({ revocations });
    revocations.revoke(payload.sessionId, payload.expiresAtMs);
    const { event } = makeApiEvent({ url: '/api/admin/users', sessionToken: token });
    const res = { statusCode: 200, setHeader: () => {}, end: () => {} };
    expect(adminApiAuth(event.node.req as never, res as never)).toBe(false);
  });
});

describe('logout revokes the session server-side', () => {
  it('rejects the old cookie after logout even though it is still signed', () => {
    const { event: loginEvent, headers } = makeApiEvent({
      method: 'POST',
      body: { password: PASSWORD },
    });
    return adminLoginHandler(loginEvent as never).then(async () => {
      const cookie = headers['set-cookie'];
      const token = decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!);
      expect(verifySessionToken(token)).toBe(true);

      const authed = makeApiEvent({ url: '/api/admin/me', sessionToken: token });
      expect(adminMeHandler(authed.event as never)).toEqual({ authenticated: true });

      const { event: logoutEvent, headers: logoutHeaders } = makeApiEvent({
        method: 'POST',
        url: '/api/admin/logout',
        sessionToken: token,
      });
      expect(adminLogoutHandler(logoutEvent as never)).toEqual({ ok: true });
      expect(logoutHeaders['set-cookie']).toContain(`${ADMIN_COOKIE}=;`);

      // Same cookie, now dead: 401 from the gate and from the route helpers.
      const replay = makeApiEvent({ url: '/api/admin/me', sessionToken: token });
      expect(adminMeHandler(replay.event as never)).toEqual({ authenticated: false });
      // Same revocation store as the login handler used in production.
      const usersReplay = makeApiEvent({ url: '/api/admin/users', sessionToken: token });
      const res = await usersListHandler(usersReplay.event, {
        db: base.db,
        revocations: adminSessionRevocations,
      });
      expect(usersReplay.event.node.res.statusCode).toBe(401);
      expect(res).toEqual({ error: 'unauthorized' });
    });
  });

  it('only revokes the session that logged out', () => {
    const first = login(PASSWORD)!;
    const second = login(PASSWORD)!;
    expect(first.sessionId).not.toBe(second.sessionId);

    const { event } = makeApiEvent({
      method: 'POST',
      url: '/api/admin/logout',
      sessionToken: first.token,
    });
    adminLogoutHandler(event as never);

    expect(verifySessionToken(first.token)).toBe(false);
    expect(verifySessionToken(second.token)).toBe(true);
  });

  it('is idempotent and safe without a cookie', () => {
    const { event } = makeApiEvent({ method: 'POST', url: '/api/admin/logout' });
    expect(adminLogoutHandler(event as never)).toEqual({ ok: true });
    expect(event.node.res.statusCode).toBe(200);
    const bogus = makeApiEvent({
      method: 'POST',
      url: '/api/admin/logout',
      sessionToken: 'garbage',
    });
    expect(adminLogoutHandler(bogus.event as never)).toEqual({ ok: true });
  });

  it('bounds and expires the revocation table', () => {
    let clock = 1_000;
    const store = createSessionRevocationStore({ maxEntries: 3, now: () => clock });
    for (let i = 0; i < 10; i += 1) store.revoke(`session-${i}`, clock + 60_000);
    expect(store.size()).toBe(3);
    // Oldest ids were evicted; the newest remain revoked.
    expect(store.isRevoked('session-9')).toBe(true);
    expect(store.isRevoked('session-0')).toBe(false);

    clock += 61_000;
    expect(store.isRevoked('session-9')).toBe(false);
    // Expired entries are dropped lazily, as they are looked up.
    expect(store.size()).toBe(2);
    expect(MAX_REVOKED_SESSIONS).toBe(4096);
  });
});

describe('user token generation', () => {
  it('produces 64 hex characters from 32 random bytes', () => {
    const token = generateUserToken();
    expect(TOKEN_BYTES).toBe(32);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(generateUserToken()).not.toBe(token);
  });
});

describe('/api/admin/users CRUD', () => {
  it('401 for list/create/read/update/delete/reset without a session', async () => {
    const cases: Array<[string, string, AdminApiHandler]> = [
      ['GET', '/api/admin/users', usersListHandler],
      ['POST', '/api/admin/users', usersCreateHandler],
      ['GET', '/api/admin/users/1', userGetHandler],
      ['PATCH', '/api/admin/users/1', userUpdateHandler],
      ['DELETE', '/api/admin/users/1', userDeleteHandler],
      ['POST', '/api/admin/users/1/reset-token', userResetTokenHandler],
    ];
    for (const [method, url, handler] of cases) {
      const { anon } = authedAndAnon(url, method, { name: 'x' });
      const res = await handler(anon.event, base.options);
      expect(anon.event.node.res.statusCode).toBe(401);
      expect(res).toEqual({ error: 'unauthorized' });
    }
    expect(db.select().from(users).all()).toHaveLength(0);
  });

  it('creates, lists, updates and deletes a user', async () => {
    const created = await createFixtureUser('fixture-alice');
    expect(created.name).toBe('fixture-alice');
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.enabled).toBe(true);

    const list = authedAndAnon('/api/admin/users');
    const listed = (await usersListHandler(list.authed.event, base.options)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.id).toBe(created.id);

    const updated = authed({
      url: `/api/admin/users/${created.id}`,
      method: 'PATCH',
      body: { name: 'fixture-bob', enabled: false, note: 'fixture note' },
    });
    const updateRes = (await userUpdateHandler(updated.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(updateRes.item).toMatchObject({
      name: 'fixture-bob',
      enabled: false,
      note: 'fixture note',
      token: created.token,
    });

    const read = authed({ url: `/api/admin/users/${created.id}` });
    const readRes = (await userGetHandler(read.event, base.options)) as { item: Record<string, unknown> };
    expect(readRes.item.name).toBe('fixture-bob');

    const removed = authed({
      url: `/api/admin/users/${created.id}`,
      method: 'DELETE',
    });
    expect(await userDeleteHandler(removed.event, base.options)).toEqual({ ok: true, id: created.id });
    expect(db.select().from(users).all()).toHaveLength(0);

    const missing = authed({ url: `/api/admin/users/${created.id}` });
    expect(await userGetHandler(missing.event, base.options)).toEqual({ error: 'user not found' });
    expect(missing.event.node.res.statusCode).toBe(404);
  });

  it('rotates the token without touching the rest of the user', async () => {
    const created = await createFixtureUser('fixture-rotate');
    const reset = authed({
      url: `/api/admin/users/${created.id}/reset-token`,
      method: 'POST',
    });
    const res = (await userResetTokenHandler(reset.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(res.item.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.item.token).not.toBe(created.token);
    expect(res.item.name).toBe('fixture-rotate');
    expect(db.select().from(users).where(eq(users.id, created.id as number)).get()?.token).toBe(
      res.item.token,
    );
  });

  it('never accepts a client-supplied token and validates input', async () => {
    const withToken = authed({
      url: '/api/admin/users',
      method: 'POST',
      body: { name: 'fixture', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const res = (await usersCreateHandler(withToken.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(res.item.token).not.toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    for (const [body, error] of [
      [{}, 'name is required'],
      [{ name: '   ' }, 'name is required'],
      [{ name: 'x'.repeat(101) }, 'name must be at most 100 characters'],
      [{ name: 'ok', enabled: 'maybe' }, 'enabled must be a boolean'],
      [{ name: 'ok', note: 'n'.repeat(501) }, 'note must be at most 500 characters'],
    ] as const) {
      const { event } = authed({ url: '/api/admin/users', method: 'POST', body });
      expect(await usersCreateHandler(event, base.options)).toEqual({ error });
      expect(event.node.res.statusCode).toBe(400);
    }

    const noBody = authed({ url: '/api/admin/users', method: 'POST' });
    expect(await usersCreateHandler(noBody.event, base.options)).toEqual({ error: 'invalid JSON body' });
    expect(noBody.event.node.res.statusCode).toBe(400);
  });
});

describe('/api/admin/sources CRUD', () => {
  it('401 for every source route without a session', async () => {
    const cases: Array<[string, string, AdminApiHandler]> = [
      ['GET', '/api/admin/sources', sourcesListHandler],
      ['POST', '/api/admin/sources', sourcesCreateHandler],
      ['GET', '/api/admin/sources/1', sourceGetHandler],
      ['PATCH', '/api/admin/sources/1', sourceUpdateHandler],
      ['DELETE', '/api/admin/sources/1', sourceDeleteHandler],
    ];
    for (const [method, url, handler] of cases) {
      const { anon } = authedAndAnon(url, method, {
        name: 'x',
        url: 'https://example.com/a',
      });
      const res = await handler(anon.event, base.options);
      expect(anon.event.node.res.statusCode).toBe(401);
      expect(res).toEqual({ error: 'unauthorized' });
    }
    expect(db.select().from(sources).all()).toHaveLength(0);
  });

  it('encrypts the URL at rest and only ever returns the masked form', async () => {
    const plainUrl = 'https://example.com/subscribe?id=secret-fixture-token';
    const created = await createFixtureSource({ url: plainUrl });

    expect(created.urlMasked).toBe('https://example.com/subscribe?***');
    expect(created).not.toHaveProperty('url');
    const serialized = JSON.stringify(created);
    expect(serialized).not.toContain('secret-fixture-token');
    expect(serialized).not.toContain('id=');

    const stored = db.select().from(sources).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.url.startsWith('v1:')).toBe(true);
    expect(stored[0]!.url).not.toContain(plainUrl);

    const list = authed({ url: '/api/admin/sources' });
    const listed = (await sourcesListHandler(list.event, base.options)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(listed)).not.toContain('secret-fixture-token');
    expect(listed.items[0]!.urlMasked).toBe('https://example.com/subscribe?***');

    const read = authed({ url: `/api/admin/sources/${created.id}` });
    const readRes = (await sourceGetHandler(read.event, base.options)) as { item: unknown };
    expect(JSON.stringify(readRes)).not.toContain('secret-fixture-token');
  });

  it('updates, keeps the URL when omitted and deletes', async () => {
    const created = await createFixtureSource();
    const ciphertextBefore = db.select().from(sources).all()[0]!.url;

    const renamed = authed({
      url: `/api/admin/sources/${created.id}`,
      method: 'PATCH',
      body: { name: 'fixture-renamed', refreshMinutes: 120 },
    });
    const renameRes = (await sourceUpdateHandler(renamed.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(renameRes.item).toMatchObject({ name: 'fixture-renamed', refreshMinutes: 120 });
    // The ciphertext is untouched when no new URL is supplied.
    expect(db.select().from(sources).all()[0]!.url).toBe(ciphertextBefore);

    const reUrl = authed({
      url: `/api/admin/sources/${created.id}`,
      method: 'PATCH',
      body: { url: 'http://example.org/other?x=1', type: 'local' },
    });
    const reUrlRes = (await sourceUpdateHandler(reUrl.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(reUrlRes.item.urlMasked).toBe('http://example.org/other?***');
    expect(reUrlRes.item.type).toBe('local');
    expect(JSON.stringify(reUrlRes)).not.toContain('x=1');

    const removed = authed({
      url: `/api/admin/sources/${created.id}`,
      method: 'DELETE',
    });
    expect(await sourceDeleteHandler(removed.event, base.options)).toEqual({
      ok: true,
      id: created.id,
    });
    expect(db.select().from(sources).all()).toHaveLength(0);
  });

  it('validates name, URL protocol/host/credentials, type and refreshMinutes', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ name: 'x' }, 'url is required'],
      [{ name: '', url: 'https://example.com/a' }, 'name is required'],
      [{ name: 'x', url: 'ftp://example.com/a' }, 'url must use http or https'],
      [{ name: 'x', url: 'file:///etc/passwd' }, 'url must use http or https'],
      [{ name: 'x', url: 'javascript:alert(1)' }, 'url must use http or https'],
      [{ name: 'x', url: 'example.com/a' }, 'url is not a valid URL'],
      [{ name: 'x', url: 'https://user:pass@example.com/a' }, 'url must not contain credentials'],
      [{ name: 'x', url: `https://example.com/${'a'.repeat(2100)}` }, 'url must be at most 2048 characters'],
      [{ name: 'x', url: 'https://example.com/a', type: 'weird' }, 'type must be one of: remote, local'],
      [{ name: 'x', url: 'https://example.com/a', refreshMinutes: 0 }, 'refreshMinutes must be between 5 and 10080'],
      [{ name: 'x', url: 'https://example.com/a', refreshMinutes: 1.5 }, 'refreshMinutes must be an integer'],
      [{ name: 'x', url: 'https://example.com/a', ua: 'u'.repeat(257) }, 'ua must be at most 256 characters'],
    ];
    for (const [body, error] of cases) {
      const { event } = authed({
        url: '/api/admin/sources',
        method: 'POST',
        body,
      });
      expect(await sourcesCreateHandler(event, base.options)).toEqual({ error });
      expect(event.node.res.statusCode).toBe(400);
    }
    expect(db.select().from(sources).all()).toHaveLength(0);
  });

  it('accepts http and https URLs and normalises them', () => {
    expect(parseSourceUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(parseSourceUrl(' http://example.com/a/b?c=d ')).toBe('http://example.com/a/b?c=d');
    expect(() => parseSourceUrl('//example.com/a')).toThrow(/not a valid URL/);
  });

  it('maskUrl drops the query string and credentials-free hosts remain visible', () => {
    expect(maskUrl('https://example.com/sub?token=abc')).toBe('https://example.com/sub?***');
    expect(maskUrl('https://example.com')).toBe('https://example.com?***');
    expect(maskUrl('https://example.com?a=1')).toBe('https://example.com?***');
    expect(maskUrl('not a url')).toBe('(invalid)');
  });

  it('404 for unknown ids', async () => {
    for (const [url, method, handler] of [
      ['/api/admin/sources/999', 'GET', sourceGetHandler],
      ['/api/admin/sources/999', 'PATCH', sourceUpdateHandler],
      ['/api/admin/sources/999', 'DELETE', sourceDeleteHandler],
    ] as const) {
      const { event } = authed({ url, method, body: { name: 'x' } });
      expect(await handler(event, base.options)).toEqual({ error: 'source not found' });
      expect(event.node.res.statusCode).toBe(404);
    }
  });
});
