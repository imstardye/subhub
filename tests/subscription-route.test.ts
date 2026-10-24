// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { openDb, type SubhubDb } from '../server/db';
import { accessLogs, profiles, sources, userSources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import {
  detectTargetFromUserAgent,
  exportRateLimiterSize,
  handleSubscriptionExport,
  resetExportRateLimiter,
  resolveTarget,
} from '../server/utils/subscription';
import { RATE_LIMIT_MAX } from '../server/utils/rate-limit';
import { BUILTIN_DNS_TEMPLATE, QUIC_BLOCK_RULE } from '../core';

/** Test-only token; every fixture host below is example.com. */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DISABLED_TOKEN = 'f'.repeat(32);

const dirs: string[] = [];
let db: SubhubDb;
let userId: number;
let disabledUserId: number;

beforeEach(() => {
  resetExportRateLimiter();
  const dir = mkdtempSync(join(tmpdir(), 'subhub-export-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });

  const inserted = db
    .insert(users)
    .values({ name: 'fixture-user', token: TOKEN, enabled: true })
    .returning({ id: users.id })
    .get();
  userId = inserted!.id;

  const disabled = db
    .insert(users)
    .values({ name: 'disabled-user', token: DISABLED_TOKEN, enabled: false })
    .returning({ id: users.id })
    .get();
  disabledUserId = disabled!.id;
});

afterEach(() => {
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function call(token: string, target?: string | null, userAgent?: string | null, ip = '127.0.0.1') {
  return handleSubscriptionExport(
    { token, target, userAgent: userAgent ?? 'clash-verge/v2.0', ip },
    { db },
  );
}

/** Insert a source; `ownerId` null makes it public (shared by every user). */
function attachSource(cacheBlob: string | null, ownerId: number | null = userId, name = 'fixture-source'): number {
  const source = db
    .insert(sources)
    .values({
      name,
      // Never a real URL: encrypted placeholder text only.
      url: encrypt('placeholder-source-not-a-real-subscription'),
      type: 'local',
      cacheBlob,
      ownerUserId: ownerId,
    })
    .returning({ id: sources.id })
    .get();
  return source!.id;
}

describe('GET /s/:token rate limiting', () => {
  it('returns 200 for the first 30 requests and 429 afterwards', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await call(TOKEN)).status).toBe(200);
    }
    const blocked = await call(TOKEN);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTypeOf('string');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('counts each token separately', async () => {
    for (let i = 0; i < 30; i += 1) await call(TOKEN);
    expect((await call(TOKEN)).status).toBe(429);
    // A different (disabled) token is still rate limited on its own budget and
    // answered with 404, not 429.
    expect((await call(DISABLED_TOKEN)).status).toBe(404);
  });

});

describe('GET /s/:token unknown tokens', () => {
  it('does not create one limiter entry per made-up token', async () => {
    // Each request uses a fresh random token: a per-token map would grow by
    // one entry per request. Requests beyond the IP budget are 429, never a
    // new map entry.
    for (let i = 0; i < 500; i += 1) {
      expect([404, 429]).toContain((await call(`fake-${i}-${'x'.repeat(16)}`)).status);
    }
    expect(exportRateLimiterSize()).toBe(1);
  });

  it('rate limits unknown tokens per IP instead of per token', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
      expect((await call(`fake-${i}`)).status).toBe(404);
    }
    expect((await call('another-fake-token')).status).toBe(429);
    // A different client IP still gets its own budget.
    expect((await call('another-fake-token', null, null, '198.51.100.7')).status).toBe(404);
    // The map stays at one entry per IP seen, regardless of token count.
    expect(exportRateLimiterSize()).toBe(2);
  });

  it('never exceeds a bounded map under a large token flood', async () => {
    let blocked = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const status = (await call(`flood-${i}-${'y'.repeat(24)}`, null, null, `192.0.2.${i % 8}`)).status;
      if (status === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
    // Bounded by the number of distinct IPs (8), not by the 2k tokens.
    expect(exportRateLimiterSize()).toBeLessThanOrEqual(8);
  });

  it('still applies the per-token limit to known users', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) await call(TOKEN);
    expect((await call(TOKEN)).status).toBe(429);
    // The disabled user is tracked in the IP bucket, not the token bucket.
    expect((await call(DISABLED_TOKEN)).status).toBe(404);
    expect(exportRateLimiterSize()).toBe(2);
  });
});

