// SPDX-License-Identifier: AGPL-3.0-only
/**
 * subconverter `[common] exclude_remarks` (info/ads pseudo-node filtering).
 *
 * Unit coverage for the pure matcher (`core/rules/exclude-remarks.ts`) plus
 * export-level checks through `/s/:token/:target`: the real-world `all` profile
 * pattern drops `剩余流量：…` / `套餐到期：…` from `proxies:`, from every
 * `.*` group and from the non-YAML targets, while a user without the profile
 * keeps all nodes. The INI is fetched exactly once per export.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  decodeBase64,
  excludeRemarkNodes,
  parseIni,
  parseSubscription,
  type ProxyNode,
} from '../core';
import { compileExcludeRemarks, type RemarkExcluder } from '../core/rules';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { previewSubscription } from '../server/utils/admin-preview';

/** The pattern the real-world `all` profile ships (tests/fixtures/xr_all_config_v2.ini). */
const REAL_PATTERN =
  '(到期|剩余流量|时间|官网|产品|平台|套餐到期|二手倒卖|重置|剩余|过期|机场|订阅|分享|请勿使用该节点)';

const TOKEN = 'e'.repeat(32);

type MihomoDocument = {
  proxies: Array<{ name: string }>;
  'proxy-groups': Array<{ name: string; proxies: string[] }>;
  rules: string[];
};

interface NodeSpec {
  name: string;
  server?: string;
}

function nodeYaml(specs: NodeSpec[]): string {
  const lines = ['proxies:'];
  specs.forEach((spec, index) => {
    lines.push(
      `  - {name: ${JSON.stringify(spec.name)}, type: ss, server: ${spec.server ?? `node${index}.example.com`}, port: 8388, cipher: aes-128-gcm, password: "fake"}`,
    );
  });
  return `${lines.join('\n')}\n`;
}

function proxyNode(name: string): ProxyNode {
  return {
    type: 'ss',
    name,
    server: 'example.com',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'fake',
  } as ProxyNode;
}

function matchAll(excluder: RemarkExcluder | null, names: string[]): string[] {
  if (!excluder) return [];
  return names.filter((name) => excluder(name));
}

describe('compileExcludeRemarks', () => {
  const names = [
    '剩余流量：4.95 TB',
    '套餐到期：长期有效',
    '官网 https://example.com',
    '🇭🇰 香港 01',
    '🇯🇵 日本 02',
  ];

  it('drops the names an info-node pattern matches and keeps the rest', () => {
    const excluder = compileExcludeRemarks(parseIni('[common]\nexclude_remarks=(到期|剩余流量|官网)'));
    expect(matchAll(excluder, names)).toEqual([
      '剩余流量：4.95 TB',
      '套餐到期：长期有效',
      '官网 https://example.com',
    ]);
    expect(excluder?.('🇭🇰 香港 01')).toBe(false);
  });

  it('matches the real-world `all` profile pattern', () => {
    const excluder = compileExcludeRemarks(
      parseIni(`[common]\nexclude_remarks=${REAL_PATTERN}\n[custom]\ncustom_proxy_group=g\`select\`.*`),
    );
    expect(matchAll(excluder, names)).toEqual([
      '剩余流量：4.95 TB',
      '套餐到期：长期有效',
      '官网 https://example.com',
    ]);
  });

  it('is a case-sensitive substring search, like subconverter (no flags)', () => {
    const excluder = compileExcludeRemarks(parseIni('[common]\nexclude_remarks=(官网|hk)'));
    expect(excluder?.('🇭🇰 HK-01')).toBe(false);
    expect(excluder?.('the best hk-01')).toBe(true);
    // "^" keeps its regex meaning: anchored patterns only match at the start.
    const anchored = compileExcludeRemarks(parseIni('[common]\nexclude_remarks=^剩余'));
    expect(anchored?.('剩余流量：1 GB')).toBe(true);
    expect(anchored?.('我的剩余流量：1 GB')).toBe(false);
  });

  it('returns null for an invalid regex instead of throwing', () => {
    const ini = parseIni('[common]\nexclude_remarks=(到期');
    expect(() => compileExcludeRemarks(ini)).not.toThrow();
    expect(compileExcludeRemarks(ini)).toBeNull();
  });

  it('is a no-op for a missing, empty or whitespace-only pattern', () => {
    expect(compileExcludeRemarks(null)).toBeNull();
    expect(compileExcludeRemarks(parseIni('[custom]\ncustom_proxy_group=g`select`.*'))).toBeNull();
    expect(compileExcludeRemarks(parseIni('[common]\nexclude_remarks='))).toBeNull();
    expect(compileExcludeRemarks(parseIni('[common]\nexclude_remarks=   '))).toBeNull();
    // The key only counts in [common].
    expect(compileExcludeRemarks(parseIni('[custom]\nexclude_remarks=官网'))).toBeNull();
  });

  it('keeps nodes with an empty or missing name', () => {
    const excluder = compileExcludeRemarks(parseIni('[common]\nexclude_remarks=.*'))!;
    expect(excluder('')).toBe(false);
    expect(excluder(null)).toBe(false);
    expect(excluder(undefined)).toBe(false);
    expect(excluder('🇭🇰 香港')).toBe(true);
  });
});

