// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Self-service user center (`/my/<token>` + `/api/user/<token>/*`).
 *
 * The token *is* the credential, so every test here is written from the outside:
 * a real token resolves a user, the API returns only that user's data, every id
 * is validated against the owner, and a saved source URL never leaves the server
 * again. Handlers are called through the same minimal event shape the admin
 * tests use, with a temporary SQLite file — no Nitro server is started.
 *
 * What is asserted (spec):
 * - own-data only, disabled user -> minimal payload;
 * - traffic cards = exactly the DEDICATED sources, per-source userinfo kept
 *   apart, summary sums the dedicated sources only;
 * - no source URL (and no userinfo of a public/shared source) anywhere in the
 *   serialized payload — checked as a substring of `JSON.stringify`;
 * - add source -> dedicated, owned by the token holder, URL accepted but never
 *   echoed; modify replaces the URL only when the field is non-empty;
 * - inclusion toggle changes THAT user's export only, default is included,
 *   dedicated sources are not choosable;
 * - token rotation invalidates the old token everywhere;
 * - a source its owner paused leaves the exports.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { openDb, type SubhubDb } from '../server/db';
import { encrypt } from '../server/db/crypto';
import {
  profiles,
  sourceAllowedUsers,
  sources,
  userSourceChoices,
  users,
} from '../server/db/schema';
import { resolveSubPrefix } from '../server/utils/sub-prefix';
import userCenterReadHandler from '../server/api/user/[token].get';
import userSourceCreateHandler from '../server/api/user/[token]/sources/index.post';
import userSourceUpdateHandler from '../server/api/user/[token]/sources/[id].patch';
import userSourceDeleteHandler from '../server/api/user/[token]/sources/[id].delete';
import userChoiceHandler from '../server/api/user/[token]/choices.post';
import userRefreshHandler from '../server/api/user/[token]/refresh.post';
import userSourcesRefreshHandler from '../server/api/user/[token]/refresh-sources.post';
import userCustomTokenHandler from '../server/api/user/[token]/token.put';
import userCustomRulesHandler from '../server/api/user/[token]/rules.put';
import userOperatorsHandler from '../server/api/user/[token]/operators.put';
import userOperatorsPreviewHandler from '../server/api/user/[token]/operators/preview.post';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { requestFromEvent } from '../server/utils/export-handler';
import { hashPassword } from '../server/utils/user-password';
import { issueUserSession, USER_SESSION_COOKIE } from '../server/utils/user-session';
import type { RefreshOptions } from '../server/utils/refresh-sources';
import {
  summarizeTraffic,
  type UserCenterData,
  type UserCenterDisabledData,
} from '../server/utils/user-center';
import { makeApiEvent } from './helpers/admin-api';
import type { AdminApiEvent } from '../server/utils/admin-api';

type Handler = (event: AdminApiEvent, options?: { db?: SubhubDb }) => unknown;

/** Seeded tokens (real tokens are 32 random bytes hex; the length is what matters). */
const ALICE_TOKEN = 'a'.repeat(32);
const BOB_TOKEN = 'b'.repeat(32);
const DISABLED_TOKEN = 'd'.repeat(32);
/** Substrings that must never appear in any user-center payload. */
const SECRET_URLS = {
  alice: 'https://alice-provider.example.com/sub?token=alice-secret-123',
  bob: 'https://bob-provider.example.com/sub?token=bob-secret-456',
  public: 'https://public-provider.example.com/sub?token=public-secret-789',
  shared: 'https://shared-provider.example.com/sub?token=shared-secret-abc',
};

const NODE_ALICE = 'ALICE-NODE 节点';
const NODE_BOB = 'BOB-NODE 节点';
const NODE_PUBLIC = 'PUBLIC-NODE 节点';
const NODE_SHARED = 'SHARED-NODE 节点';

/**
 * Seed hash for the existing user-center tests: after the password gate these
 * flows are reached through a real session cookie, exactly as in the browser.
 * The hash itself is covered by tests/user-password.test.ts.
 */
const SEED_PASSWORD = 'user-center-test-password';
const SEED_HASH = hashPassword(SEED_PASSWORD);

/** Cache YAML holding a single ss node with the given name. */
function cacheWith(name: string): string {
  return [
    'proxies:',
    `  - {name: "${name}", type: ss, server: ${name.length}.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}`,
    '',
  ].join('\n');
}

/**
 * Offline contract: adding a source runs ONE immediate refresh through the real
 * refresh task. Node's global `fetch` cannot reach anything from this sandbox
 * (and tests must never try), so every add goes through this stub, which
 * answers a tiny valid subscription. `defaultFetcher()` reads the global
 * `fetch` lazily, so a spy installed here is what the task uses.
 */
const FETCHED_BODY = cacheWith('NEW-NODE 节点');
let fetchMock: ReturnType<typeof vi.fn>;

const dirs: string[] = [];
let db: SubhubDb;
let aliceId: number;
let bobId: number;
let disabledId: number;
let aliceSourceId: number;
let bomOnlySourceId: number;
let publicSourceId: number;
let sharedSourceId: number;

