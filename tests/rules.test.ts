import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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

  it('builds legacy rules without GEOSITE entries', () => {
    const built = buildRules(legacyIni, { target: 'legacy' });

    expect(Object.keys(built.ruleProviders)).toHaveLength(40);
    expect(built.rules).toHaveLength(42);
    expect(built.rules.some((rule) => rule.startsWith('GEOSITE,'))).toBe(false);
    expect(built.rules).toContain('GEOIP,CN,🎯 全球直连,no-resolve');
    expect(built.rules.at(-1)).toBe('MATCH,🐟 漏网之鱼');
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
    expect(built.rules).toHaveLength(38 - geositeRules.length);
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
});
