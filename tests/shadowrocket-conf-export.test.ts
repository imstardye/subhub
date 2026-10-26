// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `shadowrocket-conf` export integration: the public subscription handler
 * loads the profile fully (groups + rules + custom rules), renders the native
 * conf document, and drops what Shadowrocket cannot express.
 *
 * The same user's nodes-only `shadowrocket` export must keep its old shape.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import {
  handleSubscriptionExport,
  resetExportRateLimiter,
} from '../server/utils/subscription';
import { parseSubscription } from '../core';

const TOKEN = 'c1d2e3f405162738495a6b7c8d9e0f12';

const SOURCE = [
  'proxies:',
  '  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '  - {name: "fixture-vless", type: vless, server: vless.example.com, port: 443, uuid: 11111111-2222-3333-4444-555555555555, tls: true, servername: vless.example.com}',
  '  - {name: "HK,01=fast", type: ss, server: hk.example.com, port: 8388, cipher: aes-128-gcm, password: "fake-hk"}',
].join('\n');

const PROFILE_INI = [
  '[custom]',
  'custom_proxy_group=🚀 节点选择`select`.*',
  'custom_proxy_group=♻️ 自动选择`url-test`.*`https://example.com/generate_204`120',
  'custom_proxy_group=🎯 全球直连`select`[]DIRECT',
  'custom_proxy_group=🔗 中继`relay`.*',
  'ruleset=🎯 全球直连,[]GEOIP,CN',
  'ruleset=🚀 节点选择,[]DOMAIN-SUFFIX,example.org',
  'ruleset=🚀 节点选择,[]GEOSITE,openai',
  'ruleset=🚀 节点选择,https://rules.example.com/proxy.list',
  'ruleset=🔗 中继,[]DOMAIN,relay.example.com',
  'ruleset=🚀 节点选择,[]MATCH',
].join('\n');

const dirs: string[] = [];
let db: SubhubDb;
let userId: number;

beforeEach(() => {
  resetExportRateLimiter();
  const dir = mkdtempSync(join(tmpdir(), 'subhub-srconf-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });

  userId = db
    .insert(users)
    .values({
      name: 'fixture-user',
      token: TOKEN,
      enabled: true,
      // Prepend + append both go through the same translation.
      customRules: [
        'DOMAIN-SUFFIX,custom.example.com,🚀 节点选择',
        'GEOSITE,openai,🚀 节点选择',
      ].join('\n'),
      customRulesPosition: 'prepend',
    })
    .returning({ id: users.id })
    .get()!.id;

  const profile = db
    .insert(profiles)
    .values({ name: 'fixture-profile', iniText: PROFILE_INI })
    .returning({ id: profiles.id })
    .get()!;
  db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

  db.insert(sources)
    .values({
      name: 'fixture-source',
      url: encrypt('placeholder-source-not-a-real-subscription'),
      type: 'local',
      cacheBlob: SOURCE,
      ownerUserId: userId,
    })
    .run();
});

afterEach(() => {
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function exportAs(target: string) {
  return handleSubscriptionExport(
    { token: TOKEN, target, userAgent: 'shadowrocket/2.2', ip: '127.0.0.1' },
    { db },
  );
}

describe('shadowrocket-conf export through /s/:token', () => {
  it('renders every section and translates the profile rules', async () => {
    const response = await exportAs('shadowrocket-conf');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="subhub-${userId}-shadowrocket-conf.conf"`,
    );

    const body = response.body;
    expect(body).toContain('[General]\nbypass-system = true');
    expect(body).toContain('[Proxy]\nfixture-ss = ss, example.com, 8388, aes-128-gcm, fake');
    expect(body).toContain(
      'fixture-vless = vless, vless.example.com, 443, username=11111111-2222-3333-4444-555555555555, tls=true, sni=vless.example.com',
    );
    expect(body).toContain('[Proxy Group]');
    expect(body).toContain('🚀 节点选择 = select, fixture-ss, fixture-vless, HK 01 fast');
    expect(body).toContain(
      '♻️ 自动选择 = url-test, fixture-ss, fixture-vless, HK 01 fast, url = https://example.com/generate_204, interval = 120',
    );
    expect(body).toContain('🎯 全球直连 = select, DIRECT');
    expect(body).toContain('[Rule]');
    expect(body).toContain('GEOIP,CN,🎯 全球直连');
    expect(body).toContain('DOMAIN-SUFFIX,example.org,🚀 节点选择');
    expect(body).toContain('RULE-SET,https://rules.example.com/proxy.list,🚀 节点选择');
    expect(body).toContain('FINAL,🚀 节点选择');
    expect(body).toContain('[Host]\nlocalhost = 127.0.0.1');
  });

  it('applies the drops: relay group, GEOSITE, AND/QUIC and relay-targeted rule', async () => {
    const body = (await exportAs('shadowrocket-conf')).body;
    expect(body).not.toContain('🔗 中继');
    expect(body).not.toContain('relay.example.com');
    expect(body).not.toContain('GEOSITE');
    expect(body).not.toContain('AND,');
    expect(body).not.toContain('((NETWORK,UDP)');
  });

  it('sanitizes a comma/equals name in [Proxy] and in its group members', async () => {
    const body = (await exportAs('shadowrocket-conf')).body;
    expect(body).toContain(
      '[Proxy]\nfixture-ss = ss, example.com, 8388, aes-128-gcm, fake\nfixture-vless = vless, vless.example.com, 443, username=11111111-2222-3333-4444-555555555555, tls=true, sni=vless.example.com\nHK 01 fast = ss, hk.example.com, 8388, aes-128-gcm, fake-hk',
    );
    expect(body).toContain('🚀 节点选择 = select, fixture-ss, fixture-vless, HK 01 fast');
    expect(body).not.toContain('HK,01');
    expect(body).not.toContain('=fast');
    // No stray fields: the sanitized proxy line still has five comma fields.
    const proxyLine = body.split('\n').find((line) => line.startsWith('HK 01 fast = '))!;
    expect(proxyLine.split(' = ')[1]!.split(', ')).toHaveLength(5);
  });

  it('merges and translates the user custom rules, dropping untranslatable ones', async () => {
    const body = (await exportAs('shadowrocket-conf')).body;
    // The DOMAIN-SUFFIX custom rule is translated like any profile rule.
    expect(body).toContain('DOMAIN-SUFFIX,custom.example.com,🚀 节点选择');
    // Its GEOSITE sibling is dropped by the same rule-translation table.
    expect(body.match(/GEOSITE/g) ?? []).toHaveLength(0);
  });

  it('keeps the nodes-only shadowrocket export unchanged in shape', async () => {
    const response = await exportAs('shadowrocket');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['content-disposition']).toContain('-shadowrocket.txt');
    expect(response.body).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(response.body).not.toContain('[Proxy]');
    expect(parseSubscription(response.body).map((node) => node.name)).toEqual([
      'fixture-ss',
      'fixture-vless',
      'HK,01=fast',
    ]);
  });
});
