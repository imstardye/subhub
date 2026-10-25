// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `subscription-userinfo` passthrough: header parsing, persistence on refresh,
 * aggregation at export time and the admin DTO fields.
 *
 * Same harness as the other DB-backed tests: a temporary SQLite file and an
 * injected fetcher — no test touches the network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SubhubDb } from '../server/db';
import { encrypt } from '../server/db/crypto';
import { sourceAllowedUsers, sources, users } from '../server/db/schema';
import {
  refreshAllDueSources,
  refreshSource,
  type Fetcher,
  type FetchResponse,
} from '../server/utils/refresh-sources';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { getSource } from '../server/utils/admin-sources';
import {
  aggregateUserInfo,
  formatUserInfo,
  hasUserInfo,
  parseUserInfo,
  USERINFO_HEADER,
  type SubscriptionUserInfo,
} from '../server/utils/userinfo';

const SOURCE_URL = 'https://example.com/fake-subscription?token=fake';
const SECOND_SOURCE_URL = 'https://example.com/fake-subscription?token=fake-2';
const THIRD_SOURCE_URL = 'https://example.com/fake-subscription?token=fake-3';
const BODY =
  'proxies:\n  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}\n';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const GI = 1024 ** 3;
const GB = 1024 ** 3;
const TB = 1024 ** 4;
const TOKEN = 'e'.repeat(32);

/** Cache YAML with one real node plus the given info pseudo-nodes. */
function cacheWithInfo(names: string[]): string {
  return [
    'proxies:',
    '  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
    ...names.map(
      (name) =>
        `  - {name: ${JSON.stringify(name)}, type: ss, server: info.example.com, port: 1, cipher: aes-128-gcm, password: "fake"}`,
    ),
    '',
  ].join('\n');
}

const dirs: string[] = [];
let db: SubhubDb;

