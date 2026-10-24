// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Built-in info/ads pseudo-node filter (`core/rules/info-nodes.ts`).
 *
 * An airport subscription usually ends with a few pseudo-nodes whose name is
 * just text (`剩余流量：579.45 GB`, `套餐到期：长期有效`). They are dropped on every
 * conversion with no configuration at all — a profile without
 * `[common] exclude_remarks` (the shipped `small`/`mini` profiles) used to let
 * them through. The profile's own `exclude_remarks` keeps its subconverter
 * semantics and is applied on top (union).
 *
 * Asserted here:
 * - unit behaviour of the keyword set (incl. the narrow-word guard);
 * - export-level: a profile WITHOUT `exclude_remarks` drops the info nodes for
 *   mihomo and shadowrocket while keeping every real node, and the group
 *   regexes (`.*`) only see the surviving nodes;
 * - profile WITH `exclude_remarks` still drops what only it matches (unchanged);
 * - `countCachedNodes` (user center) counts the same filtered set.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  filterInfoAndRemarkNodes,
  filterInfoNodes,
  INFO_NODE_KEYWORDS,
  isInfoNodeName,
  parseSubscription,
  type ProxyNode,
} from '../core';
import { compileExcludeRemarks } from '../core/rules';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { previewSubscription } from '../server/utils/admin-preview';
import { countCachedNodes } from '../server/utils/user-center';

const TOKEN = '1'.repeat(32);

type MihomoDocument = {
  proxies: Array<{ name: string }>;
  'proxy-groups': Array<{ name: string; proxies: string[] }>;
  rules: string[];
};

interface NodeSpec {
  name: string;
}

function nodeYaml(specs: NodeSpec[]): string {
  const lines = ['proxies:'];
  specs.forEach((spec, index) => {
    lines.push(
      `  - {name: ${JSON.stringify(spec.name)}, type: ss, server: node${index}.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}`,
    );
  });
  return `${lines.join('\n')}\n`;
}

function proxyNode(name: string): ProxyNode {
  return { type: 'ss', name, server: 'example.com', port: 8388, cipher: 'aes-128-gcm', password: 'fake' } as ProxyNode;
}

/** Real nodes that share the broad words the built-in set must NOT drop. */
const REAL_NAMES = ['🇭🇰 香港 01', '🇯🇵 日本 02', '🇺🇸 美国 03', '香港机场直连', '订阅分享频道 A'];

const INFO_NAMES = ['剩余流量：579.45 GB', '套餐到期：长期有效'];

describe('isInfoNodeName / filterInfoNodes', () => {
  it('matches the built-in keywords', () => {
    for (const name of [
      '剩余流量：579.45 GB',
      '套餐到期：长期有效',
      '节点即将到期',
      '重置流量请访问官网',
      '官网 https://example.com',
      '已过期',
      '二手倒卖',
      '请勿使用该节点',
    ]) {
      expect(isInfoNodeName(name)).toBe(true);
    }
    expect(INFO_NODE_KEYWORDS).toEqual([
      '剩余流量',
      '套餐到期',
      '到期',
      '重置',
      '官网',
      '过期',
      '二手倒卖',
      '请勿使用该节点',
    ]);
  });

  it('keeps broad words out of the built-in set', () => {
    // A real node may carry 机场/订阅/平台/产品/时间/分享 — those must survive.
    for (const name of REAL_NAMES) {
      expect(isInfoNodeName(name)).toBe(false);
    }
    for (const broad of ['机场', '订阅', '平台', '产品', '时间', '分享']) {
      expect(INFO_NODE_KEYWORDS).not.toContain(broad);
    }
    expect(isInfoNodeName('')).toBe(false);
    expect(isInfoNodeName(null)).toBe(false);
    expect(isInfoNodeName(undefined)).toBe(false);
  });

  it('filters a node list and keeps the order of the survivors', () => {
    const nodes = [
      proxyNode('剩余流量：579.45 GB'),
      proxyNode('🇭🇰 香港 01'),
      proxyNode('套餐到期：长期有效'),
      proxyNode('香港机场直连'),
    ];
    expect(filterInfoNodes(nodes).map((node) => node.name)).toEqual(['🇭🇰 香港 01', '香港机场直连']);
    // Nothing to drop -> the same array instance (no needless copy).
    expect(filterInfoNodes(nodes.slice(1, 2))).toHaveLength(1);
  });

  it('unions the built-in set with the profile predicate', () => {
    const nodes = [proxyNode('剩余流量：579.45 GB'), proxyNode('香港机场直连'), proxyNode('🇭🇰 香港 01')];
    const exclude = compileExcludeRemarks(
      // The profile still gets to drop 机场 — that is the union, not the built-in.
      // eslint-disable-next-line no-restricted-syntax
      { common: { exclude_remarks: '机场' }, custom: {}, rulesets: [], groups: [] },
    );
    expect(filterInfoAndRemarkNodes(nodes, exclude).map((node) => node.name)).toEqual(['🇭🇰 香港 01']);
    // No usable pattern: exactly the built-in set.
    expect(filterInfoAndRemarkNodes(nodes, null).map((node) => node.name)).toEqual([
      '香港机场直连',
      '🇭🇰 香港 01',
    ]);
  });
});

