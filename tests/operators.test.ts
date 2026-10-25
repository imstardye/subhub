// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node operator pipeline: pure core coverage (validate / apply), the /my
 * editor helpers, export integration through `/s/:token/:target`, and the
 * shared save/preview path.
 *
 * The invariants that matter:
 * - a stored pipeline is always runnable (save-time validation compiles
 *   every regex; garbage in the column reads as "no pipeline");
 * - operators run after the info filter, before group expansion — a
 *   rename is visible to the profile's group regexes;
 * - application is defensive: disabled/unknown/failing operators are
 *   skipped, and emitted names are always unique;
 * - the dry-run attributes drops and renames to the right nodes and
 *   reports which groups survive.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  applyOperators,
  ensureUniqueNodeNames,
  parseOperatorsJson,
  validateOperators,
  type NodeOperator,
  type ProxyNode,
} from '../core';
import {
  defaultOperator,
  operatorSummary,
} from '../core/utils/operators-ui';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { previewUserOperators, saveUserOperators } from '../server/utils/operators';

function node(name: string, extra: Partial<ProxyNode> = {}): ProxyNode {
  return { type: 'ss', name, server: 'example.com', port: 8388, ...extra } as ProxyNode;
}

const names = (nodes: ProxyNode[]): string[] => nodes.map((entry) => entry.name);