beforeEach(() => {
  resetExportRateLimiter();
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'subscription-userinfo' ? 'upload=1; download=2; total=100; expire=1900000000' : null) },
    text: async () => FETCHED_BODY,
  }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as never);
  const dir = mkdtempSync(join(tmpdir(), 'subhub-user-center-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });

  aliceId = db.insert(users).values({ name: 'alice', token: ALICE_TOKEN, enabled: true, note: '爱丽丝' }).returning({ id: users.id }).get()!.id;
  bobId = db.insert(users).values({ name: 'bob', token: BOB_TOKEN, enabled: true }).returning({ id: users.id }).get()!.id;
  disabledId = db.insert(users).values({ name: 'dora', token: DISABLED_TOKEN, enabled: false }).returning({ id: users.id }).get()!.id;
  // Every seeded user has a password so the pre-gate flows keep their meaning;
  // the session cookie is added per request by `call` below.
  db.update(users).set({ passwordHash: SEED_HASH, passwordVersion: 1 }).run();

  /** Make a clean remote source row (URL encrypted, as the admin API stores it). */
  const source = (row: {
    name: string;
    url: string;
    ownerUserId: number | null;
    accessMode?: 'all' | 'restricted';
  }) =>
    db
      .insert(sources)
      .values({
        name: row.name,
        url: encrypt(row.url),
        type: 'remote',
        ownerUserId: row.ownerUserId,
        accessMode: row.accessMode ?? 'all',
      })
      .returning({ id: sources.id })
      .get()!.id;

  aliceSourceId = source({ name: 'alice-own', url: SECRET_URLS.alice, ownerUserId: aliceId });
  bomOnlySourceId = source({ name: 'bob-own', url: SECRET_URLS.bob, ownerUserId: bobId });
  publicSourceId = source({ name: '公共源 A', url: SECRET_URLS.public, ownerUserId: null });
  sharedSourceId = source({ name: '共享源 B', url: SECRET_URLS.shared, ownerUserId: null, accessMode: 'restricted' });
  // Alice is allowlisted for the shared source, Bob is not.
  db.insert(sourceAllowedUsers).values({ sourceId: sharedSourceId, userId: aliceId }).run();

  // Node caches: exports need something to compare.
  db.update(sources).set({ cacheBlob: cacheWith(NODE_ALICE) }).where(eq(sources.id, aliceSourceId)).run();
  db.update(sources).set({ cacheBlob: cacheWith(NODE_BOB) }).where(eq(sources.id, bomOnlySourceId)).run();
  db.update(sources).set({ cacheBlob: cacheWith(NODE_PUBLIC) }).where(eq(sources.id, publicSourceId)).run();
  db.update(sources).set({ cacheBlob: cacheWith(NODE_SHARED) }).where(eq(sources.id, sharedSourceId)).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
  /** Exactly what a client would receive (the handler's JSON value). */
  json: string;
}

async function call(
  handler: Handler,
  options: { path: string; method?: string; body?: unknown },
  behavior: { session?: boolean } = {},
): Promise<ApiResult> {
  const { event } = makeApiEvent({ url: options.path, method: options.method ?? 'GET', body: options.body });
  if (behavior.session !== false) {
    // Attach the browser-equivalent session cookie for the user named in the
    // path. Unknown/empty tokens get none (the route answers 404 first).
    const match = /^\/api\/user\/([^/]+)/.exec(options.path);
    const rawToken = match ? decodeURIComponent(match[1]!) : '';
    const row = rawToken
      ? db.select().from(users).where(eq(users.token, rawToken)).get()
      : undefined;
    if (row?.passwordHash) {
      const session = issueUserSession(row);
      event.node.req.headers.cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
    }
  }
  const body = (await handler(event, { db })) as Record<string, unknown>;
  return { status: event.node.res.statusCode, body, json: JSON.stringify(body ?? null) };
}

const read = (token = ALICE_TOKEN, host = 'hub.example.com') =>
  call(userCenterReadHandler, {
    path: `/api/user/${token}`,
    method: 'GET',
  }).then(async (result) => {
    // `originFromEvent` reads the request host; the fake event sets localhost.
    void host;
    return result;
  });

const createSource = (token: string, body: unknown) =>
  call(userSourceCreateHandler, { path: `/api/user/${token}/sources`, method: 'POST', body });

const patchSource = (token: string, id: number | string, body: unknown) =>
  call(userSourceUpdateHandler, { path: `/api/user/${token}/sources/${id}`, method: 'PATCH', body });

const deleteSource = (token: string, id: number | string) =>
  call(userSourceDeleteHandler, { path: `/api/user/${token}/sources/${id}`, method: 'DELETE' });

const choose = (token: string, body: unknown) =>
  call(userChoiceHandler, { path: `/api/user/${token}/choices`, method: 'POST', body });

const rotate = (token: string) =>
  call(userRefreshHandler, { path: `/api/user/${token}/refresh`, method: 'POST' });

const refreshSources = (token: string) =>
  call(userSourcesRefreshHandler, { path: `/api/user/${token}/refresh-sources`, method: 'POST' });

/** Render one user's mihomo export (the real handler path). */
async function exportProxyNames(token: string): Promise<string[]> {
  resetExportRateLimiter();
  const event = {
    path: `/s/${token}/mihomo`,
    context: {},
    node: { req: { headers: { 'user-agent': 'subhub-test/1.0' } }, res: { statusCode: 200, setHeader() {} } },
  };
  const result = await handleSubscriptionExport(requestFromEvent(event as never), { db });
  expect(result.status).toBe(200);
  const document = parseYaml(result.body) as { proxies: Array<{ name: string }> };
  return document.proxies.map((proxy) => proxy.name);
}

function ready(result: ApiResult): UserCenterData {
  expect(result.status).toBe(200);
  return result.body as unknown as UserCenterData;
}

describe('GET /api/user/:token — own data only', () => {
  it('returns profile, links and own sources for the token holder', async () => {
    const data = ready(await read());
    expect(data.user).toMatchObject({ name: 'alice', note: '爱丽丝', enabled: true, token: ALICE_TOKEN });
    expect(data.targets).toHaveLength(8);
    expect(data.targets).toContain('shadowrocket-conf');
    expect(data.subPrefix).toBe('s');
    expect(data.mainLink).toMatch(new RegExp(`/s/${ALICE_TOKEN}$`));
    // Own sources: exactly Alice's dedicated row.
    expect(data.ownSources.map((item) => item.id)).toEqual([aliceSourceId]);
    expect(data.ownSources[0]).toMatchObject({ name: 'alice-own', enabled: true, nodeCount: 1 });
  });

  it('never leaks another user’s data', async () => {
    const data = ready(await read());
    expect(data.ownSources.some((item) => item.id === bomOnlySourceId)).toBe(false);
    expect(data.traffic.sources.some((card) => card.id === bomOnlySourceId)).toBe(false);
    expect(data.user.name).toBe('alice');
  });

  it('answers a bare 404 for an unknown or empty token', async () => {
    for (const token of ['f'.repeat(32), '', 'x']) {
      const result = await call(userCenterReadHandler, { path: `/api/user/${token}` });
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'not found' });
    }
  });

  it('answers the minimal payload for a disabled user', async () => {
    const result = await read(DISABLED_TOKEN);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ user: { enabled: false } } as UserCenterDisabledData);
    // No management action is possible for a disabled user.
    expect((await createSource(DISABLED_TOKEN, { name: 'x', url: 'https://a.example.com/s' })).status).toBe(403);
    expect((await choose(DISABLED_TOKEN, { sourceId: publicSourceId, included: false })).status).toBe(403);
    expect((await rotate(DISABLED_TOKEN)).status).toBe(403);
  });
});

