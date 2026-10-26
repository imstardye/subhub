// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Empty proxy-group pruning (`core/rules/prune-groups.ts`) and its wiring into
 * the export path (`loadUserProfile` + `renderTargetBody`).
 *
 * mihomo/Clash reject a whole config over one `proxy group[N]: 'use' or
 * 'proxies' missing`, so a group whose regexes match none of the user's nodes
 * must never reach a rendered config.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  buildRules,
  BUILTIN_GROUP_MEMBERS,
  minGroupMembers,
  parseIni,
  pruneEmptyGroups,
  rulePolicy,
} from '../core/rules';
import { QUIC_BLOCK_RULE, type ClashProxyGroup, type ProxyNode } from '../core';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, users } from '../server/db/schema';
import {
  loadUserProfile,
  renderTargetBody,
  type ExportProfile,
} from '../server/utils/export-nodes';

function group(name: string, type: string, proxies: string[]): ClashProxyGroup {
  return { name, type, proxies };
}

function tree(proxyGroups: ClashProxyGroup[], rules: string[] = []) {
  return { proxyGroups, rules };
}

describe('pruneEmptyGroups', () => {
  /** The pruning an export does: members resolved against emitted node names. */
  const prune = (
    proxyGroups: ClashProxyGroup[],
    nodeNames: string[] = ['hk-01', 'hk-02'],
    rules: string[] = [],
  ) =>
    pruneEmptyGroups(tree(proxyGroups, rules), {
      nodeNames,
      // Every declared name is a group of the document; `hk-01` is not one.
      groupNames: proxyGroups.map((entry) => entry.name),
    });

  it('drops a single empty group and the references to it', () => {
    const pruned = prune([
      group('✅ 专线节点', 'select', []),
      group('🚀 节点选择', 'select', ['✅ 专线节点', 'DIRECT', 'hk-01']),
      group('🐟 漏网之鱼', 'select', ['DIRECT']),
    ]);

    expect(pruned.proxyGroups).toEqual([
      group('🚀 节点选择', 'select', ['DIRECT', 'hk-01']),
      group('🐟 漏网之鱼', 'select', ['DIRECT']),
    ]);
  });

  it('drops a relay whose leaf group is empty (two-level cascade)', () => {
    const pruned = prune([
      group('🔭 入口选择', 'select', ['DIRECT', 'hk-01']),
      group('✈️ 出口选择', 'select', []),
      group('🔗 链式代理', 'relay', ['[]🔭 入口选择', '[]✈️ 出口选择']),
      group('🚀 节点选择', 'select', ['🔗 链式代理', 'hk-02']),
    ]);

    // 出口选择 is dead, which leaves the relay with one hop (dead too). The
    // references to both are dropped from 节点选择.
    expect(pruned.proxyGroups.map((entry) => entry.name)).toEqual(['🔭 入口选择', '🚀 节点选择']);
    expect(pruned.proxyGroups[1].proxies).toEqual(['hk-02']);
  });

  it('keeps a relay with exactly 2 live members', () => {
    const pruned = prune([
      group('A', 'select', ['DIRECT', 'hk-01']),
      group('B', 'select', ['REJECT', 'hk-02']),
      group('🔗 链式代理', 'relay', ['[]A', '[]B']),
    ]);

    expect(pruned.proxyGroups.find((entry) => entry.name === '🔗 链式代理')?.proxies).toEqual([
      'A',
      'B',
    ]);
    expect(pruned.proxyGroups).toHaveLength(3);
  });

  it('drops a relay with only 1 live member', () => {
    const pruned = prune([
      group('A', 'select', ['DIRECT', 'hk-01']),
      group('B', 'select', []),
      group('🔗 链式代理', 'relay', ['[]A', '[]B']),
    ]);

    expect(pruned.proxyGroups.map((entry) => entry.name)).toEqual(['A']);
  });

  it('does not count a repeated hop as a second hop of the chain', () => {
    // `[]A` + `A` is still one hop, so this relay has a single group member and
    // dies.
    expect(
      prune([group('A', 'select', ['hk-01']), group('R', 'relay', ['[]A', 'A'])]).proxyGroups,
    ).toEqual([group('A', 'select', ['hk-01'])]);

    // A relay that repeats a name and also has a node keeps both, once.
    expect(
      prune([group('A', 'select', ['hk-01']), group('R', 'relay', ['[]A', 'A', 'hk-02'])]).proxyGroups,
    ).toEqual([group('A', 'select', ['hk-01']), group('R', 'relay', ['A', 'hk-02'])]);
  });

  it('resolves a relay hop written as a bare name', () => {
    // `resolveGroupMembers` emits a reference to an undefined group as a bare
    // name, so the plain spelling has to resolve against the document too.
    expect(
      prune([group('A', 'select', ['hk-01']), group('B', 'select', ['hk-02']), group('R', 'relay', ['A', 'B'])]).proxyGroups,
    ).toEqual([
      group('A', 'select', ['hk-01']),
      group('B', 'select', ['hk-02']),
      group('R', 'relay', ['A', 'B']),
    ]);
  });

  it('drops a chained group that lost the only hop it had', () => {
    const pruned = prune([
      group('🔭 入口选择', 'select', []),
      group('🚀 节点选择', 'select', ['[]🔭 入口选择']),
      group('🐟 漏网之鱼', 'select', ['[]🚀 节点选择', 'hk-01']),
    ]);

    // 入口选择 is empty, so 节点选择 (nothing but that reference) has nothing
    // left to route to; 漏网之鱼 keeps its node.
    expect(pruned.proxyGroups).toEqual([group('🐟 漏网之鱼', 'select', ['hk-01'])]);
  });

  it('treats an unresolvable [] reference as a dangling group, not a node', () => {
    const pruned = prune([
      group('A', 'select', ['DIRECT', 'hk-01']),
      group('🚀 节点选择', 'select', ['[]A']),
      group('🔗 链式代理', 'relay', ['[]A', '[]B']),
      group('B', 'select', ['[]missing-group']),
    ]);

    // `[]missing-group` is a group reference, not a node: it does not survive,
    // so B empties and the relay loses its second hop.
    expect(pruned.proxyGroups.map((entry) => entry.name)).toEqual(['A', '🚀 节点选择']);
  });

  it('drops a `[]<node>` reference naming a node the export did not emit', () => {
    expect(prune([group('A', 'select', ['[]hk-01', '[]dropped-node'])]).proxyGroups).toEqual([
      group('A', 'select', ['hk-01']),
    ]);
  });

  it('drops a pure group cycle A<->B and terminates', () => {
    const pruned = prune([
      group('A', 'select', ['[]B']),
      group('B', 'select', ['[]A']),
      group('🚀 节点选择', 'select', ['[]A', 'DIRECT']),
    ]);

    expect(pruned.proxyGroups).toEqual([group('🚀 节点选择', 'select', ['DIRECT'])]);
  });

  it('keeps a cycle that reaches a real member', () => {
    const pruned = prune([
      group('A', 'select', ['[]B']),
      group('B', 'select', ['[]A', 'DIRECT']),
    ]);

    expect(pruned.proxyGroups).toEqual([
      group('A', 'select', ['B']),
      group('B', 'select', ['A', 'DIRECT']),
    ]);
  });

  it('drops a relay that fell below 2 hops because a hop became empty', () => {
    // The classic cascade in one step: the relay references two groups, one of
    // them empties, so the relay has a single hop and dies as well.
    expect(
      prune([
        group('A', 'select', ['hk-01']),
        group('B', 'select', ['()']),
        group('R', 'relay', ['[]A', '[]B']),
        group('S', 'select', ['[]R', 'DIRECT']),
      ]).proxyGroups,
    ).toEqual([group('A', 'select', ['hk-01']), group('S', 'select', ['DIRECT'])]);
  });

  it('drops rules targeting a dropped group and keeps the rest in order', () => {
    const pruned = prune(
      [
        group('🚀 节点选择', 'select', ['DIRECT']),
        group('✈️ 出口选择', 'select', []),
      ],
      ['hk-01'],
      [
        'DOMAIN-SUFFIX,example.com,🚀 节点选择',
        'DOMAIN-SUFFIX,dead.example.com,✈️ 出口选择',
        'IP-CIDR,203.0.113.0/24,DIRECT,no-resolve',
        'DOMAIN-SUFFIX,node.example.com,hk-01',
        'MATCH,🚀 节点选择',
      ],
    );

    expect(pruned.rules).toEqual([
      'DOMAIN-SUFFIX,example.com,🚀 节点选择',
      'IP-CIDR,203.0.113.0/24,DIRECT,no-resolve',
      'DOMAIN-SUFFIX,node.example.com,hk-01',
      'MATCH,🚀 节点选择',
    ]);
  });

  it('drops a MATCH rule whose group died instead of leaving it dangling', () => {
    expect(prune([group('A', 'select', ['hk-01']), group('Dead', 'select', [])], undefined, ['MATCH,Dead']).rules).toEqual([]);
  });

  it('keeps an all-reference group when only one of its references is dead', () => {
    // The service-group shape of real INIs (e.g. 💬 Ai平台): every member is
    // another group. One dead reference (here a regex group that matched no
    // nodes) must drop out of the member list — it must not condemn the
    // whole group and the rules that point at it.
    const pruned = prune(
      [
        group('🌐 备用线路', 'select', []),
        group('🇺🇸 美国', 'select', ['hk-01']),
        group('🚀 节点选择', 'select', ['DIRECT']),
        group('💬 Ai平台', 'select', ['🇺🇸 美国', '🌐 备用线路', '🚀 节点选择']),
      ],
      ['hk-01'],
      ['RULE-SET,rs_1,💬 Ai平台', 'MATCH,🚀 节点选择'],
    );

    expect(pruned.proxyGroups).toEqual([
      group('🇺🇸 美国', 'select', ['hk-01']),
      group('🚀 节点选择', 'select', ['DIRECT']),
      group('💬 Ai平台', 'select', ['🇺🇸 美国', '🚀 节点选择']),
    ]);
    expect(pruned.rules).toEqual(['RULE-SET,rs_1,💬 Ai平台', 'MATCH,🚀 节点选择']);
  });

  it('keeps a group of only builtins', () => {
    const pruned = prune([
      group('🛑 广告拦截', 'select', ['REJECT', 'DIRECT']),
      group('REJECT-DROP-only', 'select', ['REJECT-DROP']),
    ]);

    expect(pruned.proxyGroups).toHaveLength(2);
    for (const name of pruned.proxyGroups.flatMap((entry) => entry.proxies)) {
      expect(BUILTIN_GROUP_MEMBERS.has(name)).toBe(true);
    }
  });

  it('prunes members that are neither groups, builtins nor emitted nodes', () => {
    expect(prune([group('A', 'select', ['gone-node', 'hk-01'])]).proxyGroups).toEqual([
      group('A', 'select', ['hk-01']),
    ]);
  });

  it('only trusts builtins when no node list is given', () => {
    // Node-less mode cannot prove a bare name is an emitted node, so a group
    // built only from bare names has nothing it can reach and dies.
    expect(pruneEmptyGroups(tree([group('A', 'select', ['hk-01', 'DIRECT'])])).proxyGroups).toEqual([
      group('A', 'select', ['DIRECT']),
    ]);
    expect(pruneEmptyGroups(tree([group('A', 'select', ['hk-01'])]))).toEqual(tree([]));
    // The `[]<group>` spelling is unambiguous, so a dangling group reference is
    // dropped and the group it empties goes with it.
    expect(
      pruneEmptyGroups(tree([group('A', 'select', ['[]gone-group']), group('B', 'select', ['DIRECT'])]))
        .proxyGroups,
    ).toEqual([group('B', 'select', ['DIRECT'])]);
  });

  it('survives a group whose name is also an emitted node name', () => {
    // `jp-01` is a *node* of this export; a group must not be kept alive by a
    // member that merely shares a node's name unless the group resolves it.
    expect(
      prune([group('S', 'select', ['hk-01'])], ['hk-01', 'jp-01']).proxyGroups,
    ).toEqual([group('S', 'select', ['hk-01'])]);

    // The last declaration of a repeated name is the live one; the shadowed
    // earlier declaration does not keep the name alive on its own.
    expect(
      prune([
        group('jp-01', 'url-test', ['hk-01']),
        group('D', 'select', ['hk-02']),
        group('jp-01', 'relay', ['[]选择', '[]missing']),
      ]).proxyGroups,
    ).toEqual([group('D', 'select', ['hk-02'])]);
  });

  it('keeps only the last declaration of a repeated group name', () => {
    // The output is a YAML list where the last definition wins, so only that
    // one is live — the earlier duplicate is dropped with its references.
    expect(
      prune([group('D', 'select', ['hk-01']), group('D', 'select', ['hk-02'])]).proxyGroups,
    ).toEqual([group('D', 'select', ['hk-02'])]);
  });

  it('returns the very same objects when nothing is empty', () => {
    const profile = tree(
      [group('🚀 节点选择', 'select', ['hk-01', 'DIRECT'])],
      ['MATCH,🚀 节点选择'],
    );

    const pruned = pruneEmptyGroups(profile, { nodeNames: ['hk-01'] });
    expect(pruned).toBe(profile);
    expect(pruned.proxyGroups[0]).toBe(profile.proxyGroups[0]);
    expect(pruned.rules).toBe(profile.rules);
  });

  it('is idempotent after a cascade', () => {
    const groups = [
      group('入口', 'select', ['hk-01']),
      group('出口', 'select', []),
      group('链式', 'relay', ['[]入口', '[]出口']),
      group('选择', 'select', ['[]链式', 'hk-02']),
    ];
    const once = prune(groups);
    expect(once.proxyGroups).toEqual([group('入口', 'select', ['hk-01']), group('选择', 'select', ['hk-02'])]);
    expect(pruneEmptyGroups(once, { nodeNames: ['hk-01', 'hk-02'] })).toBe(once);
    // Pruning the same input again is stable too.
    expect(prune(groups)).toEqual(once);
  });
});