describe('operators: validation', () => {
  it('accepts and normalizes a full pipeline', () => {
    const { operators, errors } = validateOperators([
      { type: 'regex-filter', pattern: '游戏', mode: 'drop' },
      { type: 'type-filter', types: ['SS', 'ss', 'VLESS'], mode: 'exclude' },
      { type: 'regex-rename', rules: [{ pattern: '^机场-', replacement: '' }] },
      { type: 'sort', mode: 'regex', patterns: ['香港', '日本'] },
      { type: 'set-property', udp: true },
      { type: 'handle-duplicate', by: 'server', mode: 'drop' },
    ]);
    expect(errors).toEqual([]);
    expect(operators).toHaveLength(6);
    expect(operators[1]).toMatchObject({ types: ['ss', 'vless'] });
  });

  it('rejects bad regexes, unknown types and empty args with the operator index', () => {
    const { operators, errors } = validateOperators([
      { type: 'regex-filter', pattern: '(', mode: 'drop' },
      { type: 'script', code: 'x' },
      { type: 'type-filter', types: [], mode: 'exclude' },
      { type: 'set-property' },
      { type: 'sort', mode: 'regex', patterns: [] },
    ]);
    expect(operators).toEqual([]);
    expect(errors.map((error) => error.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('caps the pipeline at 20 operators', () => {
    const many = Array.from({ length: 21 }, () => ({ type: 'sort', mode: 'name-asc' }));
    const { errors } = validateOperators(many);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reads garbage in the stored column as no pipeline', () => {
    expect(parseOperatorsJson(null)).toEqual([]);
    expect(parseOperatorsJson('not json')).toEqual([]);
    expect(parseOperatorsJson('[{"type":"nope"}]')).toEqual([]);
    expect(parseOperatorsJson('[{"type":"sort","mode":"name-asc"}]')).toEqual([
      { type: 'sort', mode: 'name-asc' },
    ]);
  });
});

describe('operators: application', () => {
  const base = [
    node('🇭🇰 香港 01'),
    node('🇯🇵 日本 02'),
    node('🇺🇸 美国 游戏 03'),
    node('🇸🇬 新加坡 04', { type: 'vless' }),
  ];

  it('regex-filter keeps and drops by name, honouring ignoreCase', () => {
    expect(names(applyOperators(base, [{ type: 'regex-filter', pattern: '游戏', mode: 'drop' }]))).toEqual([
      '🇭🇰 香港 01',
      '🇯🇵 日本 02',
      '🇸🇬 新加坡 04',
    ]);
    expect(
      names(applyOperators(base, [{ type: 'regex-filter', pattern: '香港|日本', mode: 'keep' }])),
    ).toEqual(['🇭🇰 香港 01', '🇯🇵 日本 02']);
    expect(
      names(applyOperators(base, [{ type: 'regex-filter', pattern: 'GAME', mode: 'drop' }])),
    ).toHaveLength(4);
  });

  it('type-filter includes and excludes by protocol', () => {
    expect(names(applyOperators(base, [{ type: 'type-filter', types: ['vless'], mode: 'include' }]))).toEqual([
      '🇸🇬 新加坡 04',
    ]);
    expect(names(applyOperators(base, [{ type: 'type-filter', types: ['ss'], mode: 'exclude' }]))).toEqual([
      '🇸🇬 新加坡 04',
    ]);
  });

  it('regex-rename applies rules in order with $1 groups, and never blanks a name', () => {
    const renamed = applyOperators([node('机场-香港-01')], [
      {
        type: 'regex-rename',
        rules: [
          { pattern: '^机场-', replacement: '' },
          { pattern: '^(.*)-(\\d+)$', replacement: '$1 #$2' },
        ],
      },
    ]);
    expect(names(renamed)).toEqual(['香港 #01']);
    const blanked = applyOperators([node('X')], [
      { type: 'regex-rename', rules: [{ pattern: '^X$', replacement: '' }] },
    ]);
    expect(names(blanked)).toEqual(['X']);
  });

  it('sorts by name and by regex priority (stable, unmatched last)', () => {
    expect(names(applyOperators(base, [{ type: 'sort', mode: 'name-asc' }]))).toEqual([
      '🇭🇰 香港 01',
      '🇯🇵 日本 02',
      '🇸🇬 新加坡 04',
      '🇺🇸 美国 游戏 03',
    ]);
    expect(
      names(applyOperators(base, [{ type: 'sort', mode: 'regex', patterns: ['新加坡', '香港'] }])),
    ).toEqual(['🇸🇬 新加坡 04', '🇭🇰 香港 01', '🇯🇵 日本 02', '🇺🇸 美国 游戏 03']);
  });

  it('set-property writes udp/tfo/skip-cert-verify onto copies', () => {
    const [first] = applyOperators([node('A')], [{ type: 'set-property', udp: true, skipCertVerify: false }]);
    expect(first?.udp).toBe(true);
    expect(first?.['skip-cert-verify']).toBe(false);
    expect(first?.tfo).toBeUndefined();
    expect(base[0]?.udp).toBeUndefined();
  });

  it('handle-duplicate drops by server identity and renames by name', () => {
    const dupServers = [
      node('源A 节点', { server: 's1.example.com', port: 443 }),
      node('源B 节点', { server: 's1.example.com', port: 443 }),
      node('源C 节点', { server: 's2.example.com', port: 443 }),
    ];
    expect(
      names(applyOperators(dupServers, [{ type: 'handle-duplicate', by: 'server', mode: 'drop' }])),
    ).toEqual(['源A 节点', '源C 节点']);
    const dupNames = [node('同名'), node('同名'), node('同名')];
    expect(
      names(applyOperators(dupNames, [{ type: 'handle-duplicate', by: 'name', mode: 'rename' }])),
    ).toEqual(['同名', '同名 #2', '同名 #3']);
  });

  it('skips disabled operators and guarantees unique names at the end', () => {
    const out = applyOperators([node('A'), node('A'), node('A #2')], [
      { type: 'regex-filter', pattern: 'A', mode: 'drop', enabled: false },
    ]);
    expect(names(out)).toEqual(['A', 'A #2', 'A #2 #2']);
    expect(names(ensureUniqueNodeNames([node('X'), node('X')]))).toEqual(['X', 'X #2']);
  });
});

describe('operators: editor helpers', () => {
  it('builds editable defaults and one-line summaries', () => {
    expect(defaultOperator('regex-rename')).toEqual({
      type: 'regex-rename',
      rules: [{ pattern: '', replacement: '' }],
    });
    expect(operatorSummary({ type: 'regex-filter', pattern: '游戏', mode: 'drop' })).toContain('剔除');
    expect(operatorSummary({ type: 'handle-duplicate', by: 'server', mode: 'drop' })).toContain('服务器');
    expect(operatorSummary({ type: 'set-property', udp: true })).toContain('udp 开');
  });
});

const TOKEN = 'f'.repeat(32);
const PLAIN_TOKEN = 'a'.repeat(32);
const GROUP_ALL = '🚀 节点选择';
const GROUP_HK = '🇭🇰 港区';

const PROFILE_INI = [
  '[custom]',
  `custom_proxy_group=${GROUP_ALL}\`select\`.*`,
  `custom_proxy_group=${GROUP_HK}\`select\`HK`,
  `ruleset=${GROUP_ALL},[]MATCH`,
].join('\n');

function sourceYaml(entries: Array<{ name: string; server: string }>): string {
  const lines = ['proxies:'];
  for (const entry of entries) {
    lines.push(
      `  - {name: ${JSON.stringify(entry.name)}, type: ss, server: ${entry.server}, port: 8388, cipher: aes-128-gcm, password: "fake"}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

describe('operators: export integration', () => {
  const dirs: string[] = [];
  let db: SubhubDb;
  let userId: number;
  let plainId: number;

  beforeEach(() => {
    resetExportRateLimiter();
    const dir = mkdtempSync(join(tmpdir(), 'subhub-ops-'));
    dirs.push(dir);
    db = openDb({ path: join(dir, 'subhub.sqlite') });
    userId = db
      .insert(users)
      .values({ name: 'ops-user', token: TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    plainId = db
      .insert(users)
      .values({ name: 'plain-user', token: PLAIN_TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    const profile = db
      .insert(profiles)
      .values({ name: 'main', iniText: PROFILE_INI })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();
    // Two sources carrying the SAME node (cross-source duplicate) + friends.
    db.insert(sources)
      .values({
        name: 'src-a',
        url: encrypt('placeholder-a'),
        type: 'local',
        cacheBlob: sourceYaml([
          { name: '🇭🇰 香港 01', server: 'hk.example.com' },
          { name: '🇯🇵 日本 02', server: 'jp.example.com' },
        ]),
        ownerUserId: null,
        accessMode: 'all',
      })
      .run();
    db.insert(sources)
      .values({
        name: 'src-b',
        url: encrypt('placeholder-b'),
        type: 'local',
        cacheBlob: sourceYaml([{ name: '🇭🇰 香港 01', server: 'hk.example.com' }]),
        ownerUserId: userId,
        accessMode: 'all',
      })
      .run();
  });

  afterEach(() => {
    resetExportRateLimiter();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function exportWith(token: string, target: string) {
    resetExportRateLimiter();
    return handleSubscriptionExport(
      { token, target, userAgent: 'clash-verge/v2.0', ip: '127.0.0.1' },
      { db, resolveProfileIni: async (row) => row.iniText },
    );
  }

  function setOperators(id: number, operators: NodeOperator[]) {
    db.update(users)
      .set({ operators: JSON.stringify(operators) })
      .where(eq(users.id, id))
      .run();
  }

  it('baseline: no pipeline, the HK group starves (its regex matches nothing)', async () => {
    const response = await exportWith(TOKEN, 'mihomo');
    const document = parseYaml(response.body) as {
      proxies: Array<{ name: string }>;
      'proxy-groups': Array<{ name: string }>;
    };
    expect(document.proxies).toHaveLength(3); // the duplicate is still there
    expect(document['proxy-groups'].map((group) => group.name)).toEqual([GROUP_ALL]);
  });

  it('a rename feeds the group regexes: the HK group survives with the renamed node', async () => {
    setOperators(userId, [
      { type: 'regex-rename', rules: [{ pattern: '香港', replacement: 'HK香港' }] },
    ]);
    const response = await exportWith(TOKEN, 'mihomo');
    const document = parseYaml(response.body) as {
      proxies: Array<{ name: string }>;
      'proxy-groups': Array<{ name: string; proxies: string[] }>;
    };
    expect(document.proxies.map((proxy) => proxy.name)).toContain('🇭🇰 HK香港 01');
    const hk = document['proxy-groups'].find((group) => group.name === GROUP_HK);
    expect(hk?.proxies).toEqual(['🇭🇰 HK香港 01', '🇭🇰 HK香港 01 #2']);
  });

  it('filter + dedupe compose: the duplicate and the filtered node both go', async () => {
    setOperators(userId, [
      { type: 'regex-filter', pattern: '日本', mode: 'drop' },
      { type: 'handle-duplicate', by: 'server', mode: 'drop' },
    ]);
    const response = await exportWith(TOKEN, 'mihomo');
    const document = parseYaml(response.body) as { proxies: Array<{ name: string }> };
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(['🇭🇰 香港 01']);
  });

  it('applies to a profile-less user too (nodes-only fallback path)', async () => {
    setOperators(plainId, [
      { type: 'regex-rename', rules: [{ pattern: '香港', replacement: 'HK香港' }] },
    ]);
    const response = await exportWith(PLAIN_TOKEN, 'mihomo');
    expect(response.body).toContain('HK香港');
    expect(response.body).not.toContain('🇭🇰 香港 01');
  });

  it('the dry-run attributes drops/renames and reports surviving groups', async () => {
    const preview = await previewUserOperators(db, userId, [
      { type: 'regex-rename', rules: [{ pattern: '香港', replacement: 'HK香港' }] },
      { type: 'regex-filter', pattern: '日本', mode: 'drop' },
    ]);
    // Merged order is dedicated-first: src-b's copy of 香港 01 leads.
    expect(preview.beforeNames).toEqual(['🇭🇰 香港 01', '🇭🇰 香港 01', '🇯🇵 日本 02']);
    expect(preview.afterNames).toEqual(['🇭🇰 HK香港 01', '🇭🇰 HK香港 01 #2']);
    expect(preview.droppedNames).toEqual(['🇯🇵 日本 02']);
    expect(preview.renamed).toEqual([
      { from: '🇭🇰 香港 01', to: '🇭🇰 HK香港 01' },
      { from: '🇭🇰 香港 01', to: '🇭🇰 HK香港 01 #2' },
    ]);
    expect(preview.groups).toEqual([GROUP_ALL, GROUP_HK]);
  });

  it('the save path validates, stores and clears', async () => {
    expect(() =>
      saveUserOperators(db, userId, [{ type: 'regex-filter', pattern: '(', mode: 'drop' }]),
    ).toThrow(/第 1 个算子/);
    const saved = saveUserOperators(db, userId, [{ type: 'sort', mode: 'name-desc' }]);
    expect(saved).toEqual({ operators: [{ type: 'sort', mode: 'name-desc' }], count: 1 });
    const cleared = saveUserOperators(db, userId, []);
    expect(cleared.count).toBe(0);
    expect(db.select().from(users).where(eq(users.id, userId)).get()?.operators).toBeNull();
  });
});