describe('traffic cards', () => {
  it('are exactly the dedicated sources, with per-source userinfo kept apart', async () => {
    db.update(sources)
      .set({
        userinfoUpload: 100,
        userinfoDownload: 400,
        userinfoTotal: 10_000,
        userinfoExpire: 1_900_000_000,
        userinfoRefreshedAt: new Date(1_700_000_000_000),
      })
      .where(eq(sources.id, aliceSourceId))
      .run();
    // A second dedicated source without userinfo.
    const plainId = db
      .insert(sources)
      .values({ name: 'alice-plain', url: encrypt('https://plain.example.com/s'), type: 'remote', ownerUserId: aliceId })
      .returning({ id: sources.id })
      .get()!.id;

    const data = ready(await read());
    expect(data.traffic.sources.map((card) => card.id).sort((a, b) => a - b)).toEqual(
      [aliceSourceId, plainId].sort((a, b) => a - b),
    );
    const card = data.traffic.sources.find((item) => item.id === aliceSourceId)!;
    expect(card.userinfo).toEqual({ upload: 100, download: 400, total: 10_000, expire: 1_900_000_000 });
    expect(data.traffic.sources.find((item) => item.id === plainId)!.userinfo).toBeNull();

    // Summary: dedicated only — the public source has (huge) userinfo and must
    // not be summed into it.
    expect(data.traffic.summary).toMatchObject({
      upload: 100,
      download: 400,
      total: 10_000,
      used: 500,
      remaining: 9_500,
      expire: 1_900_000_000,
      sourcesWithUserinfo: 1,
      dedicatedCount: 2,
    });
  });

  it('never gives public/shared sources a card, userinfo or summary share', async () => {
    db.update(sources)
      .set({ userinfoUpload: 9_999, userinfoDownload: 9_999, userinfoTotal: 1, userinfoExpire: 1_600_000_000 })
      .where(eq(sources.id, publicSourceId))
      .run();
    db.update(sources)
      .set({ userinfoUpload: 5, userinfoDownload: 5, userinfoTotal: 100 })
      .where(eq(sources.id, sharedSourceId))
      .run();

    const data = ready(await read());
    expect(data.traffic.sources).toHaveLength(1);
    // Nothing at all reported -> the page says 暂无流量数据.
    expect(data.traffic.summary.sourcesWithUserinfo).toBe(0);
    expect(data.traffic.summary.used).toBeNull();
    expect(data.traffic.summary.total).toBeNull();
    expect(data.traffic.summary.expire).toBeNull();
    // Alice can still toggle the shared source she is allowlisted for (names only).
    expect(data.availableSources).toEqual([
      { id: publicSourceId, name: '公共源 A', kind: 'public', included: true },
      { id: sharedSourceId, name: '共享源 B', kind: 'shared', included: true },
    ]);
  });

  it('summarizeTraffic keeps "unknown" as null and takes the earliest expiry', () => {
    const summary = summarizeTraffic([
      { userinfo: { upload: 1, download: 2, total: 100, expire: 2_000 } },
      { userinfo: { upload: null, download: null, total: 50, expire: 1_500 } },
      { userinfo: null },
    ]);
    expect(summary).toMatchObject({ upload: 1, download: 2, total: 150, used: 3, remaining: 147, expire: 1_500, sourcesWithUserinfo: 2, dedicatedCount: 3 });
    expect(summarizeTraffic([])).toMatchObject({ used: null, total: null, expire: null, dedicatedCount: 0 });
  });
});

