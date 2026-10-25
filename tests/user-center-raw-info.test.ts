// SPDX-License-Identifier: AGPL-3.0-only
/**
 * (A) User center cards show the subscription's OWN report.
 *
 * Some providers send an incomplete `subscription-userinfo` header. Where the
 * header is silent, the numbers are taken from the info pseudo-nodes the
 * subscription itself carries (`剩余流量：579.45 GB`, `套餐到期：长期有效`,
 * `core/rules/raw-info.ts`). These tests pin:
 * - the pure parser (amounts, dates, `长期有效`, `剩余流量：0` is `0`);
 * - the merge rule: the header wins per field, only missing fields are filled;
 * - the DTO (`loadUserCenterData`) end to end: cache + header-only → remaining
 *   and expiry come from the nodes and 已用 = 总量 − 剩余;
 * - the export is NOT affected: the info nodes stay filtered out.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import { parse as parseYaml } from 'yaml';
import {
  EMPTY_RAW_TRAFFIC_INFO,
  hasRawTrafficInfo,
  parseByteAmount,
  parseExpireDate,
  parseExpireText,
  parseRawTrafficInfo,
} from '../core/rules/raw-info';
import {
  loadUserCenterData,
  mergeUserInfo,
  rawTrafficInfoFromCache,
  summarizeTraffic,
  type UserCenterData,
  type UserCenterTrafficSummary,
} from '../server/utils/user-center';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { requestFromEvent } from '../server/utils/export-handler';
import { trafficBar, trafficCard } from '../core/utils/user-center';
import type { SubscriptionUserInfo } from '../server/utils/userinfo';

const TOKEN = 'c'.repeat(32);
const GB = 1024 ** 3;
const TB = 1024 ** 4;

/** Cache YAML with one real node plus the given info pseudo-nodes. */
function cacheWithInfo(names: string[]): string {
  const rows = [
    'proxies:',
    '  - {name: "香港 01", type: ss, server: hk.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
    ...names.map(
      (name) =>
        `  - {name: ${JSON.stringify(name)}, type: ss, server: info.example.com, port: 1, cipher: aes-128-gcm, password: "fake"}`,
    ),
    '',
  ];
  return rows.join('\n');
}

const XXCLOUD_CACHE = cacheWithInfo(['剩余流量：579.45 GB', '套餐到期：长期有效']);