describe('excludeRemarkNodes', () => {
  const nodes = [proxyNode('剩余流量：4.95 TB'), proxyNode('🇭🇰 香港 01'), proxyNode('套餐到期：长期有效')];

  it('filters the node list with the INI pattern', () => {
    const filtered = excludeRemarkNodes(nodes, parseIni(`[common]\nexclude_remarks=${REAL_PATTERN}`));
    expect(filtered.map((node) => node.name)).toEqual(['🇭🇰 香港 01']);
  });

  it('returns the same nodes when the pattern is unusable', () => {
    expect(excludeRemarkNodes(nodes, parseIni('[common]\nexclude_remarks=('))).toEqual(nodes);
    expect(excludeRemarkNodes(nodes, null)).toEqual(nodes);
  });
});

describe('GET /s/:token exclude_remarks', () => {
  const dirs: string[] = [];
  let db: SubhubDb;
  let userId: number;
  const PLAIN_TOKEN = 'f'.repeat(32);

  /** 2 info pseudo-nodes + 4 real nodes, in source order. */
  const SOURCE = nodeYaml([
    { name: '剩余流量：4.95 TB' },
    { name: '🇭🇰 香港 01' },
    { name: '套餐到期：长期有效' },
    { name: '🇯🇵 日本 02' },
    { name: '🇺🇸 美国 03' },
    { name: '🇸🇬 新加坡 04' },
  ]);
  const ALL_NAMES = ['🇭🇰 香港 01', '🇯🇵 日本 02', '🇺🇸 美国 03', '🇸🇬 新加坡 04'];

  const PROFILE_INI = [
    '[common]',
    `exclude_remarks=${REAL_PATTERN}`,
    '',
    '[custom]',
    'custom_proxy_group=🚀 节点选择`select`.*',
    'custom_proxy_group=remaining`select`.*',
    'ruleset=🚀 节点选择,[]MATCH',
  ].join('\n');

  beforeEach(() => {
    resetExportRateLimiter();
    const dir = mkdtempSync(join(tmpdir(), 'subhub-exclude-'));
    dirs.push(dir);
    db = openDb({ path: join(dir, 'subhub.sqlite') });

    userId = db
      .insert(users)
      .values({ name: 'exclude-user', token: TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    // Same nodes, no profile: the no-behaviour-change control.
    db
      .insert(users)
      .values({ name: 'plain-user', token: PLAIN_TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!.id;

    const profile = db
      .insert(profiles)
      .values({ name: 'all', iniText: PROFILE_INI })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

    // One public source: every user sees the same six nodes.
    db.insert(sources)
      .values({
        name: 'public-source',
        url: encrypt('placeholder-source-not-a-real-subscription'),
        type: 'local',
        cacheBlob: SOURCE,
        ownerUserId: null,
        accessMode: 'all',
      })
      .run();
  });

  afterEach(() => {
    resetExportRateLimiter();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Export with a resolver that counts INI fetches (single-pass assertion). */
  async function exportWith(token: string, target: string) {
    const calls: number[] = [];
    const response = await handleSubscriptionExport(
      { token, target, userAgent: 'clash-verge/v2.0', ip: '127.0.0.1' },
      {
        db,
        resolveProfileIni: async (profile) => {
          calls.push(1);
          return profile.iniText;
        },
      },
    );
    return { response, iniFetches: calls.length };
  }

  it('drops the info nodes from proxies, groups and target names (mihomo)', async () => {
    const { response, iniFetches } = await exportWith(TOKEN, 'mihomo');
    expect(response.status).toBe(200);
    const document = parseYaml(response.body) as MihomoDocument;

    expect(document.proxies.map((proxy) => proxy.name)).toEqual(ALL_NAMES);
    expect(document.proxies).toHaveLength(4); // 6 - 2 excluded
    for (const group of document['proxy-groups']) {
      expect(group.proxies).toEqual(ALL_NAMES);
    }
    expect(response.body).not.toContain('剩余流量');
    expect(response.body).not.toContain('套餐到期');
    // The INI is fetched once per export even though it feeds the filter and
    // the groups.
    expect(iniFetches).toBe(1);
  });

  it('applies to every target, not just mihomo', async () => {
    resetExportRateLimiter();
    const uri = await exportWith(TOKEN, 'uri');
    expect(uri.response.status).toBe(200);
    const links = Buffer.from(uri.response.body, 'base64').toString('utf8').split('\n');
    expect(links).toHaveLength(4);
    expect(links.join('\n')).not.toContain('剩余流量');
    expect(parseSubscription(uri.response.body).map((node) => node.name)).toEqual(ALL_NAMES);

    resetExportRateLimiter();
    const singbox = await exportWith(TOKEN, 'singbox');
    expect(singbox.response.status).toBe(200);
    const outbounds = (JSON.parse(singbox.response.body) as { outbounds: Array<{ tag?: string }> }).outbounds;
    const tags = outbounds.map((outbound) => outbound.tag).filter((tag) => tag !== 'direct' && tag !== 'block');
    expect(tags).toEqual(ALL_NAMES);
    expect(singbox.response.body).not.toContain('剩余流量');

    resetExportRateLimiter();
    const shadowrocket = await exportWith(TOKEN, 'shadowrocket');
    // The shadowrocket body is padded base64 of the newline-joined links.
    const srBody = Buffer.from(shadowrocket.response.body, 'base64').toString('utf8');
    const srLinks = srBody.split('\n').filter(Boolean);
    expect(srLinks).toHaveLength(4);
    expect(srLinks.map((link) => decodeURIComponent(link.split('#')[1] ?? ''))).toEqual(ALL_NAMES);

    resetExportRateLimiter();
    const surge = await exportWith(TOKEN, 'surge');
    expect(surge.response.body).not.toContain('剩余流量');
    expect(surge.response.body).not.toContain('套餐到期');
    expect(surge.response.body).toContain('🚀 节点选择 = select,' + ALL_NAMES.join(','));

    resetExportRateLimiter();
    const loon = await exportWith(TOKEN, 'loon');
    expect(loon.response.body).not.toContain('剩余流量');
    expect(loon.response.body).toContain('🚀 节点选择 = select,' + ALL_NAMES.join(','));
  });

  it('keeps all nodes for a user without the profile', async () => {
    const { response } = await exportWith(PLAIN_TOKEN, 'mihomo');
    expect(response.status).toBe(200);
    const document = parseYaml(response.body) as { proxies: Array<{ name: string }> };
    expect(document.proxies.map((proxy) => proxy.name)).toEqual([
      '剩余流量：4.95 TB',
      '🇭🇰 香港 01',
      '套餐到期：长期有效',
      '🇯🇵 日本 02',
      '🇺🇸 美国 03',
      '🇸🇬 新加坡 04',
    ]);
  });

  it('keeps all nodes when the profile has no (or an invalid) exclude_remarks', async () => {
    for (const ini of [
      '[custom]\ncustom_proxy_group=🚀 节点选择`select`.*\nruleset=🚀 节点选择,[]MATCH',
      '[common]\nexclude_remarks=(到期\n[custom]\ncustom_proxy_group=🚀 节点选择`select`.*\nruleset=🚀 节点选择,[]MATCH',
      '[common]\nexclude_remarks=\n[custom]\ncustom_proxy_group=🚀 节点选择`select`.*\nruleset=🚀 节点选择,[]MATCH',
    ]) {
      const profile = db
        .insert(profiles)
        .values({ name: 'no-exclude', iniText: ini })
        .returning({ id: profiles.id })
        .get()!;
      db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

      resetExportRateLimiter();
      const { response } = await exportWith(TOKEN, 'mihomo');
      expect(response.status).toBe(200);
      const document = parseYaml(response.body) as MihomoDocument;
      expect(document.proxies).toHaveLength(6);
      expect(document['proxy-groups'][0]!.proxies).toHaveLength(6);
    }
  });

  it('applies the same filter to the admin preview', async () => {
    const preview = await previewSubscription(db, { userId, target: 'mihomo' });
    const document = parseYaml(preview.body) as MihomoDocument;
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(ALL_NAMES);
    expect(preview.body).not.toContain('剩余流量');
  });

  it('matches the real-world profile fixture pattern', async () => {
    // The shipped `all` profile (tests/fixtures/xr_all_config_v2.ini) carries the
    // same exclude_remarks value; assert it directly so a fixture refresh that
    // drops the line fails here.
    const fixture = parseIni(
      readFileSync(fileURLToPath(new URL('./fixtures/xr_all_config_v2.ini', import.meta.url)), 'utf8'),
    );
    expect(fixture.common.exclude_remarks).toBe(REAL_PATTERN);
    const excluder = compileExcludeRemarks(fixture)!;
    expect(excluder('剩余流量：4.95 TB')).toBe(true);
    expect(excluder('套餐到期：长期有效')).toBe(true);
    expect(excluder('🇭🇰 香港 01')).toBe(false);
  });
});