describe('write-only URL rule', () => {
  it('no endpoint of the feature serializes a saved source URL', async () => {
    const results = [
      await read(),
      await createSource(ALICE_TOKEN, { name: 'fresh', url: 'https://fresh.example.com/sub?token=fresh-secret' }),
      await patchSource(ALICE_TOKEN, aliceSourceId, { name: 'alice-own-renamed' }),
    ];
    for (const result of results) {
      for (const url of [...Object.values(SECRET_URLS), 'https://fresh.example.com/sub?token=fresh-secret']) {
        expect(result.json).not.toContain(url);
        // Even the host or the secret alone must not appear.
        expect(result.json).not.toContain(new URL(url).host);
        expect(result.json).not.toContain(new URL(url).searchParams.get('token')!);
      }
    }
  });

  it('accepts a URL on add but never echoes it', async () => {
    const result = await createSource(ALICE_TOKEN, {
      name: '自建机场',
      url: 'https://provider.example.net/sub?token=top-secret',
      userAgent: 'clash-verge/2.0',
    });
    expect(result.status).toBe(201);
    const item = result.body.item as { id: number; name: string; userAgent: string | null };
    expect(item.name).toBe('自建机场');
    expect(item.userAgent).toBe('clash-verge/2.0');
    expect(result.json).not.toContain('top-secret');
    expect(result.json).not.toContain('provider.example.net');
    expect(result.json).not.toContain('url');
    // `nodeCount` proves the one-off refresh ran against the submitted URL and
    // parsed its body (the fetcher saw that exact URL, the API never shows it).
    expect(fetchMock.mock.calls[0]![0]).toBe('https://provider.example.net/sub?token=top-secret');
    expect((result.body.item as { nodeCount: number }).nodeCount).toBe(1);
    // Stored encrypted, not as plaintext.
    const stored = db.select().from(sources).where(eq(sources.id, item.id)).get()!;
    expect(stored.url).not.toContain('top-secret');
  });

  it('replaces the URL only when a non-empty value is submitted', async () => {
    const before = db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()!;

    // Blank / absent URL: the saved ciphertext is untouched.
    for (const body of [{ name: 'renamed-1' }, { name: 'renamed-2', url: '' }, { name: 'renamed-3', url: '   ' }]) {
      const result = await patchSource(ALICE_TOKEN, aliceSourceId, body);
      expect(result.status).toBe(200);
      const after = db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()!;
      expect(after.url).toBe(before.url);
      expect(after.name).toBe(body.name);
    }

    // A real URL replaces it.
    const replaced = await patchSource(ALICE_TOKEN, aliceSourceId, { url: 'https://new-provider.example.com/s?k=v2' });
    expect(replaced.status).toBe(200);
    const after = db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()!;
    expect(after.url).not.toBe(before.url);
    expect(replaced.json).not.toContain('new-provider.example.com');
  });

  it('rejects an invalid replacement URL instead of storing it', async () => {
    const before = db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()!.url;
    const result = await patchSource(ALICE_TOKEN, aliceSourceId, { url: 'ftp://nope.example.com/x' });
    expect(result.status).toBe(400);
    expect(db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()!.url).toBe(before);
  });
});

describe('source management is scoped to the token owner', () => {
  it('creates a dedicated source owned by the token holder', async () => {
    const result = await createSource(ALICE_TOKEN, { name: 'mine', url: 'https://mine.example.com/s?t=1' });
    expect(result.status).toBe(201);
    const id = (result.body.item as { id: number }).id;
    const row = db.select().from(sources).where(eq(sources.id, id)).get()!;
    expect(row.ownerUserId).toBe(aliceId);
    expect(row.accessMode).toBe('all');
    expect(row.type).toBe('remote');
    // The immediate refresh ran (offline stub) and filled the new source.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((result.body as { refresh: string }).refresh).toBe('refreshed');
    expect(db.select().from(sources).where(eq(sources.id, id)).get()!.cacheBlob).toBe(FETCHED_BODY);
    // And it is the only new card for Alice, never for Bob.
    expect(ready(await read()).ownSources.map((item) => item.id)).toContain(id);
    expect(ready(await read(BOB_TOKEN)).ownSources.map((item) => item.id)).not.toContain(id);
  });

  it('ignores owner/mode/type/allowlist fields smuggled into the body', async () => {
    const result = await createSource(ALICE_TOKEN, {
      name: 'sneaky',
      url: 'https://sneaky.example.com/s',
      ownerUserId: null,
      accessMode: 'all',
      allowedUserIds: [bobId],
      type: 'local',
    });
    expect(result.status).toBe(201);
    const row = db.select().from(sources).where(eq(sources.id, (result.body.item as { id: number }).id)).get()!;
    expect(row.ownerUserId).toBe(aliceId);
    expect(row.type).toBe('remote');
    expect(db.select().from(sourceAllowedUsers).where(eq(sourceAllowedUsers.sourceId, row.id)).all()).toEqual([]);
  });

  it('requires a name and a URL on add', async () => {
    expect((await createSource(ALICE_TOKEN, { url: 'https://a.example.com/s' })).status).toBe(400);
    expect((await createSource(ALICE_TOKEN, { name: 'x' })).status).toBe(400);
    expect((await createSource(ALICE_TOKEN, { name: 'x', url: 'not-a-url' })).status).toBe(400);
    // A rejected body never reaches the network.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cannot read or modify another user’s source (404, same as unknown)', async () => {
    const foreign = await patchSource(ALICE_TOKEN, bomOnlySourceId, { name: 'hijacked' });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'source not found' });
    expect((await patchSource(ALICE_TOKEN, 999_999, { name: 'x' })).status).toBe(404);
    expect(db.select().from(sources).where(eq(sources.id, bomOnlySourceId)).get()!.name).toBe('bob-own');
    // A public source is not "own" either.
    expect((await patchSource(ALICE_TOKEN, publicSourceId, { name: 'x' })).status).toBe(404);
  });

  it('toggles enabled and the export drops the paused source', async () => {
    expect(await exportProxyNames(ALICE_TOKEN)).toContain(NODE_ALICE);
    const result = await patchSource(ALICE_TOKEN, aliceSourceId, { enabled: false });
    expect(result.status).toBe(200);
    expect((result.body.item as { enabled: boolean }).enabled).toBe(false);
    const names = await exportProxyNames(ALICE_TOKEN);
    expect(names).not.toContain(NODE_ALICE);
    // Bob's export is unaffected (it never had Alice's source anyway).
    expect(await exportProxyNames(BOB_TOKEN)).toContain(NODE_BOB);
  });

  it('updates the User-Agent field', async () => {
    const result = await patchSource(ALICE_TOKEN, aliceSourceId, { userAgent: 'sing-box/1.10' });
    expect(result.status).toBe(200);
    expect((result.body.item as { userAgent: string }).userAgent).toBe('sing-box/1.10');
  });
});