describe('parseRawTrafficInfo — the subscription’s own report', () => {
  it('parses 剩余流量：579.45 GB and 套餐到期：长期有效', () => {
    const info = parseRawTrafficInfo([
      { name: '香港 01' },
      { name: '剩余流量：579.45 GB' },
      { name: '套餐到期：长期有效' },
    ]);
    // 579.45 GiB, rounded to whole bytes.
    expect(info.remaining).toBe(Math.round(579.45 * GB));
    expect(info.remaining! / GB).toBeCloseTo(579.45, 6);
    expect(info.expire).toBeNull();
    expect(info.expireText).toBe('长期有效');
    expect(hasRawTrafficInfo(info)).toBe(true);
  });

  it('reads 剩余流量：0 as 0, never as "unknown"', () => {
    const info = parseRawTrafficInfo([{ name: '剩余流量：0' }]);
    expect(info.remaining).toBe(0);
    expect(info.remaining).not.toBeNull();
  });

  it('accepts the ASCII colon, extra spaces and every unit', () => {
    expect(parseByteAmount('579.45 GB')).toBe(Math.round(579.45 * GB));
    expect(parseByteAmount('1.5TB')).toBe(Math.round(1.5 * TB));
    expect(parseByteAmount('512 MB')).toBe(512 * 1024 ** 2);
    expect(parseByteAmount('100KB')).toBe(100 * 1024);
    expect(parseByteAmount('42 B')).toBe(42);
    expect(parseByteAmount('7')).toBe(7);
    expect(parseByteAmount('')).toBeNull();
    expect(parseByteAmount('abc')).toBeNull();
    expect(parseRawTrafficInfo([{ name: '剩余流量:100 GB' }]).remaining).toBe(100 * GB);
  });

  it('parses a date expiry into epoch seconds and keeps any other wording verbatim', () => {
    expect(parseExpireDate('2026-10-01')).toBe(Date.UTC(2026, 9, 1) / 1000);
    expect(parseExpireDate('2026/1/2')).toBe(Date.UTC(2026, 0, 2) / 1000);
    expect(parseExpireDate('2026-13-01')).toBeNull();
    expect(parseExpireText('长期有效')).toEqual({ expire: null, expireText: '长期有效' });
    expect(parseExpireText('2026-10-01')).toEqual({ expire: Date.UTC(2026, 9, 1) / 1000, expireText: null });

    const dated = parseRawTrafficInfo([{ name: '套餐到期：2026-10-01' }]);
    expect(dated.expire).toBe(Date.UTC(2026, 9, 1) / 1000);
    expect(dated.expireText).toBeNull();
  });

  it('ignores non-info nodes and empty input', () => {
    expect(parseRawTrafficInfo([{ name: '香港 剩余流量专用' }, { name: '' }])).toEqual(EMPTY_RAW_TRAFFIC_INFO);
    expect(parseRawTrafficInfo([])).toEqual(EMPTY_RAW_TRAFFIC_INFO);
    // Same keyword set as the export filter: an 官网 node is an info node but
    // carries no numbers, so it contributes nothing.
    expect(parseRawTrafficInfo([{ name: '官网 https://example.com' }])).toEqual(EMPTY_RAW_TRAFFIC_INFO);
  });

  it('uses the last report when a provider repeats the node', () => {
    const info = parseRawTrafficInfo([{ name: '剩余流量：100 GB' }, { name: '剩余流量：0' }]);
    expect(info.remaining).toBe(0);
  });

  it('reads the info nodes out of a cached subscription', () => {
    const info = rawTrafficInfoFromCache(XXCLOUD_CACHE)!;
    expect(info.remaining).toBe(Math.round(579.45 * GB));
    expect(info.expireText).toBe('长期有效');
    expect(rawTrafficInfoFromCache(null)).toBeNull();
    expect(rawTrafficInfoFromCache('   ')).toBeNull();
    expect(rawTrafficInfoFromCache(cacheWithInfo([]))).toBeNull();
  });
});

describe('mergeUserInfo — header wins, nodes only fill the gaps', () => {
  const raw = parseRawTrafficInfo([{ name: '剩余流量：579.45 GB' }, { name: '套餐到期：长期有效' }]);

  it('fills a partial header (only total) from the nodes', () => {
    const merged = mergeUserInfo({ upload: null, download: null, total: TB, expire: null }, raw);
    expect(merged.userinfo).toEqual({ upload: null, download: null, total: TB, expire: null });
    expect(merged.remaining).toBe(Math.round(579.45 * GB));
    expect(merged.expireText).toBe('长期有效');
    expect(merged.rawFields).toEqual(['remaining', 'expire']);
  });

  it('never overwrites a complete header', () => {
    const header: SubscriptionUserInfo = { upload: 100, download: 200, total: 1000, expire: 1_900_000_000 };
    const merged = mergeUserInfo(header, raw);
    expect(merged.userinfo).toEqual(header);
    expect(merged.remaining).toBe(700); // derived from the header
    expect(merged.expireText).toBeNull();
    expect(merged.rawFields).toEqual([]);

    // A header with usage but no expiry: only the expiry comes from the nodes.
    const partial = mergeUserInfo({ upload: 100, download: 200, total: 1000, expire: null }, raw);
    expect(partial.userinfo!.expire).toBeNull();
    expect(partial.expireText).toBe('长期有效');
    expect(partial.remaining).toBe(700);
    expect(partial.rawFields).toEqual(['expire']);
  });

  it('treats a total-only header as "usage unknown" and lets the node report', () => {
    // A header that reports the quota but no usage cannot say how much is left;
    // `total - 0 - 0` would equal the total and hide the provider's own figure.
    const merged = mergeUserInfo({ upload: null, download: null, total: 1000, expire: null }, raw);
    expect(merged.remaining).toBe(Math.round(579.45 * GB));
    expect(merged.rawFields).toContain('remaining');
  });

  it('works with no header at all, and stays empty with nothing', () => {
    const merged = mergeUserInfo(null, raw);
    expect(merged.userinfo).toBeNull();
    expect(merged.remaining).toBe(Math.round(579.45 * GB));
    expect(merged.expireText).toBe('长期有效');
    expect(mergeUserInfo(null, null)).toEqual({ userinfo: null, remaining: null, expireText: null, rawFields: [] });
  });
});