beforeEach(() => {
  resetExportRateLimiter();
  const dir = mkdtempSync(join(tmpdir(), 'subhub-userinfo-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
});

afterEach(() => {
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function insertSource(overrides: Partial<typeof sources.$inferInsert> = {}): number {
  return db
    .insert(sources)
    .values({
      name: 'fixture-source',
      url: encrypt(SOURCE_URL),
      type: 'remote',
      refreshMinutes: 60,
      ...overrides,
    })
    .returning({ id: sources.id })
    .get()!.id;
}

/** Response with a `subscription-userinfo` header (or none when `null`). */
function okResponse(header: string | null): FetchResponse {
  const headers = new Map<string, string>();
  if (header !== null) headers.set(USERINFO_HEADER, header);
  return {
    ok: true,
    status: 200,
    text: async () => BODY,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
  };
}

function userInfoOf(sourceId: number) {
  const row = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
  return {
    upload: row.userinfoUpload,
    download: row.userinfoDownload,
    total: row.userinfoTotal,
    expire: row.userinfoExpire,
    refreshedAt: row.userinfoRefreshedAt?.getTime() ?? null,
  };
}

describe('parseUserInfo', () => {
  it('parses the full header', () => {
    expect(
      parseUserInfo(
        `upload=1024; download=2048; total=${100 * GI}; expire=1798761600`,
      ),
    ).toEqual({ upload: 1024, download: 2048, total: 100 * GI, expire: 1798761600 });
  });

  it('parses any subset of parts', () => {
    expect(parseUserInfo('upload=1')).toEqual({ upload: 1, download: null, total: null, expire: null });
    expect(parseUserInfo('download=5; expire=1700000000')).toEqual({
      upload: null,
      download: 5,
      total: null,
      expire: 1700000000,
    });
    expect(parseUserInfo('total=0')).toEqual({ upload: null, download: null, total: 0, expire: null });
    expect(parseUserInfo('expire=0')).toEqual({ upload: null, download: null, total: null, expire: 0 });
  });

  it('tolerates spelling differences providers use in the wild', () => {
    expect(parseUserInfo('  UPLOAD = 10 ;Download=20;  total=30 ; expire=40 ')).toEqual({
      upload: 10,
      download: 20,
      total: 30,
      expire: 40,
    });
    // `bytes` is an alias for `total`; unknown keys are ignored.
    expect(parseUserInfo('bytes=99; reset_day=1; foo=bar')).toEqual({
      upload: null,
      download: null,
      total: 99,
      expire: null,
    });
  });

  it.each([
    ['garbage words', 'not a header'],
    ['empty', ''],
    ['blank', '   '],
    ['no known keys', 'foo=1; bar=2'],
    ['all values invalid', 'upload=abc; download=-1; total=1.5GB; expire=soon'],
    ['empty values', 'upload=; download='],
    ['a lone separator', '; ; ;'],
  ])('stores nothing for %s', (_label, header) => {
    expect(parseUserInfo(header)).toBeNull();
  });

  it('keeps the valid parts of a partially broken header', () => {
    expect(parseUserInfo('upload=100; download=oops; total=-5; expire=1700000000')).toEqual({
      upload: 100,
      download: null,
      total: null,
      expire: 1700000000,
    });
  });

  it('rejects values that lose precision as a double', () => {
    expect(parseUserInfo('total=9007199254740993')).toBeNull();
    expect(parseUserInfo(`total=${Number.MAX_SAFE_INTEGER}`)).toEqual({
      upload: null,
      download: null,
      total: Number.MAX_SAFE_INTEGER,
      expire: null,
    });
  });

  it('handles a missing header', () => {
    expect(parseUserInfo(null)).toBeNull();
    expect(parseUserInfo(undefined)).toBeNull();
  });
});

describe('aggregateUserInfo', () => {
  const info = (parts: Partial<SubscriptionUserInfo>): SubscriptionUserInfo => ({
    upload: null,
    download: null,
    total: null,
    expire: null,
    ...parts,
  });

  it('sums traffic and keeps the smallest positive expire', () => {
    expect(
      aggregateUserInfo([
        info({ upload: 10, download: 1, total: 100, expire: 1_700_000_000 }),
        info({ upload: 20, total: 200, expire: 1_600_000_000 }),
        info({ download: 2 }),
        null,
      ]),
    ).toEqual({ upload: 30, download: 3, total: 300, expire: 1_600_000_000 });
  });

  it('ignores 0 and missing expires instead of reporting 1970', () => {
    expect(
      aggregateUserInfo([info({ total: 1, expire: 0 }), info({ expire: 1_700_000_000 })]),
    ).toEqual({ upload: null, download: null, total: 1, expire: 1_700_000_000 });
    expect(aggregateUserInfo([info({ total: 1, expire: 0 })])?.expire).toBeNull();
  });

  it('returns null when no source has anything', () => {
    expect(aggregateUserInfo([])).toBeNull();
    expect(aggregateUserInfo([null, undefined, info({})])).toBeNull();
    expect(hasUserInfo(null)).toBe(false);
  });

  it('formats only the parts that exist', () => {
    expect(
      formatUserInfo({ upload: 1, download: 2, total: 3, expire: 4 }),
    ).toBe('upload=1; download=2; total=3; expire=4');
    expect(formatUserInfo({ upload: null, download: 2, total: null, expire: 4 })).toBe(
      'download=2; expire=4',
    );
  });
});

describe('refresh persists subscription-userinfo', () => {
  it('stores every part of a full header', async () => {
    const id = insertSource();
    const header = `upload=${GI}; download=${2 * GI}; total=${100 * GI}; expire=1798761600`;
    const result = await refreshSource(db, id, {
      fetcher: async () => okResponse(header),
      now: () => NOW,
    });

    expect(result).toMatchObject({ outcome: 'refreshed' });
    expect(result.userinfo).toEqual({
      upload: GI,
      download: 2 * GI,
      total: 100 * GI,
      expire: 1798761600,
    });
    expect(userInfoOf(id)).toEqual({
      upload: GI,
      download: 2 * GI,
      total: 100 * GI,
      expire: 1798761600,
      refreshedAt: NOW,
    });
  });

  it('stores the parts of a partial header, leaving the rest NULL', async () => {
    const id = insertSource();
    await refreshSource(db, id, {
      fetcher: async () => okResponse('download=42; expire=1700000000'),
      now: () => NOW,
    });
    expect(userInfoOf(id)).toEqual({
      upload: null,
      download: 42,
      total: null,
      expire: 1700000000,
      refreshedAt: NOW,
    });
  });

  it('stores nothing for a garbage header', async () => {
    const id = insertSource();
    const result = await refreshSource(db, id, {
      fetcher: async () => okResponse('definitely-not-a-header'),
      now: () => NOW,
    });
    expect(result.outcome).toBe('refreshed');
    expect(result.userinfo).toBeUndefined();
    expect(userInfoOf(id)).toEqual({
      upload: null,
      download: null,
      total: null,
      expire: null,
      refreshedAt: null,
    });
  });

  it('keeps the stored values when a later refresh has no header', async () => {
    const id = insertSource();
    await refreshSource(db, id, {
      fetcher: async () => okResponse('upload=5; total=10; expire=1700000000'),
      now: () => NOW,
    });
    // Provider dropped the header: numbers are kept (nothing is zeroed) and
    // `userinfoRefreshedAt` still shows when they were captured.
    await refreshSource(db, id, {
      fetcher: async () => okResponse(null),
      now: () => NOW + 3_600_000,
    });
    expect(userInfoOf(id)).toEqual({
      upload: 5,
      download: null,
      total: 10,
      expire: 1700000000,
      refreshedAt: NOW,
    });

    // A parseable header replaces them.
    await refreshSource(db, id, {
      fetcher: async () => okResponse('upload=7; total=20'),
      now: () => NOW + 7_200_000,
    });
    expect(userInfoOf(id)).toEqual({
      upload: 7,
      download: null,
      total: 20,
      expire: null,
      refreshedAt: NOW + 7_200_000,
    });
  });

  it('does not touch stored userinfo on a failed refresh', async () => {
    const id = insertSource({ lastOkAt: new Date(NOW - 120 * 60_000) });
    await refreshSource(db, id, {
      fetcher: async () => okResponse('upload=5; total=10'),
      now: () => NOW,
    });

    const failed = await refreshSource(db, id, {
      fetcher: async () => ({ ok: false, status: 502, text: async () => '' }),
      now: () => NOW + 60_000,
    });
    expect(failed.outcome).toBe('failed');
    expect(userInfoOf(id)).toMatchObject({ upload: 5, total: 10, refreshedAt: NOW });
  });

  it('works through refreshAllDueSources', async () => {
    const id = insertSource();
    await refreshAllDueSources(db, {
      fetcher: async () => okResponse('upload=1; download=2; total=3; expire=4'),
      now: () => NOW,
    });
    expect(userInfoOf(id)).toMatchObject({ upload: 1, download: 2, total: 3, expire: 4 });
  });

  it('exposes the parsed info on the admin source DTO (additive)', async () => {
    const owner = db
      .insert(users)
      .values({ name: 'fixture-owner', token: 'a'.repeat(32) })
      .returning({ id: users.id })
      .get()!;
    const id = insertSource({ ownerUserId: owner.id });

    // Before any refresh: null, not a zeroed object.
    expect(getSource(db, id).userinfo).toBeNull();

    await refreshSource(db, id, {
      fetcher: async () => okResponse('upload=10; total=100; expire=1700000000'),
      now: () => NOW,
    });
    const dto = getSource(db, id);
    expect(dto.userinfo).toEqual({
      upload: 10,
      download: null,
      total: 100,
      expire: 1700000000,
      refreshedAt: new Date(NOW).toISOString(),
    });
    // Pre-existing fields keep their shape.
    expect(dto).toMatchObject({ id, name: 'fixture-source', hasCache: true, lastError: null });
  });
});

describe('export aggregates subscription-userinfo', () => {
  async function exportAs(token: string) {
    resetExportRateLimiter();
    return handleSubscriptionExport({ token, target: 'mihomo', ip: '127.0.0.1' }, { db });
  }

  function user(token: string): number {
    return db
      .insert(users)
      .values({ name: `fixture-${token.slice(0, 4)}`, token, enabled: true })
      .returning({ id: users.id })
      .get()!.id;
  }

  /** Attach a source to a user and give it a stored userinfo row. */
  function sourceWithUserInfo(
    ownerId: number | null,
    parts: Partial<{
      upload: number;
      download: number;
      total: number;
      expire: number;
    }>,
    overrides: Partial<typeof sources.$inferInsert> = {},
  ): number {
    return insertSource({
      type: 'local',
      cacheBlob: BODY,
      ownerUserId: ownerId,
      userinfoUpload: parts.upload ?? null,
      userinfoDownload: parts.download ?? null,
      userinfoTotal: parts.total ?? null,
      userinfoExpire: parts.expire ?? null,
      userinfoRefreshedAt: new Date(NOW),
      ...overrides,
    });
  }

  it('sums upload/download/total and picks the smallest positive expire', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(ownerId, { upload: 10, download: 1, total: 100, expire: 1_800_000_000 });
    sourceWithUserInfo(ownerId, { upload: 20, download: 2, total: 200, expire: 1_700_000_000 });
    // A source without an expire must not drag the aggregate to 0.
    sourceWithUserInfo(ownerId, { download: 4, total: 0 });

    const response = await exportAs(TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers['subscription-userinfo']).toBe(
      'upload=30; download=7; total=300; expire=1700000000',
    );
  });

  it('only aggregates the sources that user export merges', async () => {
    const ownerId = user(TOKEN);
    const otherId = user('f'.repeat(32));
    sourceWithUserInfo(ownerId, { upload: 10, total: 100 });
    // Another user's dedicated source is not part of this export.
    sourceWithUserInfo(otherId, { upload: 999, total: 999 });
    sourceWithUserInfo(null, { upload: 1, total: 1 });

    const response = await exportAs(TOKEN);
    expect(response.headers['subscription-userinfo']).toBe('upload=11; total=101');
    // And the numbers equal what that user's own export reports.
    expect((await exportAs('f'.repeat(32))).headers['subscription-userinfo']).toBe(
      'upload=1000; total=1000',
    );
  });

  it('restricted shares count only for allowlisted users', async () => {
    const ownerId = user(TOKEN);
    const shared = sourceWithUserInfo(null, { upload: 50, total: 500 }, { accessMode: 'restricted' });

    // Empty allowlist -> reaches nobody -> no header at all.
    expect((await exportAs(TOKEN)).headers).not.toHaveProperty('subscription-userinfo');

    db.insert(sourceAllowedUsers).values({ sourceId: shared, userId: ownerId }).run();
    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe('upload=50; total=500');
  });

  it('emits no header when no source has userinfo', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(ownerId, {});
    insertSource({ type: 'local', cacheBlob: BODY, ownerUserId: ownerId });

    const response = await exportAs(TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers).not.toHaveProperty('subscription-userinfo');
  });

  it('emits only the parts some source reported', async () => {
    const ownerId = user(TOKEN);
    // The export user owns this one; the public source only has a total.
    sourceWithUserInfo(ownerId, {});
    sourceWithUserInfo(null, { total: 1024 });

    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe('total=1024');
  });

  it('derives used from a total-only header and the remaining info node', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(
      ownerId,
      { total: TB },
      { cacheBlob: cacheWithInfo(['剩余流量：579.45 GB']) },
    );

    const used = TB - Math.round(579.45 * GB);
    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe(
      `upload=0; download=${used}; total=${TB}`,
    );
  });

  it('never overwrites real upload/download, even when they are 0', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(
      ownerId,
      { upload: 10, download: 20, total: 1000 },
      { cacheBlob: cacheWithInfo(['剩余流量：579.45 GB']) },
    );
    sourceWithUserInfo(
      ownerId,
      { upload: 0, download: 0, total: 2000 },
      { cacheBlob: cacheWithInfo(['剩余流量：1 GB']) },
    );

    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe(
      'upload=10; download=20; total=3000',
    );
  });

  it('does not invent usage without a remaining info node', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(ownerId, { total: 1024 });

    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe('total=1024');
  });

  it('clamps derived used at 0 when remaining exceeds the total', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(
      ownerId,
      { total: 1000 },
      { cacheBlob: cacheWithInfo(['剩余流量：2 GB']) },
    );

    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe(
      'upload=0; download=0; total=1000',
    );
  });

  it('fills a missing expire from a date node but not from open-ended text', async () => {
    const ownerId = user(TOKEN);
    const expire = Date.UTC(2026, 9, 1) / 1000;
    sourceWithUserInfo(
      ownerId,
      { total: TB },
      { cacheBlob: cacheWithInfo(['剩余流量：579.45 GB', '套餐到期：2026-10-01']) },
    );
    sourceWithUserInfo(
      ownerId,
      { total: 1024 },
      { cacheBlob: cacheWithInfo(['套餐到期：长期有效']) },
    );

    const used = TB - Math.round(579.45 * GB);
    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe(
      `upload=0; download=${used}; total=${TB + 1024}; expire=${expire}`,
    );
  });

  it('sums a derived source and a real-header source consistently', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(
      ownerId,
      { total: TB },
      { cacheBlob: cacheWithInfo(['剩余流量：579.45 GB']) },
    );
    sourceWithUserInfo(ownerId, { upload: 100, download: 200, total: 2000, expire: 1_800_000_000 });

    const used = TB - Math.round(579.45 * GB);
    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe(
      `upload=100; download=${used + 200}; total=${TB + 2000}; expire=1800000000`,
    );
  });

  it('clamps sums beyond the safe-integer range', async () => {
    const ownerId = user(TOKEN);
    sourceWithUserInfo(ownerId, { upload: Number.MAX_SAFE_INTEGER });
    sourceWithUserInfo(ownerId, { upload: Number.MAX_SAFE_INTEGER });

    expect((await exportAs(TOKEN)).headers['subscription-userinfo']).toBe(
      `upload=${Number.MAX_SAFE_INTEGER}`,
    );
  });

  it('end to end: refresh stores the header and the export passes it through', async () => {
    const ownerId = user(TOKEN);
    const first = insertSource({ ownerUserId: ownerId, url: encrypt(SOURCE_URL) });
    const second = insertSource({ ownerUserId: ownerId, url: encrypt(SECOND_SOURCE_URL) });
    const third = insertSource({
      ownerUserId: ownerId,
      url: encrypt(THIRD_SOURCE_URL),
    });

    const headers: Record<string, string | null> = {
      [SOURCE_URL]: 'upload=100; download=200; total=10000; expire=1900000000',
      [SECOND_SOURCE_URL]: 'upload=1; download=2; total=20000; expire=1800000000',
      // Garbage header: nothing stored for this source.
      [THIRD_SOURCE_URL]: '???',
    };
    const fetcher: Fetcher = async (url) => okResponse(headers[url] ?? null);
    const summary = await refreshAllDueSources(db, { fetcher, now: () => NOW });
    expect(summary).toMatchObject({ checked: 3, refreshed: 3, failed: 0 });
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);

    const response = await exportAs(TOKEN);
    expect(response.headers['subscription-userinfo']).toBe(
      'upload=101; download=202; total=30000; expire=1800000000',
    );
  });
});