describe('inclusion overrides', () => {
  it('defaults to included and appears as a choice for public + allowlisted shared sources', async () => {
    const data = ready(await read());
    expect(data.availableSources.map((item) => [item.id, item.included])).toEqual([
      [publicSourceId, true],
      [sharedSourceId, true],
    ]);
    // Bob is not allowlisted for the shared source: he must not see it.
    expect(ready(await read(BOB_TOKEN)).availableSources.map((item) => item.id)).toEqual([publicSourceId]);
  });

  it('excludes the source from THIS user’s export only', async () => {
    expect(await exportProxyNames(ALICE_TOKEN)).toEqual(
      expect.arrayContaining([NODE_ALICE, NODE_PUBLIC, NODE_SHARED]),
    );

    const result = await choose(ALICE_TOKEN, { sourceId: publicSourceId, included: false });
    expect(result.status).toBe(200);
    expect(result.body.item).toEqual({ id: publicSourceId, name: '公共源 A', kind: 'public', included: false });

    const alice = await exportProxyNames(ALICE_TOKEN);
    expect(alice).not.toContain(NODE_PUBLIC);
    expect(alice).toEqual(expect.arrayContaining([NODE_ALICE, NODE_SHARED]));

    // Bob made no choice: he still gets the public source.
    expect(await exportProxyNames(BOB_TOKEN)).toEqual(expect.arrayContaining([NODE_PUBLIC, NODE_BOB]));
    // ... and the shared source he is not allowlisted for never appears.
    expect(await exportProxyNames(BOB_TOKEN)).not.toContain(NODE_SHARED);
  });

  it('persists the choice and reports it back', async () => {
    await choose(ALICE_TOKEN, { sourceId: sharedSourceId, included: false });
    const data = ready(await read());
    expect(data.availableSources.find((item) => item.id === sharedSourceId)!.included).toBe(false);
    // Stored as a row, not as a deletion of the source or the allowlist.
    expect(db.select().from(userSourceChoices).all()).toEqual([
      { userId: aliceId, sourceId: sharedSourceId, included: false },
    ]);

    // Re-including updates the row (no duplicate key error) and restores it.
    const again = await choose(ALICE_TOKEN, { sourceId: sharedSourceId, included: true });
    expect(again.status).toBe(200);
    expect(await exportProxyNames(ALICE_TOKEN)).toContain(NODE_SHARED);
    expect(db.select().from(userSourceChoices).all()).toHaveLength(1);
  });

  it('rejects dedicated, foreign and unknown ids (404) and a non-boolean', async () => {
    const ids = [aliceSourceId, bomOnlySourceId, publicSourceId + 1000];
    for (const sourceId of ids) {
      const result = await choose(ALICE_TOKEN, { sourceId, included: false });
      expect(result.status).toBe(404);
    }
    // A shared source the user is NOT allowlisted for is equally invisible.
    expect((await choose(BOB_TOKEN, { sourceId: sharedSourceId, included: false })).status).toBe(404);
    expect((await choose(ALICE_TOKEN, { sourceId: publicSourceId })).status).toBe(400);
    expect(db.select().from(userSourceChoices).all()).toEqual([]);
  });

  it('keeps the profile-rule export and preview in step with the choice', async () => {
    const { previewSubscription } = await import('../server/utils/admin-preview');
    await choose(ALICE_TOKEN, { sourceId: publicSourceId, included: false });
    const preview = await previewSubscription(db, { userId: aliceId, target: 'shadowrocket' });
    const links = Buffer.from(preview.body, 'base64').toString('utf8');
    expect(links).not.toContain(encodeURIComponent(NODE_PUBLIC));
    expect(links).toContain(encodeURIComponent(NODE_ALICE));
  });
});

describe('token rotation', () => {
  it('rotates: the old token is 404 everywhere and the new one works', async () => {
    const rotated = await rotate(ALICE_TOKEN);
    expect(rotated.status).toBe(200);
    const newToken = (rotated.body as { token: string }).token;
    expect(newToken).not.toBe(ALICE_TOKEN);
    expect(newToken).toMatch(/^[0-9a-f]{64}$/);

    // The old token: page API, mutations and the export are all gone.
    expect((await read(ALICE_TOKEN)).status).toBe(404);
    expect((await createSource(ALICE_TOKEN, { name: 'x', url: 'https://a.example.com/s' })).status).toBe(404);
    resetExportRateLimiter();
    const oldExport = await handleSubscriptionExport(
      requestFromEvent({
        path: `/s/${ALICE_TOKEN}`,
        context: {},
        node: { req: { headers: { 'user-agent': 'subhub-test/1.0' } }, res: { statusCode: 200, setHeader() {} } },
      } as never),
      { db },
    );
    expect(oldExport.status).toBe(404);

    // The new token works and carries the same data.
    const data = ready(await read(newToken));
    expect(data.user.token).toBe(newToken);
    expect(data.mainLink).toContain(newToken);
    expect(data.ownSources.map((item) => item.id)).toEqual([aliceSourceId]);
    expect(await exportProxyNames(newToken)).toContain(NODE_ALICE);
  });

  it('does not rotate on GET (the route only exports POST)', async () => {
    // The page's rotate button POSTs; a GET is not a route at all. What matters
    // here is that the handler family never rotates as a side effect of reading.
    const before = db.select({ token: users.token }).from(users).where(eq(users.id, aliceId)).get()!.token;
    await read();
    expect(db.select({ token: users.token }).from(users).where(eq(users.id, aliceId)).get()!.token).toBe(before);
  });
});