describe('prune helpers', () => {
  it('requires two members for relay only', () => {
    expect(minGroupMembers('relay')).toBe(2);
    expect(minGroupMembers('RELAY')).toBe(2);
    expect(minGroupMembers('select')).toBe(1);
    expect(minGroupMembers('url-test')).toBe(1);
    expect(minGroupMembers(undefined)).toBe(1);
  });

  it('reads the policy of a rule line', () => {
    expect(rulePolicy('DOMAIN,a.example.com,G')).toBe('G');
    expect(rulePolicy('IP-CIDR,203.0.113.0/24,G,no-resolve')).toBe('G');
    expect(rulePolicy('MATCH,G')).toBe('G');
    expect(rulePolicy('MATCH')).toBeNull();
    expect(rulePolicy('# MATCH,G')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Export-level: today's live case, profile `all` with 16 nodes.
// ---------------------------------------------------------------------------

const LIVE_GROUPS = [
  '[custom]',
  // 出口选择: regex matches nothing for this user's nodes. 入口选择 is a
  // (surviving) reference to 节点选择, so it reaches a real outbound and stays
  // — a group whose members are *all* groups is otherwise not useful.
  'custom_proxy_group=✈️ 出口选择`select`((?i)relay-egress)',
  'custom_proxy_group=🔭 入口选择`select`[]🚀 节点选择',
  'custom_proxy_group=🔗 链式代理`relay`[]🔭 入口选择`[]✈️ 出口选择',
  'custom_proxy_group=🚀 节点选择`select`[]🔗 链式代理`[]🔭 入口选择`[]✅ 专线节点`[]DIRECT',
  'custom_proxy_group=✅ 专线节点`select`((?i)premium-line)',
  'custom_proxy_group=🖥️ 游戏节点`select`((?i)gaming-node)',
  'custom_proxy_group=🔯 故障转移`fallback`((?i)premium-line)`http://www.gstatic.com/generate_204`300,,50',
  'custom_proxy_group=🎤 自动负载`load-balance`((?i)gaming-node)`http://www.gstatic.com/generate_204`300,,50',
  'custom_proxy_group=🐟 漏网之鱼`select`[]🚀 节点选择`[]DIRECT',
  'custom_proxy_group=🛑 广告拦截`select`[]REJECT`[]DIRECT',
];

const LIVE_RULES = [
  'ruleset=🚀 节点选择,[]DOMAIN-SUFFIX,google.com',
  // Points at a group that the prune drops.
  'ruleset=✈️ 出口选择,[]DOMAIN-SUFFIX,relay.example.com',
  'ruleset=🖥️ 游戏节点,[]DOMAIN-SUFFIX,game.example.com',
  'ruleset=🛑 广告拦截,[]DOMAIN-SUFFIX,ads.example.com',
  'ruleset=🐟 漏网之鱼,[]FINAL',
];

const LIVE_INI = [...LIVE_GROUPS, ...LIVE_RULES].join('\n');

/**
 * The same profile with regexes that this user's nodes *do* match, so every
 * group is populated (the "nothing to prune" control case).
 */
const FULL_INI = [
  ...LIVE_GROUPS.map((line) =>
    line
      .replaceAll('((?i)premium-line)', '(香港)')
      .replaceAll('((?i)gaming-node)', '(日本)')
      .replaceAll('((?i)relay-egress)', '(香港)'),
  ),
  ...LIVE_RULES,
].join('\n');

const DEAD_GROUPS = ['✈️ 出口选择', '✅ 专线节点', '🖥️ 游戏节点', '🔯 故障转移', '🎤 自动负载'];

/** 16 nodes, none of which matches the premium/gaming/egress regexes. */
function liveNodes(): ProxyNode[] {
  return [
    ...Array.from({ length: 8 }, (_, index) => ({
      type: 'ss' as const,
      name: `🇭🇰 香港 ${String(index + 1).padStart(2, '0')}`,
      server: `hk${index + 1}.example.com`,
      port: 8388,
      cipher: 'aes-128-gcm',
      password: 'fake',
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      type: 'trojan' as const,
      name: `🇯🇵 日本 ${String(index + 1).padStart(2, '0')}`,
      server: `jp${index + 1}.example.com`,
      port: 443,
      password: 'fake',
    })),
  ] as ProxyNode[];
}

/** Every member and rule policy of a rendered document resolves. */
function assertResolves(document: { proxies: ProxyNode[]; 'proxy-groups': ClashProxyGroup[]; rules: string[] }) {
  const nodes = new Set(document.proxies.map((proxy) => proxy.name));
  const groups = new Map(document['proxy-groups'].map((entry) => [entry.name, entry]));

  for (const entry of groups.values()) {
    expect(entry.proxies.length).toBeGreaterThanOrEqual(minGroupMembers(entry.type));
    for (const member of entry.proxies) {
      const bare = member.startsWith('[]') ? member.slice(2) : member;
      expect(
        groups.has(bare) || nodes.has(bare) || BUILTIN_GROUP_MEMBERS.has(bare.toUpperCase()),
        `${entry.name} references unknown member ${member}`,
      ).toBe(true);
    }
  }

  for (const rule of document.rules) {
    const policy = rulePolicy(rule);
    if (policy === null) continue;
    expect(
      groups.has(policy) || nodes.has(policy) || BUILTIN_GROUP_MEMBERS.has(policy.toUpperCase()),
      `rule ${rule} references unknown policy ${policy}`,
    ).toBe(true);
  }
}

describe('empty-group pruning on the export path', () => {
  const dirs: string[] = [];
  let db: SubhubDb;
  let userId: number;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-prune-'));
    dirs.push(dir);
    db = openDb({ path: join(dir, 'subhub.sqlite') });

    const profileId = db
      .insert(profiles)
      .values({ name: 'all', iniText: LIVE_INI })
      .returning({ id: profiles.id })
      .get()!.id;
    userId = db
      .insert(users)
      .values({ name: 'live-user', token: 'e'.repeat(32), enabled: true, profileId })
      .returning({ id: users.id })
      .get()!.id;
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function render(target: 'mihomo' | 'clash' = 'mihomo'): Promise<string> {
    const nodes = liveNodes();
    const loaded = await loadUserProfile(db, userId, target, nodes, async () => LIVE_INI);
    expect(loaded).not.toBeNull();
    return renderTargetBody(target, loaded!.nodes, {}, loaded!.profile);
  }

  it('drops every empty group, the relay cascade and their references', async () => {
    const document = parseYaml(await render()) as {
      proxies: ProxyNode[];
      'proxy-groups': ClashProxyGroup[];
      rules: string[];
    };
    const names = document['proxy-groups'].map((entry) => entry.name);

    for (const dead of DEAD_GROUPS) expect(names).not.toContain(dead);
    // The cascade: 出口选择 is dead, so the relay loses its chain hop.
    expect(names).not.toContain('🔗 链式代理');
    expect(names).toEqual(['🔭 入口选择', '🚀 节点选择', '🐟 漏网之鱼', '🛑 广告拦截']);
    // The dead references are gone from 节点选择; the live ones stay in order.
    expect(document['proxy-groups'].find((entry) => entry.name === '🚀 节点选择')?.proxies).toEqual([
      '🔭 入口选择',
      'DIRECT',
    ]);
  });

  it('leaves no dangling reference and keeps MATCH last', async () => {
    const document = parseYaml(await render()) as {
      proxies: ProxyNode[];
      'proxy-groups': ClashProxyGroup[];
      rules: string[];
    };

    assertResolves(document);
    expect(document.rules[0]).toBe(QUIC_BLOCK_RULE);
    expect(document.rules.at(-1)).toBe('MATCH,🐟 漏网之鱼');
    // Rules of dropped groups are gone, the others keep their order.
    expect(document.rules).toEqual([
      QUIC_BLOCK_RULE,
      'DOMAIN-SUFFIX,google.com,🚀 节点选择',
      'DOMAIN-SUFFIX,ads.example.com,🛑 广告拦截',
      'MATCH,🐟 漏网之鱼',
    ]);
  });

  it('renders clash exactly like mihomo', async () => {
    expect(await render('clash')).toBe(await render('mihomo'));
  });

  it('reports only surviving groups on ExportProfile.groupNames', async () => {
    const loaded = await loadUserProfile(db, userId, 'mihomo', liveNodes(), async () => LIVE_INI);
    expect(loaded?.profile.groupNames).toEqual([
      '🔭 入口选择',
      '🚀 节点选择',
      '🐟 漏网之鱼',
      '🛑 广告拦截',
    ]);
  });

  it('treats a regex-matching node the client cannot load as absent', async () => {
    // Profile groups are expanded against the *emitted* node names, so a group
    // whose only matching node a producer drops (vless in a Surge export) is
    // empty and must be pruned — the same shape `exclude_remarks` can create
    // by filtering the node list before the regexes are expanded.
    const ini = [
      '[custom]',
      'custom_proxy_group=广告节点`select`((?i)ads)',
      'custom_proxy_group=🔗 链式代理`relay`[]广告节点`[]🚀 节点选择',
      'custom_proxy_group=🚀 节点选择`select`[]链式代理`[]DIRECT`((?i)hk)',
    ].join('\n');
    const surgeProfileId = db
      .insert(profiles)
      .values({ name: 'surge-ads', iniText: ini })
      .returning({ id: profiles.id })
      .get()!.id;
    const surgeUserId = db
      .insert(users)
      .values({ name: 'surge-user', token: 'f'.repeat(32), enabled: true, profileId: surgeProfileId })
      .returning({ id: users.id })
      .get()!.id;

    const nodes = [
      ...liveNodes().slice(0, 2),
      { type: 'vless', name: '🇺🇸 vless-ads 01', server: 'ads.example.com', port: 443, uuid: 'x', tls: true } as ProxyNode,
    ];
    const loaded = await loadUserProfile(db, surgeUserId, 'surge', nodes, async () => ini);
    expect(loaded).not.toBeNull();
    // Surge cannot emit the VLESS node, so 广告节点 (its only match) dies and
    // the relay that chained on it dies too.
    expect(loaded!.profile.proxyGroups.map((entry) => entry.name)).toEqual(['🚀 节点选择']);
    const body = renderTargetBody('surge', loaded!.nodes, {}, loaded!.profile);
    expect(body).not.toContain('广告节点');
    expect(body).not.toContain('链式代理');
    // The line producer prunes members against its own node lines (its
    // historical contract); here its `[Proxy]` section is nodes-only, so the
    // group keeps the built-in it declares.
    expect(body).toContain('🚀 节点选择 = select,DIRECT');
  });

  it('is a no-op on a profile where nothing is empty', () => {
    // Same pipeline as `loadUserProfile` minus the prune: when no group is
    // empty, the prune must not change a single byte of the rendered config.
    const nodeNames = liveNodes().map((node) => node.name);
    const built = buildRules(parseIni(FULL_INI), { nodeNames });
    const pruned = pruneEmptyGroups(
      { proxyGroups: built.proxyGroups, rules: built.rules },
      { nodeNames },
    );
    expect(pruned.proxyGroups).toBe(built.proxyGroups);
    expect(pruned.rules).toBe(built.rules);

    const profile = (tree: {
      ruleProviders: typeof built.ruleProviders;
      rules: string[];
      proxyGroups: ClashProxyGroup[];
    }): ExportProfile => ({
      ruleProviders: { ...tree.ruleProviders },
      rules: tree.rules,
      proxyGroups: tree.proxyGroups,
      groupNames: tree.proxyGroups.map((entry) => entry.name),
    });
    const rendered = renderTargetBody('mihomo', liveNodes(), {}, profile({ ...built, ...pruned }));
    expect(rendered).toBe(renderTargetBody('mihomo', liveNodes(), {}, profile(built)));
    // Every declared group is present, so this is not a vacuous comparison.
    const document = parseYaml(rendered) as { 'proxy-groups': ClashProxyGroup[] };
    expect(document['proxy-groups'].map((entry) => entry.name)).toEqual(
      built.proxyGroups.map((entry) => entry.name),
    );
  });
});

// ---------------------------------------------------------------------------
// Property check: whatever the input, a rendered profile never breaks a client.
// ---------------------------------------------------------------------------

describe('pruning invariants', () => {
  const NODES = ['hk-01', 'hk-02', 'jp-01', 'SG 1'];
  const NAMES = [...NODES, '入口', '出口', '链式', '选择', 'A', 'B', 'C', '🚀'];

  /** Deterministic PRNG so a failure is reproducible from its seed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  function randomProfile(seed: number) {
    const next = random(seed);
    const pick = <T,>(values: T[]): T => values[Math.floor(next() * values.length)];
    const proxyGroups: ClashProxyGroup[] = [];
    for (let index = 0; index < 1 + Math.floor(next() * 9); index += 1) {
      const proxies: string[] = [];
      for (let member = 0; member < Math.floor(next() * 4); member += 1) {
        const kind = Math.floor(next() * 4);
        if (kind === 0) proxies.push(pick(NODES));
        else if (kind === 1) proxies.push(`[]${pick(NAMES)}`);
        else if (kind === 2) proxies.push(pick(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']));
        else proxies.push(pick(NAMES));
      }
      proxyGroups.push({ name: pick(NAMES), type: pick(['select', 'url-test', 'fallback', 'relay', 'load-balance']), proxies });
    }
    const rules: string[] = [];
    for (let index = 0; index < Math.floor(next() * 4); index += 1) {
      const kind = Math.floor(next() * 4);
      if (kind === 0) rules.push(`DOMAIN,a${index}.com,${pick(NAMES)}`);
      else if (kind === 1) rules.push(`IP-CIDR,10.0.0.${index}/32,DIRECT,no-resolve`);
      else if (kind === 2) rules.push(`MATCH,${pick(NAMES)}`);
      else rules.push(`DOMAIN-SUFFIX,x${index}.com,${pick(NAMES)}`);
    }
    return { proxyGroups, rules };
  }

  it('never emits an empty group, a 1-hop relay or a dangling reference', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const profile = randomProfile(seed);
      const pruned = pruneEmptyGroups(profile, {
        nodeNames: NODES,
        groupNames: profile.proxyGroups.map((entry) => entry.name),
      });
      const groups = new Map(pruned.proxyGroups.map((entry) => [entry.name, entry]));
      // A repeated group name is only ever emitted once.
      expect(groups.size).toBe(pruned.proxyGroups.length);

      for (const entry of pruned.proxyGroups) {
        expect(
          entry.proxies.length,
          `seed ${seed}: ${entry.name} has ${entry.proxies.length} member(s)`,
        ).toBeGreaterThanOrEqual(minGroupMembers(entry.type));
        for (const member of entry.proxies) {
          expect(
            groups.has(member) || NODES.includes(member) || BUILTIN_GROUP_MEMBERS.has(member),
            `seed ${seed}: ${entry.name} references ${member}`,
          ).toBe(true);
        }
      }
      for (const rule of pruned.rules) {
        const policy = rulePolicy(rule);
        if (policy === null) continue;
        expect(
          groups.has(policy) || NODES.includes(policy) || BUILTIN_GROUP_MEMBERS.has(policy),
          `seed ${seed}: ${rule}`,
        ).toBe(true);
      }
      // Idempotent: a second pass has nothing left to do.
      expect(pruneEmptyGroups(pruned, { nodeNames: NODES })).toBe(pruned);
    }
  });
});