describe('export without exclude_remarks', () => {
  const dirs: string[] = [];
  let db: SubhubDb;
  let userId: number;

  /** 2 info pseudo-nodes + 5 real nodes, in source order. */
  const SOURCE = nodeYaml([
    { name: '剩余流量：579.45 GB' },
    { name: '🇭🇰 香港 01' },
    { name: '套餐到期：长期有效' },
    { name: '🇯🇵 日本 02' },
    { name: '🇺🇸 美国 03' },
    { name: '香港机场直连' },
    { name: '订阅分享频道 A' },
  ]);

  /** Shipped small/mini-style profile: groups + MATCH, no exclude_remarks. */
  const PLAIN_PROFILE_INI = [
    '[custom]',
    'custom_proxy_group=🚀 节点选择`select`.*',
    'custom_proxy_group=♻️ 自动选择`url-test`.*',
    'ruleset=🚀 节点选择,[]MATCH',
  ].join('\n');

  beforeEach(() => {
    resetExportRateLimiter();
    const dir = mkdtempSync(join(tmpdir(), 'subhub-info-filter-'));
    dirs.push(dir);
    db = openDb({ path: join(dir, 'subhub.sqlite') });

    userId = db
      .insert(users)
      .values({ name: 'info-user', token: TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    const profile = db
      .insert(profiles)
      .values({ name: 'small', iniText: PLAIN_PROFILE_INI })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

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

  async function exportWith(token: string, target: string) {
    return handleSubscriptionExport(
      { token, target, userAgent: 'clash-verge/v2.0', ip: '127.0.0.1' },
      { db, resolveProfileIni: async (profile) => profile.iniText },
    );
  }

  it('drops the info nodes from mihomo (proxies, groups, rules) and keeps the rest', async () => {
    const response = await exportWith(TOKEN, 'mihomo');
    expect(response.status).toBe(200);
    const document = parseYaml(response.body) as MihomoDocument;

    expect(document.proxies.map((proxy) => proxy.name)).toEqual(REAL_NAMES);
    for (const group of document['proxy-groups']) {
      // The `.*` regexes were expanded against the filtered names.
      expect(group.proxies).toEqual(REAL_NAMES);
    }
    expect(document.rules).toContain('MATCH,🚀 节点选择');
    expect(response.body).not.toContain('剩余流量');
    expect(response.body).not.toContain('套餐到期');
    // Real nodes with broad words survive.
    expect(response.body).toContain('香港机场直连');
  });

  it('drops the info nodes from shadowrocket and keeps the rest', async () => {
    const response = await exportWith(TOKEN, 'shadowrocket');
    expect(response.status).toBe(200);
    // Padded base64 of newline-joined share links.
    const links = Buffer.from(response.body, 'base64').toString('utf8').split('\n').filter(Boolean);
    expect(links).toHaveLength(REAL_NAMES.length);
    expect(parseSubscription(response.body).map((node) => node.name)).toEqual(REAL_NAMES);
    expect(response.body).not.toContain('剩余流量');
  });

  it('drops the info nodes from every other target too', async () => {
    resetExportRateLimiter();
    const uri = await exportWith(TOKEN, 'uri');
    expect(parseSubscription(uri.body).map((node) => node.name)).toEqual(REAL_NAMES);

    resetExportRateLimiter();
    const singbox = await exportWith(TOKEN, 'singbox');
    const tags = (JSON.parse(singbox.body) as { outbounds: Array<{ tag?: string }> }).outbounds
      .map((outbound) => outbound.tag)
      .filter((tag) => tag !== 'direct' && tag !== 'block');
    expect(tags).toEqual(REAL_NAMES);

    resetExportRateLimiter();
    const surge = await exportWith(TOKEN, 'surge');
    expect(surge.body).not.toContain('剩余流量');
    expect(surge.body).toContain('🚀 节点选择 = select,' + REAL_NAMES.join(','));

    resetExportRateLimiter();
    const loon = await exportWith(TOKEN, 'loon');
    expect(loon.body).not.toContain('剩余流量');
    expect(loon.body).toContain('🚀 节点选择 = select,' + REAL_NAMES.join(','));

    resetExportRateLimiter();
    const clash = await exportWith(TOKEN, 'clash');
    const clashDoc = parseYaml(clash.body) as MihomoDocument;
    expect(clashDoc.proxies.map((proxy) => proxy.name)).toEqual(REAL_NAMES);
  });

  it('applies to the admin preview', async () => {
    const preview = await previewSubscription(db, { userId, target: 'mihomo' });
    const document = parseYaml(preview.body) as MihomoDocument;
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(REAL_NAMES);
    expect(preview.body).not.toContain('剩余流量');
  });

  it('leaves a profile with exclude_remarks working as before (only it drops 机场)', async () => {
    const profile = db
      .insert(profiles)
      .values({
        name: 'all',
        iniText: '[common]\nexclude_remarks=机场\n[custom]\ncustom_proxy_group=🚀 节点选择`select`.*\nruleset=🚀 节点选择,[]MATCH',
      })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

    resetExportRateLimiter();
    const response = await exportWith(TOKEN, 'mihomo');
    const document = parseYaml(response.body) as MihomoDocument;
    // Union: built-in (the two info nodes) + the profile's `机场` (香港机场直连).
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(['🇭🇰 香港 01', '🇯🇵 日本 02', '🇺🇸 美国 03', '订阅分享频道 A']);
    expect(response.body).not.toContain('香港机场直连');
    expect(response.body).not.toContain('剩余流量');
  });

  it('counts the same filtered set in the user center', () => {
    // 2 info nodes + 5 real ones -> 5, matching what the export carries.
    expect(countCachedNodes(SOURCE)).toBe(REAL_NAMES.length);
    expect(countCachedNodes(nodeYaml([{ name: '剩余流量：1 GB' }, { name: '套餐到期：x' }]))).toBe(0);
    expect(countCachedNodes(nodeYaml([{ name: '香港机场直连' }]))).toBe(1);
    expect(countCachedNodes(null)).toBeNull();
    expect(countCachedNodes('   ')).toBeNull();
    // Unparseable payloads parse to zero nodes (unchanged behaviour).
    expect(countCachedNodes('not a subscription')).toBe(0);
  });
});