describe('custom token (PUT /api/user/:token/token)', () => {
  const setCustom = (token: string, body: unknown, behavior?: { session?: boolean }) =>
    call(userCustomTokenHandler, { path: `/api/user/${token}/token`, method: 'PUT', body }, behavior);

  it('requires the unlocked session (password gate)', async () => {
    const result = await setCustom(ALICE_TOKEN, { token: 'alice-custom-1' }, { session: false });
    expect(result.status).toBe(401);
    expect(db.select({ token: users.token }).from(users).where(eq(users.id, aliceId)).get()!.token).toBe(ALICE_TOKEN);
  });

  it('rejects malformed tokens with 400', async () => {
    for (const bad of ['short', 'has space init', '-leading-dash', 'a'.repeat(65), 42, null]) {
      expect((await setCustom(ALICE_TOKEN, { token: bad })).status).toBe(400);
    }
  });

  it('rejects another user\'s token with 409 (case-sensitive)', async () => {
    expect((await setCustom(ALICE_TOKEN, { token: BOB_TOKEN })).status).toBe(409);
  });

  it('sets it: old token dies everywhere, new one works, session survives', async () => {
    const result = await setCustom(ALICE_TOKEN, { token: 'alice-custom-1' });
    expect(result.status).toBe(200);
    expect((result.body as { token: string }).token).toBe('alice-custom-1');

    expect((await read(ALICE_TOKEN)).status).toBe(404);
    // `call` attaches the session for the user behind the NEW path token —
    // the same user row and password version, so a 200 here also proves the
    // pre-change session cookie would still verify after navigation.
    const data = ready(await read('alice-custom-1'));
    expect(data.user.token).toBe('alice-custom-1');
    expect(data.ownSources.map((item) => item.id)).toEqual([aliceSourceId]);
    expect(await exportProxyNames('alice-custom-1')).toContain(NODE_ALICE);
  });

  it('setting the current token again is a no-op success', async () => {
    await setCustom(ALICE_TOKEN, { token: 'alice-custom-2' });
    const again = await setCustom('alice-custom-2', { token: 'alice-custom-2' });
    expect(again.status).toBe(200);
    expect((again.body as { token: string }).token).toBe('alice-custom-2');
  });
});

describe('add-source one-off refresh', () => {
  it('uses the injected fetcher (never the network) and keeps the source on failure', async () => {
    const { addOwnSource } = await import('../server/utils/user-center');
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return {
        ok: false,
        status: 500,
        headers: { get: () => null },
        text: async () => '',
      };
    };
    const result = await addOwnSource(
      db,
      aliceId,
      { name: 'flaky', url: 'https://flaky.example.com/s' },
      { fetcher: fetcher as unknown as RefreshOptions['fetcher'] },
    );
    expect(calls).toEqual(['https://flaky.example.com/s']);
    expect(result.refresh).toBe('failed');
    expect(resolveSubPrefix(db)).toBe('s');
    expect(result.source).toMatchObject({ name: 'flaky', health: { state: 'failed' } });
  });
});

describe('profile data for the link switcher', () => {
  it('lists profile names and the assigned one, without writing it', async () => {
    db.insert(profiles).values({ name: 'v2', iniText: '[custom]\n' }).run();
    const second = db.insert(profiles).values({ name: 'v2o', iniText: '[custom]\n' }).run();
    void second;
    const assignedId = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.name, 'v2')).get()!.id;
    db.update(users).set({ profileId: assignedId }).where(eq(users.id, aliceId)).run();

    const data = ready(await read());
    expect(data.profile).toEqual({ assignedProfile: 'v2', profileNames: ['v2', 'v2o'] });

    // Reading (and the page's switcher, which is pure) never touches the row.
    expect(ready(await read()).profile.assignedProfile).toBe('v2');
    expect(db.select({ profileId: users.profileId }).from(users).where(eq(users.id, aliceId)).get()!.profileId).toBe(assignedId);
  });
});

