// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DNS-leak-prevention template (fake-ip + encrypted DNS), QUIC blocking and the
 * AnyTLS idle-session default.
 *
 * Covers the core producer (built-in `dns:`, profile override, invalid
 * override, QUIC rule placement/de-duplication) and the export path that
 * plumbs a profile's `dnsTemplate` through (`/s/:token` + admin preview).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  BUILTIN_DNS_TEMPLATE,
  buildLeadingRules,
  buildMihomoProxies,
  isQuicBlockRule,
  parseAnyTLS,
  parseDnsTemplate,
  produceMihomo,
  QUIC_BLOCK_RULE,
  resolveDnsTemplate,
  type ProxyNode,
} from '../core';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import {
  buildTargetProxies,
  loadUserProfile,
  renderTargetBody,
  type ExportProfile,
} from '../server/utils/export-nodes';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';

const TOKEN = 'd'.repeat(32);

const NODE_YAML =
  'proxies:\n  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}\n';

const PROFILE_INI = [
  '[custom]',
  'custom_proxy_group=🚀 节点选择`select`.*',
  'ruleset=🚀 节点选择,[]MATCH',
].join('\n');

function node(overrides: Partial<ProxyNode> = {}): ProxyNode {
  return {
    type: 'ss',
    name: 'fixture-ss',
    server: 'example.com',
    port: 8388,
    cipher: 'aes-128-gcm',
    password: 'fake',
    ...overrides,
  } as ProxyNode;
}

type MihomoDocument = {
  dns: Record<string, unknown>;
  proxies: ProxyNode[];
  rules?: string[];
  [key: string]: unknown;
};

function produceDocument(options: Parameters<typeof produceMihomo>[1] = {}): MihomoDocument {
  return parseYaml(produceMihomo([node()], options)) as MihomoDocument;
}

/** Export-side profile fixture; `profile` optional so DNS alone is testable. */
function exportProfile(overrides: Partial<ExportProfile> = {}): ExportProfile {
  return {
    ruleProviders: {},
    rules: ['MATCH,🚀 节点选择'],
    proxyGroups: [{ name: '🚀 节点选择', type: 'select', proxies: ['fixture-ss'] }],
    groupNames: ['🚀 节点选择'],
    ...overrides,
  };
}

describe('clash target renders through the mihomo producer', () => {
  it('keeps modern protocols instead of filtering them away', () => {
    const nodes: ProxyNode[] = [
      node({ name: 'vless', type: 'vless', uuid: '11111111-2222-3333-4444-555555555555' }),
      node({ name: 'hy2', type: 'hysteria2', password: 'fake' }),
      node({ name: 'tuic', type: 'tuic', password: 'fake' }),
      node({ name: 'anytls', type: 'anytls', password: 'fake' }),
    ];
    for (const target of ['mihomo', 'clash'] as const) {
      const document = parseYaml(renderTargetBody(target, nodes)) as MihomoDocument;
      expect(document.proxies.map((proxy) => proxy.name)).toEqual(['vless', 'hy2', 'tuic', 'anytls']);
      expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
      expect(document.rules).toEqual([QUIC_BLOCK_RULE]);
    }
    // Identical node set for the node-name expansion used by profile groups.
    expect(buildTargetProxies('clash', nodes).map((proxy) => proxy.name)).toEqual(
      buildTargetProxies('mihomo', nodes).map((proxy) => proxy.name),
    );
  });

});