describe('traffic card display of the merged values', () => {
  const card = {
    id: 1,
    name: 'xxcloud',
    enabled: true,
    health: { state: 'ok' as const, error: null, lastOkAt: null },
    userinfo: { upload: null, download: null, total: TB, expire: null as number | null },
    userinfoRefreshedAt: null,
    expireText: '长期有效',
    remaining: Math.round(579.45 * GB),
    rawFields: ['remaining', 'expire'] as Array<'remaining' | 'expire'>,
  };

  it('shows header total with node remaining and 已用 = 总量 − 剩余', () => {
    const bar = trafficCard(card);
    expect(bar.empty).toBe(false);
    expect(bar.total).toBe(TB);
    expect(bar.remaining).toBe(Math.round(579.45 * GB));
    expect(bar.used).toBe(TB - Math.round(579.45 * GB));
    expect(bar.expireLabel).toBe('长期有效');
    expect(bar.rawFields).toEqual(['remaining', 'expire']);
    expect(bar.percent).toBeGreaterThan(0);
    expect(bar.percent).toBeLessThan(100);
  });

  it('keeps 已用 — when neither upload/download nor a total is known', () => {
    const bar = trafficCard({ ...card, userinfo: null });
    expect(bar.used).toBeNull();
    expect(bar.usedLabel).toBe('—');
    expect(bar.remaining).toBe(Math.round(579.45 * GB));
    expect(bar.expireLabel).toBe('长期有效');
  });

  it('keeps the old derived form when no remaining is reported', () => {
    const bar = trafficBar({ upload: 100, download: 400, total: 1000, expire: null });
    expect(bar).toMatchObject({ used: 500, remaining: 500, percent: 50 });
  });
});

describe('summarizeTraffic — dedicated sources, new figures', () => {
  it('sums the reported remaining and falls back to total − used', () => {
    const summary = summarizeTraffic([
      { userinfo: { upload: null, download: null, total: TB, expire: null }, remaining: Math.round(579.45 * GB) },
      { userinfo: { upload: 100, download: 400, total: 1000, expire: null }, remaining: 500 },
      { userinfo: null },
    ]);
    expect(summary.total).toBe(TB + 1000);
    expect(summary.remaining).toBe(Math.round(579.45 * GB) + 500);
    expect(summary.used).toBe(500);
    expect(summary.sourcesWithUserinfo).toBe(2);
    expect(summary.dedicatedCount).toBe(3);
  });

  it('carries an open-ended expiry wording only when no real date exists', () => {
    const open = summarizeTraffic([{ userinfo: { upload: null, download: null, total: 1, expire: null }, remaining: null, expireText: '长期有效' }]);
    expect(open.expire).toBeNull();
    expect(open.expireText).toBe('长期有效');
    const dated = summarizeTraffic([
      { userinfo: { upload: null, download: null, total: 1, expire: 1_900_000_000 }, remaining: null, expireText: null },
      { userinfo: { upload: null, download: null, total: 1, expire: null }, remaining: null, expireText: '长期有效' },
    ]);
    expect(dated.expire).toBe(1_900_000_000);
    expect(dated.expireText).toBeNull();
  });
});