describe('DELETE /api/user/:token/sources/:id — delete an own dedicated source', () => {
  it('deletes the token owner’s own source and cascades its related rows', async () => {
    // Related rows that must not survive the source.
    db.insert(sourceAllowedUsers).values({ sourceId: aliceSourceId, userId: bobId }).run();
    db.insert(userSourceChoices).values({ userId: aliceId, sourceId: aliceSourceId, included: false }).run();

    const result = await deleteSource(ALICE_TOKEN, aliceSourceId);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, id: aliceSourceId, name: 'alice-own' });
    // The URL never comes back (write-only rule), not even masked.
    expect(result.json).not.toContain('alice-provider.example.com');
    expect(result.json).not.toContain('alice-secret-123');

    expect(db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()).toBeUndefined();
    expect(db.select().from(sourceAllowedUsers).where(eq(sourceAllowedUsers.sourceId, aliceSourceId)).all()).toEqual([]);
    expect(db.select().from(userSourceChoices).where(eq(userSourceChoices.sourceId, aliceSourceId)).all()).toEqual([]);

    // Gone from the page payload and from every export.
    const data = ready(await read());
    expect(data.ownSources.map((item) => item.id)).not.toContain(aliceSourceId);
    expect(data.traffic.sources.map((card) => card.id)).not.toContain(aliceSourceId);
    expect(await exportProxyNames(ALICE_TOKEN)).not.toContain(NODE_ALICE);
    // Bob and the public/shared sources are untouched.
    expect(db.select().from(sources).where(eq(sources.id, bomOnlySourceId)).get()).toBeDefined();
    expect(db.select().from(sources).where(eq(sources.id, publicSourceId)).get()).toBeDefined();
  });

  it('refuses another user’s source, a public/shared source and an unknown id', async () => {
    const before = db.select().from(sources).all().length;
    const attempts: Array<[string, number | string]> = [
      [ALICE_TOKEN, bomOnlySourceId], // Bob's dedicated source
      [ALICE_TOKEN, publicSourceId], // public
      [ALICE_TOKEN, sharedSourceId], // shared (Alice is allowlisted, still not hers)
      [ALICE_TOKEN, 999_999], // unknown
      [ALICE_TOKEN, 'abc'], // malformed
    ];
    for (const [token, id] of attempts) {
      const result = await deleteSource(token, id);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'source not found' });
    }
    // Nothing was removed by any refused attempt.
    expect(db.select().from(sources).all().length).toBe(before);
    expect(db.select({ id: sources.id }).from(sources).where(eq(sources.id, bomOnlySourceId)).get()).toBeDefined();
  });

  it('answers 404 for an unknown/empty token and 403 for a disabled user', async () => {
    for (const token of ['f'.repeat(32), '']) {
      const result = await deleteSource(token, aliceSourceId);
      expect(result.status).toBe(404);
      // A missing token with an *existing* id must not leak that the id exists.
      expect(result.body).toEqual({ error: 'not found' });
    }
    expect((await deleteSource(DISABLED_TOKEN, aliceSourceId)).status).toBe(403);
    expect(db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()).toBeDefined();
  });

  it('is idempotent-once: the second delete of the same id is a 404', async () => {
    expect((await deleteSource(ALICE_TOKEN, aliceSourceId)).status).toBe(200);
    const again = await deleteSource(ALICE_TOKEN, aliceSourceId);
    expect(again.status).toBe(404);
    expect(again.body).toEqual({ error: 'source not found' });
  });
});

describe('POST /api/user/:token/refresh-sources — manual refresh of own dedicated sources', () => {
  it('requires the unlocked session (password gate)', async () => {
    const eventOptions = { path: `/api/user/${ALICE_TOKEN}/refresh-sources`, method: 'POST' };
    const result = await call(userSourcesRefreshHandler, eventOptions, { session: false });
    expect(result.status).toBe(401);
    expect(result.body.status).toBe('needs-password');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes only the token owner’s dedicated source and updates cache + userinfo', async () => {
    const before = new Map(
      db.select({ id: sources.id, cacheBlob: sources.cacheBlob }).from(sources).all().map((row) => [row.id, row.cacheBlob]),
    );

    const result = await refreshSources(ALICE_TOKEN);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      refreshed: 1,
      failed: 0,
      skipped: 0,
      results: [{ id: aliceSourceId, name: 'alice-own', ok: true, skipped: false }],
    });

    // Exactly one upstream call: Alice's source. Bob's, public and shared are
    // untouched (their caches are byte-identical to before).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(SECRET_URLS.alice);
    for (const id of [bomOnlySourceId, publicSourceId, sharedSourceId]) {
      expect(db.select({ cacheBlob: sources.cacheBlob }).from(sources).where(eq(sources.id, id)).get()!.cacheBlob).toBe(before.get(id));
    }

    const alice = db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()!;
    expect(alice.cacheBlob).toBe(FETCHED_BODY);
    expect(alice.lastOkAt).not.toBeNull();
    expect(alice.lastError).toBeNull();
    expect(alice.userinfoUpload).toBe(1);
    expect(alice.userinfoDownload).toBe(2);
    expect(alice.userinfoTotal).toBe(100);
    expect(alice.userinfoExpire).toBe(1_900_000_000);

    // The read API reflects the new cache/userinfo.
    const data = ready(await read());
    expect(data.ownSources.find((item) => item.id === aliceSourceId)).toMatchObject({ hasCache: true, nodeCount: 1 });
    const card = data.traffic.sources.find((item) => item.id === aliceSourceId)!;
    expect(card.userinfo).toEqual({ upload: 1, download: 2, total: 100, expire: 1_900_000_000 });
  });

  it('skips a paused source and leaves its cache untouched', async () => {
    db.update(sources).set({ enabled: false }).where(eq(sources.id, aliceSourceId)).run();
    const before = db.select({ cacheBlob: sources.cacheBlob }).from(sources).where(eq(sources.id, aliceSourceId)).get()!.cacheBlob;

    const result = await refreshSources(ALICE_TOKEN);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      refreshed: 0,
      failed: 0,
      skipped: 1,
      results: [{ id: aliceSourceId, name: 'alice-own', ok: false, skipped: true }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.select({ cacheBlob: sources.cacheBlob }).from(sources).where(eq(sources.id, aliceSourceId)).get()!.cacheBlob).toBe(before);
  });

  it('counts an upstream failure and keeps the previous cache', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: { get: () => null },
      text: async () => '',
    });
    const before = db.select({ cacheBlob: sources.cacheBlob }).from(sources).where(eq(sources.id, aliceSourceId)).get()!.cacheBlob;

    const result = await refreshSources(ALICE_TOKEN);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      refreshed: 0,
      failed: 1,
      skipped: 0,
      results: [{ id: aliceSourceId, name: 'alice-own', ok: false, skipped: false, error: 'HTTP 502' }],
    });

    const alice = db.select().from(sources).where(eq(sources.id, aliceSourceId)).get()!;
    expect(alice.cacheBlob).toBe(before);
    expect(alice.lastError).toBe('HTTP 502');
  });
});