describe('built-in DNS template', () => {
  it('is the expected fake-ip + encrypted-DNS mapping', () => {
    expect(BUILTIN_DNS_TEMPLATE).toEqual({
      enable: true,
      ipv6: false,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'fake-ip-filter': [
        '*.lan',
        '*.local',
        'localhost',
        '*.home.arpa',
        '+.msftconnecttest.com',
        '+.msftncsi.com',
      ],
      'default-nameserver': ['223.5.5.5', '119.29.29.29'],
      nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
      'proxy-server-nameserver': ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
      fallback: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
      'fallback-filter': {
        geoip: true,
        'geoip-code': 'CN',
        ipcidr: ['240.0.0.0/4'],
      },
      'respect-rules': true,
      'prefer-h3': false,
    });
  });

  it('omits `listen` so the config imports without opening a local DNS port', () => {
    expect(BUILTIN_DNS_TEMPLATE).not.toHaveProperty('listen');
  });

  // mihomo rejects the whole config otherwise: "if respect-rules is turned
  // on, proxy-server-nameserver cannot be empty" (hit on a real import).
  it('sets proxy-server-nameserver because respect-rules requires it', () => {
    expect(BUILTIN_DNS_TEMPLATE['respect-rules']).toBe(true);
    const psn = BUILTIN_DNS_TEMPLATE['proxy-server-nameserver'] as string[];
    expect(Array.isArray(psn)).toBe(true);
    expect(psn.length).toBeGreaterThan(0);
  });

  // fake-ip without encrypted nameservers still leaks; both halves are asserted.
  it('only uses encrypted resolvers for real lookups, plain IPs for bootstrap', () => {
    const nameservers = [
      ...(BUILTIN_DNS_TEMPLATE.nameserver as string[]),
      ...(BUILTIN_DNS_TEMPLATE.fallback as string[]),
    ];
    expect(nameservers.every((entry) => entry.startsWith('https://'))).toBe(true);
    for (const bootstrap of BUILTIN_DNS_TEMPLATE['default-nameserver'] as string[]) {
      expect(bootstrap).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });
});

describe('mihomo producer: default DNS section', () => {
  it('emits the built-in dns section by default (pretty)', () => {
    const document = produceDocument();
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(document.dns['enhanced-mode']).toBe('fake-ip');
    expect(document.dns.nameserver).toContain('https://dns.alidns.com/dns-query');
    expect(document.dns.fallback).toContain('https://1.1.1.1/dns-query');
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(['fixture-ss']);
  });

  it('emits the same dns section in compact mode and stays valid YAML', () => {
    const output = produceMihomo([node()], { pretty: false });
    const document = parseYaml(output) as MihomoDocument;
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(document.proxies.map((proxy) => proxy.type)).toEqual(['ss']);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE]);
  });

  it('emits the dns section even without any node', () => {
    const document = parseYaml(produceMihomo([])) as MihomoDocument;
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(document.proxies).toEqual([]);
  });

  it('renders the clash target exactly like mihomo, dns section included', () => {
    // The legacy Clash producer used to drop the template (and every modern
    // protocol). `clash` now goes through the mihomo renderer, so its output
    // is byte-identical to `mihomo`'s.
    for (const target of ['mihomo', 'clash'] as const) {
      const document = parseYaml(renderTargetBody(target, [node()])) as MihomoDocument;
      expect(document).toEqual({
        dns: BUILTIN_DNS_TEMPLATE,
        proxies: [expect.objectContaining({ name: 'fixture-ss' })],
        rules: [QUIC_BLOCK_RULE],
      });
    }
  });
});

describe('mihomo producer: dnsTemplate override', () => {
  it('replaces the built-in section entirely', () => {
    const template = [
      'enable: true',
      'enhanced-mode: redir-host',
      'nameserver:',
      '  - https://dns.google/dns-query',
      '  - tls://dns.adguard.com',
    ].join('\n');

    const document = produceDocument({ dnsTemplate: template });

    expect(document.dns).toEqual({
      enable: true,
      'enhanced-mode': 'redir-host',
      nameserver: ['https://dns.google/dns-query', 'tls://dns.adguard.com'],
    });
    // A replacement, not a merge: no built-in key survives.
    expect(document.dns).not.toHaveProperty('fake-ip-range');
    expect(document.dns).not.toHaveProperty('fallback');
  });

  it('unwraps a full `dns:` block pasted from a working config', () => {
    const template = [
      'dns:',
      '  enable: true',
      '  nameserver:',
      '    - https://dns.google/dns-query',
    ].join('\n');

    expect(produceDocument({ dnsTemplate: template }).dns).toEqual({
      enable: true,
      nameserver: ['https://dns.google/dns-query'],
    });
  });

  it.each([
    ['invalid YAML', 'nameserver: [unclosed'],
    ['a scalar document', 'just-a-string'],
    ['a list, not a mapping', '- https://dns.google/dns-query'],
    ['an empty mapping', '{}'],
    ['blank text', '   \n  '],
  ])('falls back to the built-in template for %s', (_label, template) => {
    expect(parseDnsTemplate(template)).toBeNull();
    expect(resolveDnsTemplate(template)).toEqual(BUILTIN_DNS_TEMPLATE);

    const document = produceDocument({ dnsTemplate: template });
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    // The export (or producer call) still succeeds with usable proxies.
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(['fixture-ss']);
  });

  it('treats a missing/empty template as "use the built-in"', () => {
    expect(resolveDnsTemplate(null)).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(resolveDnsTemplate(undefined)).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(resolveDnsTemplate('')).toEqual(BUILTIN_DNS_TEMPLATE);
  });

  it('returns independent copies (a caller cannot mutate the constant)', () => {
    const first = resolveDnsTemplate(null);
    (first['fake-ip-filter'] as string[]).push('*.evil.test');
    expect(BUILTIN_DNS_TEMPLATE['fake-ip-filter']).not.toContain('*.evil.test');
    expect(resolveDnsTemplate(null)).toEqual(BUILTIN_DNS_TEMPLATE);
  });
});

