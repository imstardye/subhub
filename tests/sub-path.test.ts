// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Site settings: the subscription URL prefix (`sub_path`) as an in-app setting.
 *
 * The owner rejected an env var here: the prefix is edited in the admin UI and
 * must take effect without a restart. Covered end to end without a Nuxt
 * runtime:
 * - `validateSubPath` rules + the settings API (GET/PUT, 400 keeps the old value);
 * - the middleware decision (`decideSubscriptionRewrite`): default `s` untouched,
 *   `/dl/...` rewritten onto the `/s/` routes, `/s/...` 404 while a custom prefix
 *   is active, multi-segment and whole-segment matching;
 * - the Nitro middleware handler itself (rewrite in place / 404);
 * - the export reached through the rewritten path (same body, profile-suffix
 *   and token rotation interplay) and the UI link helper.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import settingsGetHandler from '../server/api/admin/settings/index.get';
import settingsPutHandler from '../server/api/admin/settings/index.put';
import statsHandler from '../server/api/admin/stats/index.get';
import subPathMiddleware, {
  decideSubscriptionRewrite,
  subscriptionRequestPath,
  type SubscriptionRewriteEvent,
} from '../server/middleware/sub-path';
import { openDb, type SubhubDb } from '../server/db';
import { __setServerDbForTest } from '../server/utils/db';
import { profiles, sources, settings, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import {
  DEFAULT_SUB_PATH,
  getSubPath,
  invalidateSubPathCache,
  normalizeSubPath,
  readSetting,
  setSubPath,
  validateSubPath,
} from '../server/utils/settings';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { requestFromEvent } from '../server/utils/export-handler';
import {
  normalizeSubPathForUrl,
  subscriptionPathLabel,
  subscriptionUrl,
  subscriptionUrlWithPrefix,
  validateSubPathInput,
} from '../core/utils/admin-ui';
import { createSessionRevocationStore, type SessionRevocationStore } from '../server/utils/session-revocation';
import { authenticatedEvent, makeApiEvent } from './helpers/admin-api';

const ENV_KEYS = [
  'SUBHUB_ADMIN_PASSWORD',
  'SUBHUB_SECRET',
  'NODE_ENV',
  'SUBHUB_ADMIN_PATH',
] as const;
const TOKEN = 'c0ffee'.repeat(10) + 'abcd';

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let db: SubhubDb;
let userId: number;
let options: { db: SubhubDb; revocations: SessionRevocationStore };

beforeEach(() => {
  resetExportRateLimiter();
  invalidateSubPathCache();
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;
  delete process.env.SUBHUB_ADMIN_PATH;

  const dir = mkdtempSync(join(tmpdir(), 'subhub-subpath-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
  options = { db, revocations: createSessionRevocationStore() };

  userId = db
    .insert(users)
    .values({ name: 'fixture-user', token: TOKEN, enabled: true })
    .returning({ id: users.id })
    .get()!.id;

  db.insert(sources)
    .values({
      name: 'fixture-source',
      url: encrypt('placeholder-source-not-a-real-subscription'),
      type: 'local',
      ownerUserId: userId,
      cacheBlob: 'proxies:\n  - {name: "🇭🇰 香港 01", type: ss, server: a.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}\n',
    })
    .run();
});

afterEach(() => {
  resetExportRateLimiter();
  invalidateSubPathCache();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function callSettings(method: 'GET' | 'PUT', body?: unknown) {
  const { event } = authenticatedEvent(
    { url: '/api/admin/settings', method, body },
    options.revocations,
  );
  const result =
    method === 'GET'
      ? await settingsGetHandler(event, options)
      : await settingsPutHandler(event, options);
  return { status: event.node.res.statusCode, body: result as Record<string, unknown> };
}

async function exportAt(token: string, target: string) {
  return handleSubscriptionExport({ token, target, userAgent: 'clash-verge/v2.0' }, { db });
}

describe('validateSubPath', () => {
  it('defaults to `s` and accepts normalised single/multi-segment values', () => {
    expect(DEFAULT_SUB_PATH).toBe('s');
    expect(getSubPath(db)).toBe('s');

    expect(validateSubPath('dl')).toEqual({ ok: true, value: 'dl' });
    expect(validateSubPath('  /dl/  ')).toEqual({ ok: true, value: 'dl' });
    expect(validateSubPath('//x///y//')).toEqual({ ok: true, value: 'x/y' });
    expect(validateSubPath('DL')).toEqual({ ok: true, value: 'dl' });
    expect(validateSubPath('a_b-c9')).toEqual({ ok: true, value: 'a_b-c9' });
    expect(normalizeSubPath('/Sub/Path/')).toBe('sub/path');
  });

  it('rejects empty, malformed, over-long and reserved values', () => {
    for (const bad of [
      '',
      '   ',
      '/',
      '-dl',
      '_dl',
      'd l',
      'dl.sub',
      'dl/x.y',
      'a'.repeat(65),
      'a/b/c/d/e',
    ]) {
      expect(validateSubPath(bad).ok, bad).toBe(false);
    }
    // Reserved route roots (also as the first segment of a multi-segment value).
    for (const root of ['api', 'login', 'users', 'sources', 'profiles', 'preview', 'logs', '_nuxt']) {
      expect(validateSubPath(root).ok, root).toBe(false);
      expect(validateSubPath(`${root}/x`).ok, `${root}/x`).toBe(false);
    }
    expect(validateSubPath(42).ok).toBe(false);
  });

  it('rejects the effective admin entrance path', () => {
    expect(validateSubPath('login')).toMatchObject({ ok: false });
    process.env.SUBHUB_ADMIN_PATH = '/panel/enter';
    // The collision rule is on the full admin path (all its segments), not on
    // its first segment; the prefix must never resolve to the entrance itself.
    expect(validateSubPath('panel/enter')).toMatchObject({ ok: false });
    expect(validateSubPath('panel')).toMatchObject({ ok: true, value: 'panel' });
    expect(validateSubPath('panel/enter')).toMatchObject({ ok: false });
  });
});

describe('settings storage + API', () => {
  it('GET returns the defaults; PUT persists the normalised prefix', async () => {
    const initial = await callSettings('GET');
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ subPath: 's', defaultSubPath: 's', adminPath: 'login' });
    expect(initial.body.reservedRoots).toContain('api');

    const saved = await callSettings('PUT', { subPath: ' /dl/ ' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ subPath: 'dl' });
    expect(getSubPath(db)).toBe('dl');
    expect(readSetting(db, 'sub_path')).toBe('dl');
    // One row per key: a second save updates in place.
    await callSettings('PUT', { subPath: 'x/y' });
    expect(db.select().from(settings).all().map((row) => [row.key, row.value])).toEqual([
      ['sub_path', 'x/y'],
    ]);
  });

  it('rejects invalid values with 400 and keeps the old prefix', async () => {
    await callSettings('PUT', { subPath: 'dl' });
    for (const bad of ['', '   ', 'API', 'a.b', 'x'.repeat(65), 'login', '/api/', 12, null]) {
      const res = await callSettings('PUT', { subPath: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(typeof res.body.error).toBe('string');
      expect(getSubPath(db)).toBe('dl');
    }
    const noBody = await callSettings('PUT');
    expect(noBody.status).toBe(400);
    expect(getSubPath(db)).toBe('dl');
  });

  it('rejects the admin entrance path with 400', async () => {
    const res = await callSettings('PUT', { subPath: 'login' });
    expect(res.status).toBe(400);
    expect(getSubPath(db)).toBe('s');
  });

  it('requires an admin session', async () => {
    const anon = makeApiEvent({ url: '/api/admin/settings', method: 'PUT', body: { subPath: 'dl' } });
    expect(await settingsPutHandler(anon.event, options)).toEqual({ error: 'unauthorized' });
    expect(anon.event.node.res.statusCode).toBe(401);
    expect(getSubPath(db)).toBe('s');
  });

  it('setSubPath throws (no write) for an invalid value', () => {
    expect(() => setSubPath(db, 'BAD PATH')).toThrow();
    expect(getSubPath(db)).toBe('s');
  });

  it('exposes the effective prefix on the stats payload the UI builds links from', async () => {
    await callSettings('PUT', { subPath: 'dl/sub' });
    const { event } = authenticatedEvent({ url: '/api/admin/stats' }, options.revocations);
    const body = (await statsHandler(event, options)) as { settings: { subPath: string } };
    expect(body.settings).toEqual({ subPath: 'dl/sub' });
  });
});

describe('decideSubscriptionRewrite', () => {
  it('changes nothing while the prefix is the default `s`', () => {
    for (const path of ['/s/tok', '/s/tok/clash', '/s', '/', '/users', '/api/admin/me']) {
      expect(decideSubscriptionRewrite(path, 's')).toEqual({ action: 'continue' });
    }
  });

  it('rewrites the effective prefix onto the implementation root', () => {
    expect(decideSubscriptionRewrite('/dl/tok', 'dl')).toEqual({
      action: 'rewrite',
      implementationPath: '/s/tok',
    });
    expect(decideSubscriptionRewrite('/dl/tok/clash', 'dl')).toEqual({
      action: 'rewrite',
      implementationPath: '/s/tok/clash',
    });
    expect(decideSubscriptionRewrite('/dl/tok/clash/v2o', 'dl')).toEqual({
      action: 'rewrite',
      implementationPath: '/s/tok/clash/v2o',
    });
  });

  it('answers 404 for the plain `/s/` path while a custom prefix is active', () => {
    expect(decideSubscriptionRewrite('/s/tok', 'dl')).toEqual({ action: 'not-found' });
    expect(decideSubscriptionRewrite('/s/tok/clash', 'dl')).toEqual({ action: 'not-found' });
    expect(decideSubscriptionRewrite('/sub/tok', 'dl')).toEqual({ action: 'continue' });
    expect(decideSubscriptionRewrite('/dl-tok/clash', 'dl')).toEqual({ action: 'continue' });
    expect(decideSubscriptionRewrite('/users', 'dl')).toEqual({ action: 'continue' });
  });

  it('matches multi-segment prefixes on whole segments', () => {
    expect(decideSubscriptionRewrite('/x/y/tok/clash', 'x/y')).toEqual({
      action: 'rewrite',
      implementationPath: '/s/tok/clash',
    });
    expect(decideSubscriptionRewrite('/x/y2/tok/clash', 'x/y')).toEqual({ action: 'continue' });
    expect(decideSubscriptionRewrite('/x/tok', 'x/y')).toEqual({ action: 'continue' });
    expect(decideSubscriptionRewrite('/s/tok', 'x/y')).toEqual({ action: 'not-found' });
  });
});

/**
 * Minimal fake Nitro event for the middleware (no h3 runtime). `_path` starts
 * as a plain property; the middleware redefines it as an accessor (see
 * `rewritePath`), which is exactly what the h3 build needs.
 */
function middlewareEvent(url: string) {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  let ended = false;
  const event: SubscriptionRewriteEvent = {
    node: {
      req: { url, originalUrl: url, headers: {} } as never,
      res: {
        statusCode: 200,
        setHeader(name: string, value: string) {
          headers[name.toLowerCase()] = value;
        },
        end(value?: string) {
          body = value;
          ended = true;
          return undefined;
        },
      },
    },
    _path: url.split('?')[0]!,
  };
  return { event, headers, body: () => body, ended: () => ended };
}

describe('sub-path Nitro middleware', () => {
  /**
   * The middleware's prefix source: the `sub_path` setting in the server DB.
   * Inject the seeded test DB through the repo's test seam (no env override
   * exists — the owner rejected one).
   */
  function setPrefix(prefix: string | null) {
    if (prefix === null) {
      db.delete(settings).where(eq(settings.key, 'sub_path')).run();
    } else {
      setSubPath(db, prefix);
    }
    __setServerDbForTest(db);
    invalidateSubPathCache();
  }

  it('leaves every request untouched under the default prefix', () => {
    // Default prefix: no database handle is even needed.
    const { event, ended } = middlewareEvent('/s/tok/clash');
    expect(() => subPathMiddleware(event)).not.toThrow();
    expect(ended()).toBe(false);
    expect(event.node.req.url).toBe('/s/tok/clash');
  });

  it('rewrites and 404s by the stored prefix, keeping the query string', () => {
    // The middleware reads the process-wide server DB (injected above).
    setPrefix('dl');

    const rewrite = middlewareEvent('/dl/tok/clash?flag=1');
    subPathMiddleware(rewrite.event);
    // `_path` is h3's routing key for every stack layer; `req.url` follows.
    // (`event.path` is a getter — never assigned; do not reintroduce that.)
    expect(rewrite.event._path).toBe('/s/tok/clash');
    expect(rewrite.event.node.req.url).toBe('/s/tok/clash');
    expect(rewrite.ended()).toBe(false);

    const blocked = middlewareEvent('/s/tok/clash');
    subPathMiddleware(blocked.event);
    expect(blocked.event.node.res!.statusCode).toBe(404);
    expect(blocked.ended()).toBe(true);
    expect(blocked.headers['cache-control']).toBe('no-store');
    expect(blocked.body()).toBe('Not Found\n');

    const untouched = middlewareEvent('/users');
    subPathMiddleware(untouched.event);
    expect(untouched.event.node.req.url).toBe('/users');
    expect(untouched.ended()).toBe(false);
  });

  it('reads the prefix from the path, not the dropped query string', () => {
    expect(subscriptionRequestPath(middlewareEvent('/dl/tok?x=/s/tok').event)).toBe('/dl/tok');
  });

  it('freezes the rewrite against h3\'s per-layer `_path` reset', () => {
    // Regression (built-server smoke test): h3 re-assigns `event._path` before
    // every stack layer, which silently undid a plain assignment and let
    // `/dl/<token>/clash` fall through to the page router (302 to /login).
    setPrefix('dl');
    const { event } = middlewareEvent('/dl/tok/clash');
    subPathMiddleware(event);
    expect(event._path).toBe('/s/tok/clash');
    // h3 keeps writing it; the rewrite must win.
    event._path = '/dl/tok/clash';
    expect(event._path).toBe('/s/tok/clash');
    // `event.path` (the getter the Nitro router and the SSR renderer read)
    // follows `_path`.
    expect(subscriptionRequestPath(event)).toBe('/s/tok/clash');
  });

  it('is a plain event handler (Nitro never passes `next`)', () => {
    expect(subPathMiddleware.length).toBe(1);
  });
});

describe('serving under the effective prefix', () => {
  /**
   * Rewrite the path like the middleware does, then resolve it like Nitro
   * (`requestFromEvent` reads the same `event.path`).
   */
  function request(path: string) {
    const decision = decideSubscriptionRewrite(path, getSubPath(db));
    if (decision.action === 'not-found') return { token: '', target: null as string | null };
    const implementationPath = decision.action === 'rewrite' ? decision.implementationPath : path;
    const event = { path: implementationPath, context: { params: {} }, node: { req: { headers: {} } } };
    return requestFromEvent(event as never);
  }

  it('default `s`: unchanged export', async () => {
    const direct = await exportAt(TOKEN, 'clash');
    expect(direct.status).toBe(200);
    expect(direct.body).toContain('香港 01');
    expect(decideSubscriptionRewrite('/s/' + TOKEN + '/clash', getSubPath(db))).toEqual({ action: 'continue' });
  });

  it('after saving `dl`, `/dl/<token>/clash` serves the same body and `/s/...` is 404', async () => {
    const before = await exportAt(TOKEN, 'clash');
    await callSettings('PUT', { subPath: 'dl' });

    const rewritten = request(`/dl/${TOKEN}/clash`);
    expect(rewritten).toMatchObject({ token: TOKEN, target: 'clash' });
    const after = await handleSubscriptionExport(rewritten, { db });
    expect(after.status).toBe(200);
    expect(after.body).toBe(before.body);

    expect(decideSubscriptionRewrite(`/s/${TOKEN}/clash`, getSubPath(db))).toEqual({
      action: 'not-found',
    });
  });

  it('multi-segment prefix `x/y` works', async () => {
    await callSettings('PUT', { subPath: 'x/y' });
    const rewritten = request(`/x/y/${TOKEN}/mihomo`);
    expect(rewritten).toMatchObject({ token: TOKEN, target: 'mihomo' });
    expect((await handleSubscriptionExport(rewritten, { db })).status).toBe(200);
    expect(decideSubscriptionRewrite(`/s/${TOKEN}/mihomo`, getSubPath(db))).toEqual({
      action: 'not-found',
    });
  });

  /**
   * Profile-suffix interplay (feat/profile-suffix, not on this branch's base):
   * with that feature, `requestFromEvent` turns the 3rd segment into
   * `profile` and `/dl/<token>/clash/<name>` applies that profile's override.
   * The override-only request field is passed through here because base main's
   * `ExportRequest` does not have it yet; the rewritten path is what this test
   * owns.
   */
  it('a trailing profile segment keeps its meaning under the custom prefix', async () => {
    const profile = db
      .insert(profiles)
      .values({
        name: 'v2o',
        iniText: ['[custom]', 'custom_proxy_group=🚀 节点选择`select`.*', 'ruleset=🚀 节点选择,[]MATCH'].join('\n'),
      })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();
    await callSettings('PUT', { subPath: 'dl' });

    const rewritten = request(`/dl/${TOKEN}/clash/v2o`);
    // The prefix rewrite produced the same request as `/s/<token>/clash/v2o`.
    expect(rewritten).toMatchObject({ token: TOKEN, target: 'clash' });
    const applied = await handleSubscriptionExport(
      { ...rewritten, profile: 'v2o' } as typeof rewritten & { profile: string },
      { db },
    );
    expect(applied.status).toBe(200);
    const doc = JSON.parse(JSON.stringify(parseYaml(applied.body))) as {
      'proxy-groups': Array<{ name: string }>;
      rules: string[];
    };
    expect(doc['proxy-groups'].map((group) => group.name)).toEqual(['🚀 节点选择']);
    expect(doc.rules).toContain('MATCH,🚀 节点选择');
  });
});

describe('UI link helpers use the effective prefix', () => {
  it('subscriptionUrlWithPrefix builds the link under the given prefix', () => {
    expect(subscriptionUrlWithPrefix('https://hub.example.com', 'dl', 'tok')).toBe(
      'https://hub.example.com/dl/tok',
    );
    expect(subscriptionUrlWithPrefix('https://hub.example.com/', 'dl', 'tok', 'clash')).toBe(
      'https://hub.example.com/dl/tok/clash',
    );
    expect(subscriptionUrlWithPrefix('https://hub.example.com', 'x/y', 'tok')).toBe(
      'https://hub.example.com/x/y/tok',
    );
    // Missing prefix / slashes / stray whitespace fall back to the default.
    expect(subscriptionUrlWithPrefix('https://hub.example.com', null, 'tok')).toBe(
      'https://hub.example.com/s/tok',
    );
    expect(subscriptionUrlWithPrefix('https://hub.example.com', ' /dl/ ', 'tok')).toBe(
      'https://hub.example.com/dl/tok',
    );
    expect(normalizeSubPathForUrl('')).toBe('s');
    // The legacy two-arg helper keeps the default prefix.
    expect(subscriptionUrl('https://hub.example.com', 'tok')).toBe('https://hub.example.com/s/tok');
  });

  it('subscriptionPathLabel shows the prefix and a masked token', () => {
    expect(subscriptionPathLabel('dl', 'abcdef1234567890')).toBe('/dl/abcdef12…7890');
    expect(subscriptionPathLabel(undefined, 'short')).toBe('/s/short');
  });

  it('validateSubPathInput mirrors the server rules', () => {
    const meta = { reservedRoots: ['api', 'login'], adminPath: 'login' };
    expect(validateSubPathInput(' /DL/ ', meta)).toEqual({ ok: true, value: 'dl' });
    expect(validateSubPathInput('', meta).ok).toBe(false);
    expect(validateSubPathInput('a.b', meta).ok).toBe(false);
    expect(validateSubPathInput('api', meta).ok).toBe(false);
    expect(validateSubPathInput('login', meta).ok).toBe(false);
  });
});