describe('custom rules (PUT /api/user/:token/rules)', () => {
  const GROUP = '🚀 节点选择';
  const putRules = (token: string, body: unknown, behavior: { session?: boolean } = {}) =>
    call(userCustomRulesHandler, { path: `/api/user/${token}/rules`, method: 'PUT', body }, behavior);

  /** Give alice the profile her rules are validated against. */
  function assignProfile() {
    const profile = db
      .insert(profiles)
      .values({
        name: 'rules-profile',
        iniText: [
          '[custom]',
          `custom_proxy_group=${GROUP}\`select\`.*`,
          `ruleset=${GROUP},[]MATCH`,
        ].join('\n'),
      })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, aliceId)).run();
  }

  it('is behind the password gate like every other write', async () => {
    assignProfile();
    const locked = await putRules(ALICE_TOKEN, { rules: 'DOMAIN-SUFFIX,a.com,DIRECT' }, { session: false });
    expect(locked.status).toBe(401);
  });

  it('saves validated rules and the read payload carries them', async () => {
    assignProfile();
    const saved = await putRules(ALICE_TOKEN, {
      rules: `DOMAIN-SUFFIX,example.com,${GROUP}\nDOMAIN-KEYWORD,ads,REJECT`,
      position: 'append',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      customRules: {
        text: `DOMAIN-SUFFIX,example.com,${GROUP}\nDOMAIN-KEYWORD,ads,REJECT`,
        position: 'append',
        count: 2,
      },
    });
    const data = ready(await read());
    expect(data.customRules.text).toBe(`DOMAIN-SUFFIX,example.com,${GROUP}\nDOMAIN-KEYWORD,ads,REJECT`);
    expect(data.customRules.position).toBe('append');
  });

  it('rejects bad lines and unknown policies with a 400 and writes nothing', async () => {
    assignProfile();
    const badType = await putRules(ALICE_TOKEN, { rules: 'WTAF,x,DIRECT' });
    expect(badType.status).toBe(400);
    expect(String((badType.body as { error?: string }).error)).toContain('第 1 行');
    const badPolicy = await putRules(ALICE_TOKEN, { rules: 'DOMAIN-SUFFIX,a.com,没有这组' });
    expect(badPolicy.status).toBe(400);
    const row = db.select().from(users).where(eq(users.id, aliceId)).get()!;
    expect(row.customRules).toBeNull();
  });

  it('a user without a profile cannot save rules yet (but the export still works)', async () => {
    const result = await putRules(BOB_TOKEN, { rules: 'DOMAIN-SUFFIX,a.com,DIRECT' });
    expect(result.status).toBe(400);
    expect(String((result.body as { error?: string }).error)).toContain('尚未分配规则档');
  });

  it('clearing is always allowed', async () => {
    assignProfile();
    await putRules(ALICE_TOKEN, { rules: 'DOMAIN-SUFFIX,example.com,DIRECT' });
    const cleared = await putRules(ALICE_TOKEN, { rules: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ customRules: { text: '', count: 0 } });
  });
});

describe('operators (PUT /api/user/:token/operators + preview)', () => {
  const GROUP = '🚀 节点选择';
  const putOps = (token: string, body: unknown, behavior: { session?: boolean } = {}) =>
    call(userOperatorsHandler, { path: `/api/user/${token}/operators`, method: 'PUT', body }, behavior);
  const previewOps = (token: string, body: unknown) =>
    call(userOperatorsPreviewHandler, { path: `/api/user/${token}/operators/preview`, method: 'POST', body });

  function assignProfile() {
    const profile = db
      .insert(profiles)
      .values({
        name: 'ops-profile',
        iniText: ['[custom]', `custom_proxy_group=${GROUP}\`select\`.*`, `ruleset=${GROUP},[]MATCH`].join('\n'),
      })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, aliceId)).run();
  }

  it('is behind the password gate', async () => {
    const locked = await putOps(ALICE_TOKEN, { operators: [] }, { session: false });
    expect(locked.status).toBe(401);
  });

  it('saves a validated pipeline and the read payload carries it', async () => {
    assignProfile();
    const saved = await putOps(ALICE_TOKEN, {
      operators: [{ type: 'regex-filter', pattern: 'PUBLIC', mode: 'drop' }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ count: 1 });
    const data = ready(await read());
    expect(data.operators).toEqual([{ type: 'regex-filter', pattern: 'PUBLIC', mode: 'drop' }]);
    // The export itself drops the public node now.
    const exported = await exportProxyNames(ALICE_TOKEN);
    expect(exported).not.toContain(NODE_PUBLIC);
    expect(exported).toContain(NODE_ALICE);
  });

  it('rejects an uncompilable regex with a 400 naming the operator', async () => {
    const bad = await putOps(ALICE_TOKEN, {
      operators: [{ type: 'sort', mode: 'name-asc' }, { type: 'regex-filter', pattern: '(', mode: 'drop' }],
    });
    expect(bad.status).toBe(400);
    expect(String((bad.body as { error?: string }).error)).toContain('第 2 个算子');
  });

  it('the dry-run reports the effect without persisting anything', async () => {
    assignProfile();
    const result = await previewOps(ALICE_TOKEN, {
      operators: [{ type: 'regex-filter', pattern: 'PUBLIC', mode: 'drop' }],
    });
    expect(result.status).toBe(200);
    const preview = (result.body as { preview: { beforeNames: string[]; afterNames: string[]; droppedNames: string[]; groups: string[] } }).preview;
    expect(preview.beforeNames).toContain(NODE_PUBLIC);
    expect(preview.afterNames).not.toContain(NODE_PUBLIC);
    expect(preview.droppedNames).toEqual([NODE_PUBLIC]);
    expect(preview.groups).toEqual([GROUP]);
    const row = db.select().from(users).where(eq(users.id, aliceId)).get()!;
    expect(row.operators).toBeNull();
  });
});