describe('GET /s/:token user lookup', () => {
  it('returns 404 for an unknown token', async () => {
    const response = await call('0'.repeat(32));
    expect(response.status).toBe(404);
    expect(response.body).toContain('Not Found');
  });

  it('returns 404 for a disabled user', async () => {
    expect((await call(DISABLED_TOKEN)).status).toBe(404);
  });

  it('returns 404 for an empty token without touching the database', async () => {
    expect((await call('')).status).toBe(404);
  });

  it('logs 404 and 200 responses to access_logs', async () => {
    await call('0'.repeat(32));
    expect((await call(TOKEN)).status).toBe(200);

    const logs = db.select().from(accessLogs).all();
    expect(logs.some((log) => log.status === 404 && log.userId === null)).toBe(true);
    const ok = logs.find((log) => log.status === 200);
    expect(ok).toMatchObject({ userId, target: 'clash', ip: '127.0.0.1' });
    expect(ok?.ms).toBeTypeOf('number');
    expect(db.select().from(accessLogs).where(eq(accessLogs.userId, disabledUserId)).all()).toEqual([]);
  });
});

describe('GET /s/:token valid export', () => {
  it('returns 200 with the built-in DNS template, no proxies and the QUIC block', async () => {
    const response = await call(TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/yaml');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="subhub-${userId}-clash.yaml"`,
    );
    // No source cache -> no aggregated userinfo -> no header at all (the old
    // hard-coded `upload=0; download=0; total=0; expire=0` placeholder is gone;
    // see tests/userinfo.test.ts for the aggregation itself).
    expect(response.headers).not.toHaveProperty('subscription-userinfo');
    // Every mihomo body now carries the anti-leak template (see
    // tests/dns-template.test.ts for the detailed assertions). The default
    // User-Agent here is a Clash client, i.e. mihomo.
    expect(resolveTarget(undefined, 'clash-verge/v2.0')).toBe('clash');
    expect(call(TOKEN, 'mihomo')).toBeInstanceOf(Promise);
    expect(parseYaml((await call(TOKEN, 'mihomo')).body)).toEqual({
      dns: BUILTIN_DNS_TEMPLATE,
      proxies: [],
      rules: [QUIC_BLOCK_RULE],
    });
  });

  it('sends cache-control: no-store and the security headers on 200', async () => {
    attachSource(null);
    for (const target of [undefined, 'clash', 'mihomo']) {
      const response = await call(TOKEN, target);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('returns 200 with an empty proxies list when the source cache is empty', async () => {
    attachSource(null);
    attachSource('   ');
    const response = await call(TOKEN, 'mihomo');
    expect(response.status).toBe(200);
    expect(parseYaml(response.body)).toMatchObject({ proxies: [] });
  });

  it('falls back to mihomo YAML for targets that are not implemented yet (P4)', async () => {
    attachSource('proxies:\n  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}\n');
    for (const target of ['mihomo', 'shadowrocket', 'singbox', 'surge', 'loon', 'uri']) {
      const response = await call(TOKEN, target);
      expect(response.status).toBe(200);
      const yaml = parseYaml(response.body) as { proxies: Array<{ name: string }> };
      expect(yaml.proxies.map((proxy) => proxy.name)).toEqual(['fixture-ss']);
      expect(response.headers['content-disposition']).toContain(`-${target}.yaml`);
    }
  });

  it('rejects an unknown explicit target without disclosing anything', async () => {
    const response = await call(TOKEN, 'not-a-target');
    expect(response.status).toBe(400);
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});

describe('GET /s/:token source aggregation', () => {
  it('includes public sources and the user\'s own dedicated sources, not other users\'', async () => {
    const otherUserId = db
      .insert(users)
      .values({ name: 'other-user', token: 'b'.repeat(32), enabled: true })
      .returning({ id: users.id })
      .get()!.id;

    const link = (name: string) =>
      `ss://YWVzLTI1Ni1nY206c2VjcmV0@node.example.com:8388#${name}`;

    // Inserted out of order on purpose: public first, then dedicated, then a
    // foreign dedicated source that must be filtered out.
    attachSource(link('public-one'), null);
    attachSource(link('foreign'), otherUserId);
    attachSource(link('dedicated-one'), userId);
    attachSource(link('public-two'), null);

    const response = await call(TOKEN, 'mihomo');
    expect(response.status).toBe(200);
    const yaml = parseYaml(response.body) as { proxies: Array<{ name: string }> };
    // Access model v2: dedicated sources come first, then shared/public by
    // source id (SQLite's NULL-first ordering is no longer relied on).
    expect(yaml.proxies.map((proxy) => proxy.name)).toEqual([
      'dedicated-one',
      'public-one',
      'public-two',
    ]);

    // The other user sees only their own dedicated source plus the public ones.
    resetExportRateLimiter();
    const other = await handleSubscriptionExport(
      { token: 'b'.repeat(32), target: 'mihomo', userAgent: 'clash', ip: '127.0.0.1' },
      { db },
    );
    const otherYaml = parseYaml(other.body) as { proxies: Array<{ name: string }> };
    expect(otherYaml.proxies.map((proxy) => proxy.name)).toEqual([
      'foreign',
      'public-one',
      'public-two',
    ]);
  });

  it('no longer reads the legacy user_sources join table', async () => {
    db.insert(userSources).values({ userId, sourceId: attachSource('ss://YWVzLTI1Ni1nY206c2VjcmV0@a.example.com:1#link-only', null), sort: 0 }).run();
    // A source linked only through the join table (public, so it is included),
    // and an unlinked public source — both are visible through the owner model.
    const response = await call(TOKEN, 'mihomo');
    const yaml = parseYaml(response.body) as { proxies: Array<{ name: string }> };
    expect(yaml.proxies.map((proxy) => proxy.name)).toEqual(['link-only']);
  });
});

describe('GET /s/:token/:target clash render parity', () => {
  // Regression: target `clash` used to go through the legacy Clash producer,
  // whose whitelist dropped vless/anytls/tuic/hysteria2 — a user with only
  // modern nodes got `proxies: []` with emptied groups.
  const MODERN_NODES = [
    'proxies:',
    '  - {name: "modern-vless", type: vless, server: v.example.com, port: 443, uuid: "11111111-2222-3333-4444-555555555555", tls: true, servername: v.example.com}',
    '  - {name: "modern-hy2", type: hysteria2, server: h.example.com, port: 443, password: "fake", sni: h.example.com}',
    '  - {name: "modern-tuic", type: tuic, server: t.example.com, port: 443, uuid: "11111111-2222-3333-4444-555555555555", password: "fake"}',
    '  - {name: "modern-anytls", type: anytls, server: a.example.com, port: 443, password: "fake"}',
  ].join('\n');

  it('keeps every modern node and renders the same body as mihomo', async () => {
    attachSource(MODERN_NODES, null);

    const clash = await call(TOKEN, 'clash');
    expect(clash.status).toBe(200);
    const document = parseYaml(clash.body) as {
      dns: Record<string, unknown>;
      proxies: Array<{ name: string; type: string }>;
      rules: string[];
    };
    expect(document.proxies.map((proxy) => proxy.name)).toEqual([
      'modern-vless',
      'modern-hy2',
      'modern-tuic',
      'modern-anytls',
    ]);
    expect(document.proxies.map((proxy) => proxy.type)).toEqual([
      'vless',
      'hysteria2',
      'tuic',
      'anytls',
    ]);
    // Built-in DNS leak protection and the QUIC block come with it.
    expect(document.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE]);

    const mihomo = await call(TOKEN, 'mihomo');
    expect(clash.body).toBe(mihomo.body);
    // Same content type/filename scheme, keyed by the requested target.
    expect(clash.headers['content-type']).toBe(mihomo.headers['content-type']);
    expect(clash.headers['content-disposition']).toContain('-clash.yaml');
  });

  it('fills profile groups with the modern nodes too', async () => {
    attachSource(MODERN_NODES, null);
    const profile = db
      .insert(profiles)
      .values({
        name: 'fixture-modern-profile',
        iniText: [
          '[custom]',
          'custom_proxy_group=🚀 节点选择`select`.*',
          'ruleset=🚀 节点选择,[]MATCH',
        ].join('\n'),
      })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

    const response = await call(TOKEN, 'clash');
    expect(response.status).toBe(200);
    const yaml = parseYaml(response.body) as {
      'proxy-groups': Array<{ name: string; proxies: string[] }>;
      rules: string[];
    };
    expect(yaml['proxy-groups'][0]!.proxies).toEqual([
      'modern-vless',
      'modern-hy2',
      'modern-tuic',
      'modern-anytls',
    ]);
    expect(yaml.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);
  });
});

describe('GET /s/:token rule profile', () => {
  const PROFILE_INI = [
    '[custom]',
    'custom_proxy_group=🚀 节点选择`select`.*',
    'custom_proxy_group=🎯 全球直连`select`[]DIRECT',
    'ruleset=🎯 全球直连,[]GEOIP,CN',
    'ruleset=🚀 节点选择,[]MATCH',
  ].join('\n');

  function attachProfile(iniText: string, variant: 'mihomo' | 'legacy' = 'mihomo'): number {
    const profile = db
      .insert(profiles)
      .values({ name: 'fixture-profile', iniText, variant })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();
    return profile.id;
  }

  it('applies the profile groups and rules for mihomo and clash targets', async () => {
    attachSource(
      'proxies:\n  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}\n',
      null,
    );
    attachProfile(PROFILE_INI);

    for (const target of ['mihomo', 'clash'] as const) {
      resetExportRateLimiter();
      const response = await call(TOKEN, target);
      expect(response.status).toBe(200);
      const yaml = parseYaml(response.body) as {
        proxies: Array<{ name: string }>;
        'proxy-groups': Array<{ name: string; proxies: string[] }>;
        rules: string[];
      };
      expect(yaml.proxies.map((proxy) => proxy.name)).toEqual(['fixture-ss']);
      expect(yaml['proxy-groups'].map((group) => group.name)).toEqual(['🚀 节点选择', '🎯 全球直连']);
      expect(yaml['proxy-groups'][0]!.proxies).toContain('fixture-ss');
      // `clash` renders exactly like `mihomo` (same producer): the QUIC block
      // is always the first rule, ahead of every profile rule.
      expect(yaml.rules).toEqual([QUIC_BLOCK_RULE, 'GEOIP,CN,🎯 全球直连', 'MATCH,🚀 节点选择']);
    }
  });

  it('expands group regexes against the produced node names, not the raw ones', async () => {
    // The mihomo producer renames `tls-fingerprint` -> `fingerprint`; group
    // members must still match, i.e. both nodes end up in the group.
    attachSource(
      [
        'proxies:',
        '  - {name: "hk-01", type: ss, server: a.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
        '  - {name: "us-01", type: ss, server: b.example.com, port: 8388, cipher: aes-128-gcm, password: "fake", "tls-fingerprint": chrome}',
      ].join('\n'),
      null,
    );
    attachProfile(
      ['[custom]', 'custom_proxy_group=🚀 节点选择`select`.*', 'ruleset=🚀 节点选择,[]MATCH'].join('\n'),
    );

    const response = await call(TOKEN, 'mihomo');
    expect(response.status).toBe(200);
    const yaml = parseYaml(response.body) as {
      proxies: Array<{ name: string; fingerprint?: string }>;
      'proxy-groups': Array<{ name: string; proxies: string[] }>;
    };
    expect(yaml.proxies.map((proxy) => proxy.name)).toEqual(['hk-01', 'us-01']);
    expect(yaml.proxies[1]!.fingerprint).toBe('chrome');
    expect(yaml['proxy-groups'][0]!.proxies).toEqual(['hk-01', 'us-01']);
  });

  it('keeps the nodes-only output when the user has no profile', async () => {
    attachSource(
      'proxies:\n  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}\n',
      null,
    );
    const response = await call(TOKEN, 'mihomo');
    const yaml = parseYaml(response.body) as Record<string, unknown>;
    expect(Object.keys(yaml)).toEqual(['dns', 'proxies', 'rules']);
    expect(yaml.dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect(yaml.proxies).toEqual([
      { name: 'fixture-ss', type: 'ss', server: 'example.com', port: 8388, cipher: 'aes-128-gcm', password: 'fake' },
    ]);
    expect(yaml.rules).toEqual([QUIC_BLOCK_RULE]);
  });

  it('falls back to nodes only when the profile INI cannot be fetched', async () => {
    const profile = db
      .insert(profiles)
      .values({ name: 'remote-profile', iniUrl: 'https://example.com/rules.ini' })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

    const response = await handleSubscriptionExport(
      { token: TOKEN, target: 'mihomo', userAgent: 'clash', ip: '127.0.0.1' },
      // Simulates a failed fetch (the default resolver returns null).
      { db, resolveProfileIni: async () => null },
    );
    expect(response.status).toBe(200);
    expect(parseYaml(response.body)).toMatchObject({ proxies: [], rules: [QUIC_BLOCK_RULE] });
  });

  it('ignores a profile that defines neither groups nor rules', async () => {
    attachProfile('[common]\nfoo=bar');
    const response = await call(TOKEN, 'mihomo');
    expect(parseYaml(response.body)).toMatchObject({ proxies: [] });
    expect((parseYaml(response.body) as Record<string, unknown>).rules).toEqual([QUIC_BLOCK_RULE]);
  });
});

describe('target detection', () => {
  it('guesses from the User-Agent and defaults to mihomo', async () => {
    expect(detectTargetFromUserAgent('Shadowrocket/1.0 CFNetwork')).toBe('shadowrocket');
    expect(detectTargetFromUserAgent('sing-box 1.10')).toBe('singbox');
    expect(detectTargetFromUserAgent('Surge/5 iOS')).toBe('surge');
    expect(detectTargetFromUserAgent('Loon/3')).toBe('loon');
    expect(detectTargetFromUserAgent('clash-verge/v2')).toBe('clash');
    expect(detectTargetFromUserAgent('curl/8')).toBe('mihomo');
    expect(detectTargetFromUserAgent(null)).toBe('mihomo');
  });

  it('prefers an explicit target over the User-Agent', async () => {
    expect(resolveTarget('mihomo', 'Shadowrocket/1.0')).toBe('mihomo');
    expect(resolveTarget('', 'Shadowrocket/1.0')).toBe('shadowrocket');
    expect(resolveTarget('MIHOMO', null)).toBe('mihomo');
    expect(resolveTarget('bogus', null)).toBeNull();
  });
});