describe('loadUserCenterData — end to end', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function seed(
    header: Partial<{
      userinfoUpload: number;
      userinfoDownload: number;
      userinfoTotal: number;
      userinfoExpire: number;
      userinfoRefreshedAt: Date;
    }>,
    cache: string,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-ucenter-raw-'));
    dirs.push(dir);
    const db: SubhubDb = openDb({ path: join(dir, 'subhub.sqlite') });
    const userId = db.insert(users).values({ name: 'alice', token: TOKEN, enabled: true }).returning({ id: users.id }).get()!.id;
    const sourceId = db
      .insert(sources)
      .values({ name: 'xxcloud', url: 'x', type: 'remote', ownerUserId: userId, cacheBlob: cache, ...header })
      .returning({ id: sources.id })
      .get()!.id;
    return { db, userId, sourceId };
  }

  it('header with only total + info nodes in the cache → remaining, 长期有效, 已用', () => {
    const { db } = seed({ userinfoTotal: TB, userinfoRefreshedAt: new Date(1_700_000_000_000) }, XXCLOUD_CACHE);
    const data = loadUserCenterData(db, TOKEN) as UserCenterData;
    const card = data.traffic.sources[0]!;
    expect(card.userinfo).toEqual({ upload: null, download: null, total: TB, expire: null });
    expect(card.remaining).toBe(Math.round(579.45 * GB));
    expect(card.expireText).toBe('长期有效');
    expect(card.rawFields).toEqual(['remaining', 'expire']);
    expect(card.userinfoRefreshedAt).toBe('2023-11-14T22:13:20.000Z');

    const view = trafficCard(card);
    expect(view.totalLabel).toBe('1.00 TB');
    expect(view.used).toBe(TB - Math.round(579.45 * GB));
    expect(view.usedLabel).not.toBe('—');
    expect(view.expireLabel).toBe('长期有效');

    const summary: UserCenterTrafficSummary = data.traffic.summary;
    expect(summary.remaining).toBe(Math.round(579.45 * GB));
    expect(summary.expireText).toBe('长期有效');
  });

  it('a complete header is never overridden by the nodes', () => {
    const { db } = seed(
      { userinfoUpload: 100, userinfoDownload: 200, userinfoTotal: 1000, userinfoExpire: 1_900_000_000 },
      XXCLOUD_CACHE,
    );
    const data = loadUserCenterData(db, TOKEN) as UserCenterData;
    const card = data.traffic.sources[0]!;
    expect(card.userinfo).toEqual({ upload: 100, download: 200, total: 1000, expire: 1_900_000_000 });
    expect(card.remaining).toBe(700);
    expect(card.expireText).toBeNull();
    expect(card.rawFields).toEqual([]);
  });

  it('leaves the export untouched: the info nodes stay filtered out', async () => {
    const { db, userId } = seed({ userinfoTotal: TB }, XXCLOUD_CACHE);
    // The built-in filter is applied by the profile path (a user with no
    // profile renders the raw node list — documented on the filter feature).
    const profileId = db.insert(profiles).values({ name: 'v2', iniText: '[custom]\ncustom_proxy_group=G`select`.*香港.*' }).returning({ id: profiles.id }).get()!.id;
    db.update(users).set({ profileId }).where(eq(users.id, userId)).run();
    resetExportRateLimiter();
    const event = {
      path: `/s/${TOKEN}/mihomo`,
      context: {},
      node: { req: { headers: { 'user-agent': 'subhub-test/1.0' } }, res: { statusCode: 200, setHeader() {} } },
    };
    const result = await handleSubscriptionExport(requestFromEvent(event as never), { db });
    expect(result.status).toBe(200);
    const document = parseYaml(result.body) as { proxies: Array<{ name: string }> };
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(['香港 01']);
  });

  it('keeps the cache raw (the nodes are only read, never filtered on write)', () => {
    const { db, sourceId } = seed({ userinfoTotal: TB }, XXCLOUD_CACHE);
    loadUserCenterData(db, TOKEN);
    expect(db.select({ cache: sources.cacheBlob }).from(sources).where(eq(sources.id, sourceId)).get()!.cache).toBe(
      XXCLOUD_CACHE,
    );
  });
});
