// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProxyGroupEntry } from '../core/types';
import {
  buildProxyGroups,
  buildRules,
  compileGroupRegex,
  expandRuleList,
  parseIni,
  resolveGroupMembers,
} from '../core/rules';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    'utf8',
  );
}

const mihomoIni = parseIni(fixture('xr_all_config_v2.ini'));
const legacyIni = parseIni(fixture('xr_all_config_v2_legacy.ini'));

describe('subconverter INI parser', () => {
  it('parses rulesets and proxy groups from the mihomo fixture', () => {
    expect(mihomoIni.rulesets).toHaveLength(38);
    expect(mihomoIni.groups).toHaveLength(31);
    expect(mihomoIni.common.exclude_remarks).toContain('请勿使用该节点');
    expect(mihomoIni.custom.enable_rule_generator).toBe('true');
  });

  it('parses rulesets and proxy groups from the legacy fixture', () => {
    expect(legacyIni.rulesets).toHaveLength(42);
    expect(legacyIni.groups).toHaveLength(31);
  });

  it('classifies URL and inline rulesets', () => {
    const url = mihomoIni.rulesets.find((entry) => entry.source.endsWith('direct.list'));
    expect(url).toMatchObject({
      group: '🎯 全球直连',
      kind: 'url',
    });

    const geosite = mihomoIni.rulesets.find(
      (entry) => entry.source === '[]GEOSITE,private',
    );
    expect(geosite).toMatchObject({
      group: '🎯 全球直连',
      kind: 'inline',
      inlineType: 'GEOSITE',
      inlineValue: ['private'],
    });

    const geoipl = mihomoIni.rulesets.find(
      (entry) => entry.source === '[]GEOIP,CN,no-resolve',
    );
    expect(geoipl).toMatchObject({
      kind: 'inline',
      inlineType: 'GEOIP',
      inlineValue: ['CN', 'no-resolve'],
    });

    const final = mihomoIni.rulesets.find((entry) => entry.source === '[]FINAL');
    expect(final).toMatchObject({
      group: '🐟 漏网之鱼',
      kind: 'inline',
      inlineType: 'FINAL',
    });
  });

  it('parses select groups, references and regex members', () => {
    const manual = mihomoIni.groups.find((group) => group.name === '🚀 手动切换');
    expect(manual?.type).toBe('select');
    expect(manual?.members).toEqual([{ kind: 'regex', pattern: '.*' }]);

    const ai = mihomoIni.groups.find((group) => group.name === '💬 Ai平台');
    expect(ai?.members[0]).toEqual({ kind: 'ref', name: '⭐ 优选线路' });
    expect(ai?.members.at(-1)).toEqual({ kind: 'ref', name: '🚀 手动切换' });

    const netease = mihomoIni.groups.find((group) => group.name === '🎶 网易音乐');
    expect(netease?.members).toContainEqual({
      kind: 'regex',
      pattern: '(网易|音乐|解锁|Music|NetEase)',
    });
  });

  it('parses url-test health-check fields', () => {
    const auto = mihomoIni.groups.find((group) => group.name === '⭐ 优选自动');

    expect(auto).toMatchObject({
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
    });
    expect(auto?.members).toEqual([{ kind: 'regex', pattern: '((?i)xxc)' }]);
  });

  it('compiles subconverter inline case-insensitive modifiers', () => {
    expect(compileGroupRegex('((?i)xxc)')).toEqual({
      source: 'xxc',
      flags: 'i',
    });
    expect(
      compileGroupRegex('(^(?!.*(?i)xxc).*)'),
    ).toEqual({
      source: '^(?!.*xxc).*',
      flags: 'i',
    });
  });

  it('resolves regex members and references against node names', () => {
    const preferred = mihomoIni.groups.find((group) => group.name === '⭐ 优选线路')!;
    const backup = mihomoIni.groups.find((group) => group.name === '🌐 备用线路')!;
    const nodeNames = [
      '🇭🇰 香港 01 xxc',
      '🇯🇵 日本 02 XXC',
      '🇺🇸 美国 03',
      '🇸🇬->🇭🇰 中转 xxc',
    ];

    expect(resolveGroupMembers(preferred, nodeNames).proxies).toEqual([
      '🇭🇰 香港 01 xxc',
      '🇯🇵 日本 02 XXC',
      '🇸🇬->🇭🇰 中转 xxc',
    ]);
    expect(resolveGroupMembers(backup, nodeNames).proxies).toEqual([
      '🇺🇸 美国 03',
    ]);
  });

  it('builds proxy groups with references, built-ins and regex expansion', () => {
    const groups = buildProxyGroups(mihomoIni, {
      nodeNames: ['🇭🇰 香港 01 xxc', '🇺🇸 美国 03'],
    });
    const manual = groups.find((group) => group.name === '🚀 手动切换');
    const ai = groups.find((group) => group.name === '💬 Ai平台');

    expect(manual?.proxies).toEqual(['🇭🇰 香港 01 xxc', '🇺🇸 美国 03']);
    expect(ai?.proxies).toContain('⭐ 优选线路');

    const microsoft = groups.find((group) => group.name === 'Ⓜ️ 微软服务');
    expect(microsoft?.proxies[0]).toBe('DIRECT');
  });
});