describe('mihomo producer: QUIC blocking', () => {
  it('emits the QUIC reject rule first with no profile', () => {
    expect(produceDocument().rules).toEqual([QUIC_BLOCK_RULE]);
  });

  it('puts the QUIC rule ahead of every profile rule', () => {
    const body = renderTargetBody('mihomo', [node()], {}, exportProfile());
    const document = parseYaml(body) as MihomoDocument;
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);
    expect(document.rules![0]).toBe(QUIC_BLOCK_RULE);
  });

  it('keeps the rule as the first entry even when the profile has none', () => {
    const body = renderTargetBody('mihomo', [node()], {}, exportProfile({ rules: [] }));
    expect((parseYaml(body) as MihomoDocument).rules).toEqual([QUIC_BLOCK_RULE]);
  });

  it.each([
    QUIC_BLOCK_RULE,
    'AND, ((NETWORK, UDP), (DST-PORT, 443)), REJECT',
    'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT-DROP',
    'AND,((NETWORK=UDP),(DST-PORT=443)),REJECT',
  ])('does not duplicate an equivalent profile rule: %s', (profileRule) => {
    const body = renderTargetBody(
      'mihomo',
      [node()],
      {},
      exportProfile({ rules: [profileRule, 'MATCH,🚀 节点选择'] }),
    );
    const document = parseYaml(body) as MihomoDocument;
    expect(document.rules).toEqual([profileRule, 'MATCH,🚀 节点选择']);
    expect(document.rules!.filter(isQuicBlockRule)).toHaveLength(1);
  });

  it('still prepends the rule when the profile only blocks TCP/443', () => {
    const body = renderTargetBody(
      'mihomo',
      [node()],
      {},
      exportProfile({ rules: ['DST-PORT,443,REJECT', 'MATCH,🚀 节点选择'] }),
    );
    expect((parseYaml(body) as MihomoDocument).rules).toEqual([
      QUIC_BLOCK_RULE,
      'DST-PORT,443,REJECT',
      'MATCH,🚀 节点选择',
    ]);
  });

  it('also puts the QUIC rule first for the clash target', () => {
    const body = renderTargetBody('clash', [node()], {}, exportProfile());
    const document = parseYaml(body) as MihomoDocument;
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);
    // Section-for-section identical to mihomo.
    expect(body).toBe(renderTargetBody('mihomo', [node()], {}, exportProfile()));
  });

  it('can be disabled or replaced through the producer option', () => {
    expect(buildLeadingRules(['MATCH,x'], { leadingRules: false })).toEqual([]);
    expect(buildLeadingRules(['MATCH,x'], { leadingRules: ['DOMAIN,blocked.test,REJECT'] })).toEqual([
      'DOMAIN,blocked.test,REJECT',
    ]);
    expect(buildLeadingRules(['MATCH,x'])).toEqual([QUIC_BLOCK_RULE]);
  });
});

describe('mihomo producer: AnyTLS idle-session default', () => {
  it('gives anytls nodes min-idle-session 0 in the emitted config', () => {
    const anytls = parseAnyTLS(
      'anytls://fake-password@anytls.example.com:443?sni=anytls.example.com#AnyTLS',
    );
    const [proxy] = buildMihomoProxies([anytls]);
    expect(proxy['min-idle-session']).toBe(0);

    const document = parseYaml(produceMihomo([anytls])) as MihomoDocument;
    expect(document.proxies[0]).toMatchObject({
      type: 'anytls',
      'min-idle-session': 0,
      'idle-session-timeout': 30,
    });
    // The default also survives a profile + DNS template round trip.
    const withProfile = parseYaml(
      renderTargetBody('mihomo', [anytls], { dnsTemplate: 'enable: true' }, exportProfile()),
    ) as MihomoDocument;
    expect(withProfile.proxies[0]!['min-idle-session']).toBe(0);
  });

  it('keeps explicit anytls idle-session values', () => {
    const [proxy] = buildMihomoProxies([
      node({ type: 'anytls', name: 'anytls', password: 'fake', 'min-idle-session': 3 }),
    ]);
    expect(proxy['min-idle-session']).toBe(3);
  });
});

