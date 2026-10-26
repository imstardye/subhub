// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  expandRuleProviders,
  MIHOMO_EXPANSION_RULE_TYPES,
  type ClashRuleProvider,
} from '../core';

const GROUP = '💬 Ai平台';
const POLICIES = new Set([GROUP, 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']);

function provider(url: string): ClashRuleProvider {
  return {
    type: 'http',
    behavior: 'classical',
    format: 'text',
    url,
    path: './ruleset/rs.list',
    interval: 86400,
  };
}

function providers(): Record<string, ClashRuleProvider> {
  return {
    rs_1: provider('https://example.com/a.list'),
    rs_2: provider('https://example.com/b.list'),
  };
}

function bodies(first: string | null, second: string | null = null): Map<string, string | null> {
  return new Map([
    ['https://example.com/a.list', first],
    ['https://example.com/b.list', second],
  ]);
}

describe('expandRuleProviders', () => {
  it('inherits the RULE-SET policy when a list line has none', () => {
    const result = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台', 'MATCH,DIRECT'],
      providers(),
      bodies('DOMAIN-SUFFIX,openai.com\nDOMAIN,chatgpt.com'),
      POLICIES,
    );
    expect(result.rules).toEqual([
      'DOMAIN-SUFFIX,openai.com,💬 Ai平台',
      'DOMAIN,chatgpt.com,💬 Ai平台',
      'MATCH,DIRECT',
    ]);
    expect(result.providers).toEqual({ rs_2: provider('https://example.com/b.list') });
  });

  it('honours a list line’s own policy (the DIRECT case)', () => {
    const result = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台'],
      providers(),
      bodies('DOMAIN-SUFFIX,msftconnecttest.com,DIRECT'),
      POLICIES,
    );
    expect(result.rules).toEqual(['DOMAIN-SUFFIX,msftconnecttest.com,DIRECT']);
  });

  it('does not mistake a trailing option for a policy, even if the name collides', () => {
    const result = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台'],
      providers(),
      bodies('IP-CIDR,203.0.113.0/24,no-resolve'),
      new Set([...POLICIES, 'no-resolve']),
    );
    expect(result.rules).toEqual(['IP-CIDR,203.0.113.0/24,💬 Ai平台,no-resolve']);
  });

  it('inherits set-level options onto IP rules only, without duplicating them', () => {
    const result = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台,no-resolve'],
      providers(),
      bodies(
        [
          'DOMAIN-SUFFIX,example.com',
          'IP-CIDR,198.51.100.0/24',
          'IP-CIDR,203.0.113.0/24,no-resolve',
          'IP-CIDR6,2001:db8::/32',
          'GEOIP,CN,DIRECT',
        ].join('\n'),
      ),
      POLICIES,
    );
    expect(result.rules).toEqual([
      'DOMAIN-SUFFIX,example.com,💬 Ai平台',
      'IP-CIDR,198.51.100.0/24,💬 Ai平台,no-resolve',
      'IP-CIDR,203.0.113.0/24,💬 Ai平台,no-resolve',
      'IP-CIDR6,2001:db8::/32,💬 Ai平台,no-resolve',
      'GEOIP,CN,DIRECT,no-resolve',
    ]);
  });

  it('skips BOM, blank lines, comments and nested RULE-SET/MATCH/FINAL lines', () => {
    const result = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台'],
      providers(),
      bodies(
        [
          '\uFEFF# header',
          '// another comment',
          '',
          'DOMAIN-SUFFIX,real.com',
          'RULE-SET,rs_2,💬 Ai平台',
          'MATCH,DIRECT',
          'FINAL,REJECT',
          'DOMAIN,last.com',
        ].join('\n'),
      ),
      POLICIES,
    );
    expect(result.rules).toEqual([
      'DOMAIN-SUFFIX,real.com,💬 Ai平台',
      'DOMAIN,last.com,💬 Ai平台',
    ]);
    expect(Object.keys(result.providers)).toEqual(['rs_2']);
  });

  it('keeps the line and provider when its body is null or missing', () => {
    const result = expandRuleProviders(
      ['DOMAIN-SUFFIX,before.com,DIRECT', 'RULE-SET,rs_1,💬 Ai平台', 'MATCH,DIRECT'],
      providers(),
      bodies(null),
      POLICIES,
    );
    expect(result.rules).toEqual([
      'DOMAIN-SUFFIX,before.com,DIRECT',
      'RULE-SET,rs_1,💬 Ai平台',
      'MATCH,DIRECT',
    ]);
    expect(result.providers).toEqual(providers());
  });

  it('preserves the expanded position relative to surrounding rules', () => {
    const result = expandRuleProviders(
      [
        'DOMAIN-SUFFIX,first.com,DIRECT',
        'RULE-SET,rs_1,💬 Ai平台',
        'RULE-SET,rs_2,REJECT',
        'DOMAIN-SUFFIX,last.com,DIRECT',
      ],
      providers(),
      bodies('DOMAIN,a.com', 'DOMAIN,b.com'),
      POLICIES,
    );
    expect(result.rules).toEqual([
      'DOMAIN-SUFFIX,first.com,DIRECT',
      'DOMAIN,a.com,💬 Ai平台',
      'DOMAIN,b.com,REJECT',
      'DOMAIN-SUFFIX,last.com,DIRECT',
    ]);
    expect(result.providers).toEqual({});
  });

  it('dedupes identical emitted lines within one provider expansion', () => {
    const result = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台'],
      providers(),
      bodies(['DOMAIN-SUFFIX,a.com', 'DOMAIN-SUFFIX,a.com', 'DOMAIN-SUFFIX,a.com,DIRECT'].join('\n')),
      POLICIES,
    );
    expect(result.rules).toEqual([
      'DOMAIN-SUFFIX,a.com,💬 Ai平台',
      'DOMAIN-SUFFIX,a.com,DIRECT',
    ]);
  });

  it('skips malformed lines instead of throwing', () => {
    const result = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台'],
      providers(),
      bodies(['DOMAIN-SUFFIX', ',no-type', 'DOMAIN-SUFFIX,,DIRECT', 'DOMAIN-SUFFIX,ok.com'].join('\n')),
      POLICIES,
    );
    expect(result.rules).toEqual(['DOMAIN-SUFFIX,ok.com,💬 Ai平台']);
  });

  it('drops provider-only types (URL-REGEX) when an allowed-types set is given', () => {
    // Real blackmatrix7 lists carry Surge-only URL-REGEX lines: mihomo skips
    // them inside a provider but rejects the whole config when one reaches
    // the top-level rules array (verified against the 1.19.33 binary).
    const body = ['URL-REGEX,^https?://ads\\.example\\.com', 'DOMAIN-SUFFIX,ok.com'].join('\n');
    const filtered = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台'],
      providers(),
      bodies(body),
      POLICIES,
      MIHOMO_EXPANSION_RULE_TYPES,
    );
    expect(filtered.rules).toEqual(['DOMAIN-SUFFIX,ok.com,💬 Ai平台']);

    const unfiltered = expandRuleProviders(
      ['RULE-SET,rs_1,💬 Ai平台'],
      providers(),
      bodies(body),
      POLICIES,
    );
    expect(unfiltered.rules).toEqual([
      'URL-REGEX,^https?://ads\\.example\\.com,💬 Ai平台',
      'DOMAIN-SUFFIX,ok.com,💬 Ai平台',
    ]);
  });
});