describe('Clash rule builder', () => {
  it('turns URL rulesets into rule-providers and inline rules into rules', () => {
    const built = buildRules(mihomoIni);
    const providerNames = Object.keys(built.ruleProviders);

    expect(providerNames).toHaveLength(31);
    expect(built.rules).toHaveLength(38);
    expect(built.ruleProviders[providerNames[0]]).toMatchObject({
      type: 'http',
      behavior: 'classical',
      path: `./ruleset/${providerNames[0]}.list`,
      interval: 86400,
    });
    expect(built.rules[0]).toBe('RULE-SET,rs_1,🎯 全球直连');
    expect(built.rules).toContain('GEOSITE,private,🎯 全球直连');
    expect(built.rules).toContain('GEOIP,CN,🎯 全球直连,no-resolve');
    expect(built.rules.at(-1)).toBe('MATCH,🐟 漏网之鱼');
    expect(built.skipped).toHaveLength(0);
  });

  it('expands legacy rules and never emits rule-providers', () => {
    const built = buildRules(legacyIni, {
      target: 'legacy',
      // Everything the resolver cannot answer is reported as skipped instead
      // of becoming a RULE-SET: legacy kernels cannot load rule-providers.
      expandRemote: () => undefined,
    });

    expect(Object.keys(built.ruleProviders)).toHaveLength(0);
    expect(built.rules.some((rule) => rule.startsWith('RULE-SET,'))).toBe(false);
    expect(built.rules).toContain('GEOIP,CN,🎯 全球直连,no-resolve');
    expect(built.rules.at(-1)).toBe('MATCH,🐟 漏网之鱼');
    // The legacy fixture has 40 URL rulesets, all without content here.
    expect(built.skipped).toHaveLength(40);
  });

  it('expands legacy URL rulesets inline and drops unsupported rule types', () => {
    const built = buildRules(
      parseIni(`
[custom]
ruleset=A,https://rules.example.com/one.list
ruleset=B,[]GEOIP,CN
ruleset=C,[]FINAL
`),
      {
        target: 'legacy',
        expandRemote: () =>
          [
            'DOMAIN,ads.example.com',
            'DOMAIN-REGEX,^a.{0,61}$', // mihomo-only rule type
            'GEOIP,CN,no-resolve',
            'MATCH',
          ].join('\n'),
      },
    );

    expect(Object.keys(built.ruleProviders)).toHaveLength(0);
    expect(built.rules).toEqual([
      'DOMAIN,ads.example.com,A',
      'GEOIP,CN,A,no-resolve',
      'MATCH,A',
      'GEOIP,CN,B',
      'MATCH,C',
    ]);
    // The DOMAIN-REGEX line was skipped inside the expanded ruleset.
    expect(built.skipped).toEqual([
      expect.objectContaining({
        kind: 'url',
        source: 'https://rules.example.com/one.list',
      }),
    ]);
  });

  it('skips inline rules unsupported by the target kernel', () => {
    const built = buildRules(mihomoIni, { target: 'legacy' });
    const geositeRules = mihomoIni.rulesets.filter(
      (entry) => entry.inlineType === 'GEOSITE',
    );
    const geositeSkips = built.skipped.filter(
      (entry) => entry.inlineType === 'GEOSITE',
    );

    expect(geositeSkips).toHaveLength(geositeRules.length);

    // Only inline rules reach `rules` here (no expandRemote for URL rulesets);
    // the 4 GEOSITE entries are dropped, the 2 GEOIP and 1 FINAL stay.
    expect(built.rules).toHaveLength(3);
    expect(built.rules.some((rule) => rule.startsWith('GEOSITE,'))).toBe(false);
    expect(built.rules).toContain('GEOIP,CN,🎯 全球直连,no-resolve');
    expect(built.rules.at(-1)).toBe('MATCH,🐟 漏网之鱼');
  });

  it('deduplicates providers that share the same URL', () => {
    const ini = parseIni(`
[custom]
ruleset=GROUP A,https://rules.example.com/one.list
ruleset=GROUP B,https://rules.example.com/one.list
ruleset=GROUP A,https://rules.example.com/two.list
`);
    const built = buildRules(ini);

    expect(Object.keys(built.ruleProviders)).toHaveLength(2);
    expect(built.rules).toEqual([
      'RULE-SET,rs_1,GROUP A',
      'RULE-SET,rs_1,GROUP B',
      'RULE-SET,rs_2,GROUP A',
    ]);
  });

  it('expands remote rulesets when a cache resolver is supplied', () => {
    const built = buildRules(
      parseIni(`
[custom]
ruleset=GROUP A,https://rules.example.com/direct.list
ruleset=GROUP B,[]GEOIP,CN
ruleset=GROUP C,[]FINAL
`),
      {
        expandRemote: (url) =>
          url.endsWith('direct.list')
            ? 'DOMAIN-SUFFIX,example.com\n# comment\nIP-CIDR,203.0.113.0/24,no-resolve'
            : undefined,
      },
    );

    expect(built.ruleProviders).toEqual({});
    expect(built.rules).toEqual([
      'DOMAIN-SUFFIX,example.com,GROUP A',
      'IP-CIDR,203.0.113.0/24,GROUP A,no-resolve',
      'GEOIP,CN,GROUP B',
      'MATCH,GROUP C',
    ]);
  });

  it('expands classical and YAML payload rule lists', () => {
    expect(
      expandRuleList(
        'DOMAIN,ads.example.com\nDOMAIN-SUFFIX,example.org\nIP-CIDR,198.51.100.0/24,no-resolve',
        'GROUP',
      ),
    ).toEqual([
      'DOMAIN,ads.example.com,GROUP',
      'DOMAIN-SUFFIX,example.org,GROUP',
      'IP-CIDR,198.51.100.0/24,GROUP,no-resolve',
    ]);

    expect(
      expandRuleList(
        'payload:\n  - DOMAIN-SUFFIX,example.net\n  - GEOIP,CN',
        'GROUP',
      ),
    ).toEqual(['DOMAIN-SUFFIX,example.net,GROUP', 'GEOIP,CN,GROUP']);
  });

  it('keeps comma-containing rule content such as regexes intact', () => {
    expect(
      expandRuleList(
        [
          'DOMAIN-REGEX,^a.{0,61}$',
          'DOMAIN-KEYWORD,example',
          'IP-CIDR,203.0.113.0/24,no-resolve',
        ].join('\n'),
        'GROUP',
      ),
    ).toEqual([
      'DOMAIN-REGEX,^a.{0,61}$,GROUP',
      'DOMAIN-KEYWORD,example,GROUP',
      'IP-CIDR,203.0.113.0/24,GROUP,no-resolve',
    ]);
  });

  it('keeps escaped commas and regex quantifiers intact when splitting rules', () => {
    expect(expandRuleList('DOMAIN-REGEX,^foo\\,DIRECT', 'NEW')).toEqual([
      'DOMAIN-REGEX,^foo\\,DIRECT,NEW',
    ]);
    expect(expandRuleList('DOMAIN-REGEX,^a.{0,61}$', 'NEW')).toEqual([
      'DOMAIN-REGEX,^a.{0,61}$,NEW',
    ]);

    const built = buildRules(
      parseIni(`
[custom]
ruleset=NEW,[]DOMAIN-REGEX,^foo\\,DIRECT
ruleset=NEW,[]DOMAIN-REGEX,^a.{0,61}$
`),
    );
    expect(built.rules).toEqual([
      'DOMAIN-REGEX,^foo\\,DIRECT,NEW',
      'DOMAIN-REGEX,^a.{0,61}$,NEW',
    ]);
  });

  it('does not append a policy onto a rule that already has one', () => {
    expect(expandRuleList('DOMAIN,example.com,OLD', 'NEW')).toEqual([
      'DOMAIN,example.com,OLD',
    ]);
    expect(
      expandRuleList('IP-CIDR,203.0.113.0/24,OLD,no-resolve', 'NEW'),
    ).toEqual(['IP-CIDR,203.0.113.0/24,OLD,no-resolve']);
    expect(expandRuleList('DOMAIN,example.com', 'NEW')).toEqual([
      'DOMAIN,example.com,NEW',
    ]);

    const built = buildRules(
      parseIni(`
[custom]
ruleset=NEW,[]DOMAIN,example.com,OLD
ruleset=NEW,[]IP-CIDR,203.0.113.0/24,OLD,no-resolve
ruleset=NEW,[]DOMAIN,example.com
`),
    );
    expect(built.rules).toEqual([
      'DOMAIN,example.com,OLD',
      'IP-CIDR,203.0.113.0/24,OLD,no-resolve',
      'DOMAIN,example.com,NEW',
    ]);
  });

  it('keeps inline rules whose content contains commas', () => {
    const ini = parseIni(`
[custom]
ruleset=GROUP,[]DOMAIN-REGEX,^a.{0,61}$
ruleset=GROUP,[]IP-CIDR,203.0.113.0/24,no-resolve
`);

    expect(ini.rulesets[0]).toMatchObject({
      kind: 'inline',
      inlineType: 'DOMAIN-REGEX',
      inlineValue: ['^a.{0,61}$'],
    });
    expect(ini.rulesets[1]).toMatchObject({
      kind: 'inline',
      inlineType: 'IP-CIDR',
      inlineValue: ['203.0.113.0/24', 'no-resolve'],
    });

    const built = buildRules(ini);
    expect(built.rules).toEqual([
      'DOMAIN-REGEX,^a.{0,61}$,GROUP',
      'IP-CIDR,203.0.113.0/24,GROUP,no-resolve',
    ]);
  });

  it('keeps whitelisted rule types when targeting legacy', () => {
    const ini = parseIni(`
[custom]
ruleset=GROUP A,[]SRC-IP-CIDR,10.0.0.0/8
ruleset=GROUP B,[]SRC-PORT,7777
ruleset=GROUP C,[]DST-PORT,443
ruleset=GROUP D,[]DOMAIN-REGEX,^a.{0,61}$
`);
    const built = buildRules(ini, { target: 'legacy' });

    expect(built.rules).toEqual([
      'SRC-IP-CIDR,10.0.0.0/8,GROUP A',
      'SRC-PORT,7777,GROUP B',
      'DST-PORT,443,GROUP C',
    ]);
    expect(built.skipped).toEqual([
      expect.objectContaining({ group: 'GROUP D', inlineType: 'DOMAIN-REGEX' }),
    ]);
  });

  it('refuses to compile oversized group regexes', () => {
    const group: ProxyGroupEntry = {
      name: 'BIG',
      type: 'select',
      rawOptions: [],
      members: [{ kind: 'regex', pattern: 'a'.repeat(300) }],
      raw: 'BIG`select`aaa',
    };
    const result = resolveGroupMembers(group, ['aaa']);

    expect(result.proxies).toHaveLength(0);
    expect(result.unresolved).toEqual(['a'.repeat(300)]);
  });
});