describe('export path: profile dnsTemplate', () => {
  const dirs: string[] = [];
  let db: SubhubDb;
  let userId: number;

  beforeEach(() => {
    resetExportRateLimiter();
    const dir = mkdtempSync(join(tmpdir(), 'subhub-dns-template-'));
    dirs.push(dir);
    db = openDb({ path: join(dir, 'subhub.sqlite') });
    userId = db
      .insert(users)
      .values({ name: 'fixture-user', token: TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    db.insert(sources)
      .values({
        name: 'fixture-source',
        url: encrypt('placeholder-source-not-a-real-subscription'),
        type: 'local',
        cacheBlob: NODE_YAML,
        ownerUserId: userId,
      })
      .run();
  });

  afterEach(() => {
    resetExportRateLimiter();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function attachProfile(dnsTemplate: string | null): void {
    const profile = db
      .insert(profiles)
      .values({ name: 'fixture-profile', iniText: PROFILE_INI, dnsTemplate })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();
  }

  async function exportMihomo() {
    resetExportRateLimiter();
    return handleSubscriptionExport(
      { token: TOKEN, target: 'mihomo', userAgent: 'clash', ip: '127.0.0.1' },
      { db },
    );
  }

  it('emits the built-in template when the profile has none', async () => {
    attachProfile(null);
    const response = await exportMihomo();
    expect(response.status).toBe(200);
    const document = parseYaml(response.body) as MihomoDocument;
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);
  });

  it('applies the profile dnsTemplate to /s/:token', async () => {
    attachProfile(
      ['enable: true', 'enhanced-mode: redir-host', 'nameserver:', '  - https://dns.example.net/dns-query'].join(
        '\n',
      ),
    );

    const response = await exportMihomo();
    expect(response.status).toBe(200);
    const document = parseYaml(response.body) as MihomoDocument;
    expect(document.dns).toEqual({
      enable: true,
      'enhanced-mode': 'redir-host',
      nameserver: ['https://dns.example.net/dns-query'],
    });
    expect(document.dns).not.toHaveProperty('fake-ip-range');
    // Sections are still complete: the producer owns dns/proxies/rules, the
    // profile sections (rule-providers, proxy-groups) are appended after them.
    expect(Object.keys(document).sort()).toEqual(['dns', 'proxies', 'proxy-groups', 'rules']);
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(['fixture-ss']);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);
  });

  it('surfaces the profile template on ExportProfile', async () => {
    attachProfile('nameserver:\n  - https://dns.example.net/dns-query');
    const loaded = await loadUserProfile(db, userId, 'mihomo', [node()], async () => PROFILE_INI);
    expect(loaded?.profile.dnsTemplate).toBe('nameserver:\n  - https://dns.example.net/dns-query');

    const body = renderTargetBody('mihomo', loaded?.nodes ?? [node()], {}, loaded?.profile ?? null);
    expect((parseYaml(body) as MihomoDocument).dns).toEqual({
      nameserver: ['https://dns.example.net/dns-query'],
    });
  });

  it('falls back to the built-in template for an invalid dnsTemplate and still exports', async () => {
    attachProfile('nameserver: [unclosed');

    const response = await exportMihomo();
    expect(response.status).toBe(200);
    const document = parseYaml(response.body) as MihomoDocument;
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(document.proxies.map((proxy) => proxy.name)).toEqual(['fixture-ss']);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);
  });

  it('applies the dns section and QUIC rule to the clash export too', async () => {
    attachProfile('nameserver:\n  - https://dns.example.net/dns-query');
    resetExportRateLimiter();
    const clash = await handleSubscriptionExport(
      { token: TOKEN, target: 'clash', userAgent: 'clash', ip: '127.0.0.1' },
      { db },
    );
    expect(clash.status).toBe(200);
    const document = parseYaml(clash.body) as MihomoDocument;
    expect(document.dns).toEqual({ nameserver: ['https://dns.example.net/dns-query'] });
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);

    // Identical to what /s/:token/mihomo serves.
    const mihomo = await exportMihomo();
    expect(clash.body).toBe(mihomo.body);
  });
});
