// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-request rule-profile override via a trailing profile-name segment.
 *
 * URL forms:
 * - `/s/:token/:target/:profile`  — explicit target + profile override
 * - `/s/:token/:profile`          — profile override + default (UA) target,
 *                                   only when the 2nd segment is not a target
 * - `/s/:token/:target`           — unchanged (assigned profile)
 *
 * The override drives everything the profile drives (groups, rules,
 * rule-providers, dnsTemplate, `[common] exclude_remarks`). Unknown names are a
 * 404 — no silent fallback — and a segment that is both is a *target* in
 * position 2.
 *
 * Rendering is exercised through the real H3 event shape
 * (`requestFromEvent`), because half the feature is the route/segment
 * resolution done there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { openDb, type SubhubDb } from '../server/db';
import { accessLogs, profiles, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import { sources } from '../server/db/schema';
import { requestFromEvent } from '../server/utils/export-handler';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { previewSubscription } from '../server/utils/admin-preview';
import { BUILTIN_DNS_TEMPLATE } from '../core';

const TOKEN = 'c'.repeat(32);
/** UA that resolves to `mihomo` (the export's default target). */
const DEFAULT_UA = 'subhub-test/1.0';

type MihomoDocument = {
  dns?: unknown;
  proxies: Array<{ name: string }>;
  'proxy-groups': Array<{ name: string; proxies: string[] }>;
  rules: string[];
};

/**
 * Six nodes: two of them info pseudo-nodes only profile B excludes, plus the
 * marker node only profile B keeps. Both profiles declare a distinct group so
 * the rendered group list identifies which profile was applied.
 */
const SOURCE_YAML = [
  'proxies:',
  '  - {name: "🇭🇰 香港 01", type: ss, server: hk.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '  - {name: "🇯🇵 日本 01", type: ss, server: jp.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '  - {name: "🇺🇸 美国 01", type: ss, server: us.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '  - {name: "B-ONLY 节点", type: ss, server: bo.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '  - {name: "剩余流量：1 TB", type: ss, server: a.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '  - {name: "套餐到期：2026", type: ss, server: b.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '',
].join('\n');

/** Profile A (assigned): group `group-a`, excludes only the 套餐到期 info node. */
const INI_A = [
  '[common]',
  'exclude_remarks=(套餐到期)',
  '',
  '[custom]',
  'custom_proxy_group=group-a`select`.*',
  'ruleset=group-a,[]MATCH',
].join('\n');

/** Profile B (override): group `group-b`, excludes the 剩余流量 info node. */
const INI_B = [
  '[common]',
  'exclude_remarks=(剩余流量)',
  '',
  '[custom]',
  'custom_proxy_group=group-b`select`.*',
  'ruleset=group-b,[]MATCH',
].join('\n');

const B_DNS_TEMPLATE = ['enable: true', 'nameserver:', '  - https://dns-b.example.net/dns-query'].join('\n');

const dirs: string[] = [];
let db: SubhubDb;
let userId: number;
let profileAId: number;
let profileBId: number;

beforeEach(() => {
  resetExportRateLimiter();
  const dir = mkdtempSync(join(tmpdir(), 'subhub-profile-suffix-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });

  userId = db
    .insert(users)
    .values({ name: 'suffix-user', token: TOKEN, enabled: true })
    .returning({ id: users.id })
    .get()!.id;

  profileAId = db
    .insert(profiles)
    .values({ name: 'v2', iniText: INI_A })
    .returning({ id: profiles.id })
    .get()!.id;
  profileBId = db
    .insert(profiles)
    .values({ name: 'v2o', iniText: INI_B, variant: 'legacy', dnsTemplate: B_DNS_TEMPLATE })
    .returning({ id: profiles.id })
    .get()!.id;
  // The user is assigned A; the URL may pick B per request.
  db.update(users).set({ profileId: profileAId }).where(eq(users.id, userId)).run();

  // One public source so every export sees the same nodes.
  db.insert(sources)
    .values({
      name: 'public-source',
      url: encrypt('placeholder-source-not-a-real-subscription'),
      type: 'local',
      cacheBlob: SOURCE_YAML,
      ownerUserId: null,
      accessMode: 'all',
    })
    .run();
});

afterEach(() => {
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The real route handler path: path -> `requestFromEvent` -> export. */
async function callPath(
  path: string,
  userAgent: string = DEFAULT_UA,
): Promise<{ status: number; body: string }> {
  const event = {
    path,
    context: {},
    node: {
      req: { headers: { 'user-agent': userAgent } },
      res: { statusCode: 200, setHeader() {} },
    },
  };
  const result = await handleSubscriptionExport(requestFromEvent(event as never), { db });
  return { status: result.status, body: result.body };
}

function groupNames(body: string): string[] {
  const document = parseYaml(body) as MihomoDocument;
  return document['proxy-groups'].map((group) => group.name);
}

function proxyNames(body: string): string[] {
  return (parseYaml(body) as MihomoDocument).proxies.map((proxy) => proxy.name);
}

describe('GET /s/:token/:target/:profile', () => {
  it('renders the named profile instead of the assigned one (clash)', async () => {
    const overridden = await callPath(`/s/${TOKEN}/clash/v2o`);
    expect(overridden.status).toBe(200);
    expect(groupNames(overridden.body)).toEqual(['group-b']);
    // B's exclude_remarks applies: 剩余流量 dropped, 套餐到期 kept.
    expect(proxyNames(overridden.body)).toContain('套餐到期：2026');
    expect(proxyNames(overridden.body)).not.toContain('剩余流量：1 TB');
    // The override also drives the profile dnsTemplate (B has one).
    expect((parseYaml(overridden.body) as MihomoDocument).dns).toEqual({
      enable: true,
      nameserver: ['https://dns-b.example.net/dns-query'],
    });
    // ... and B's rules, expanded from B's groups.
    expect((parseYaml(overridden.body) as MihomoDocument).rules).toContain('MATCH,group-b');
  });

  it('keeps /s/:token/:target on the assigned profile, byte for byte', async () => {
    const assigned = await callPath(`/s/${TOKEN}/clash`);
    expect(assigned.status).toBe(200);
    expect(groupNames(assigned.body)).toEqual(['group-a']);
    // A's exclude_remarks applies: 套餐到期 dropped, 剩余流量 kept.
    expect(proxyNames(assigned.body)).toContain('剩余流量：1 TB');
    expect(proxyNames(assigned.body)).not.toContain('套餐到期：2026');
    expect((parseYaml(assigned.body) as MihomoDocument).dns).toEqual(BUILTIN_DNS_TEMPLATE);
    expect((parseYaml(assigned.body) as MihomoDocument).rules).toContain('MATCH,group-a');

    // Same URL shape, no override: identical to an explicit assigned-profile
    // selection but NOT to the override.
    const explicitA = await callPath(`/s/${TOKEN}/clash/v2`);
    expect(explicitA.body).toBe(assigned.body);
    expect(overriddenBodyDiffers(assigned.body, (await callPath(`/s/${TOKEN}/clash/v2o`)).body)).toBe(true);
  });

  it('applies the override to every target profile capability', async () => {
    // surge consumes profile groups only; B's group must be the one listed.
    const surge = await callPath(`/s/${TOKEN}/surge/v2o`);
    expect(surge.status).toBe(200);
    expect(surge.body).toContain('group-b');
    expect(surge.body).not.toContain('group-a');

    // shadowrocket is nodes-only but still honours exclude_remarks.
    const shadowrocket = await callPath(`/s/${TOKEN}/shadowrocket/v2o`);
    expect(shadowrocket.status).toBe(200);
    const links = Buffer.from(shadowrocket.body, 'base64').toString('utf8').split('\n');
    expect(links.some((link) => link.includes(encodeURIComponent('剩余流量')))).toBe(false);
    expect(links.some((link) => link.includes('japanese-marker') || link.includes(encodeURIComponent('套餐到期')))).toBe(
      true,
    );
  });

  it('answers 404 for an unknown profile name (no fallback)', async () => {
    const response = await callPath(`/s/${TOKEN}/clash/nope`);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('group-a');
    expect(response.body).not.toContain('group-b');
    // Logged like any other failed export.
    const log = db.select().from(accessLogs).all().at(-1);
    expect(log).toMatchObject({ userId, target: 'clash', status: 404 });
  });

  it('matches profile names exactly (case-sensitive)', async () => {
    expect((await callPath(`/s/${TOKEN}/clash/V2O`)).status).toBe(404);
    expect((await callPath(`/s/${TOKEN}/clash/v2`)).status).toBe(200);
  });

  it('still rejects an unknown target before looking at the profile', async () => {
    const response = await callPath(`/s/${TOKEN}/garbage/v2o`);
    expect(response.status).toBe(400);
  });
});

describe('GET /s/:token/:profile (form 2)', () => {
  it('applies the override with the default target', async () => {
    const form2 = await callPath(`/s/${TOKEN}/v2o`);
    expect(form2.status).toBe(200);
    expect(groupNames(form2.body)).toEqual(['group-b']);
    // Default target comes from the User-Agent, exactly like bare /s/:token.
    const bareDefault = await callPath(`/s/${TOKEN}`);
    expect(form2.body).toBe((await callPath(`/s/${TOKEN}/mihomo/v2o`)).body);
    // Without the suffix the default-target export still uses A.
    expect(groupNames(bareDefault.body)).toEqual(['group-a']);
  });

  it('lets the User-Agent pick the target for form 2', async () => {
    const shadowrocket = await callPath(`/s/${TOKEN}/v2o`, 'Shadowrocket/1.0');
    expect(shadowrocket.status).toBe(200);
    // Shadowrocket bodies are base64 link lists, not YAML.
    expect(() => Buffer.from(shadowrocket.body, 'base64').toString('utf8')).not.toThrow();
    expect(shadowrocket.body).not.toContain('proxy-groups');
  });

  it('answers 404 for a 2nd segment that is neither target nor profile', async () => {
    // Not a target -> the 2nd segment is taken as the profile override; an
    // unknown name is a 404 (never a silent fallback to the assigned profile).
    expect((await callPath(`/s/${TOKEN}/garbage`)).status).toBe(404);
  });
});

describe('target wins in position 2', () => {
  let targetNamedProfileId: number;

  beforeEach(() => {
    // A profile deliberately named like an export target, with its own group.
    targetNamedProfileId = db
      .insert(profiles)
      .values({
        name: 'clash',
        iniText: ['[custom]', 'custom_proxy_group=group-clash`select`.*', 'ruleset=group-clash,[]MATCH'].join('\n'),
      })
      .returning({ id: profiles.id })
      .get()!.id;
  });

  it('resolves /s/:token/clash as the clash target with the assigned profile', async () => {
    const response = await callPath(`/s/${TOKEN}/clash`);
    expect(response.status).toBe(200);
    expect(groupNames(response.body)).toEqual(['group-a']);
  });

  it('addresses the target-named profile in position 3', async () => {
    const response = await callPath(`/s/${TOKEN}/clash/clash`);
    expect(response.status).toBe(200);
    expect(groupNames(response.body)).toEqual(['group-clash']);
    // The profile id is real and distinct from the assigned one.
    expect(targetNamedProfileId).not.toBe(profileAId);
  });

  it('keeps the bare default export unchanged when a profile shadows a target', async () => {
    const response = await callPath(`/s/${TOKEN}`);
    expect(response.status).toBe(200);
    expect(groupNames(response.body)).toEqual(['group-a']);
  });
});

describe('segment parsing (requestFromEvent)', () => {
  function parse(path: string) {
    const event = {
      path,
      context: {},
      node: { req: { headers: {} }, res: { statusCode: 200, setHeader() {} } },
    };
    return requestFromEvent(event as never);
  }

  it('keeps the two pre-existing forms unchanged', () => {
    expect(parse(`/s/${TOKEN}`)).toMatchObject({ target: null, profile: null });
    expect(parse(`/s/${TOKEN}/clash`)).toMatchObject({ target: 'clash', profile: null });
  });

  it('parses the three-segment form and prefers Nitro params', () => {
    expect(parse(`/s/${TOKEN}/clash/v2o`)).toMatchObject({ target: 'clash', profile: 'v2o' });
    const event = {
      path: `/s/${TOKEN}/clash/v2o`,
      context: { params: { token: TOKEN, target: 'clash', profile: 'v2o' } },
      node: { req: { headers: {} }, res: { statusCode: 200, setHeader() {} } },
    };
    expect(requestFromEvent(event as never)).toMatchObject({ target: 'clash', profile: 'v2o' });
  });

  it('treats a non-target 2nd segment as the profile (form 2)', () => {
    // The shape is not decided here: the 2nd segment stays the raw target and
    // `handleSubscriptionExport` resolves it — profile first, then the target
    // checks (`v2o` is a profile; `garbage` is neither -> 400, as today).
    expect(parse(`/s/${TOKEN}/v2o`)).toMatchObject({ target: 'v2o', profile: 'v2o' });
  });

  it('passes an unknown 2nd segment through as the raw target (today\'s 400)', () => {
    expect(parse(`/s/${TOKEN}/garbage`)).toMatchObject({ target: 'garbage', profile: 'garbage' });
  });

  it('ignores a trailing slash / empty segments', () => {
    expect(parse(`/s/${TOKEN}/clash/`)).toMatchObject({ target: 'clash', profile: null });
    expect(parse(`/s/${TOKEN}/clash//`)).toMatchObject({ target: 'clash', profile: null });
  });
});

describe('POST /api/admin/preview &profile=', () => {
  it('renders the same body as the suffixed export', async () => {
    const preview = await previewSubscription(db, { userId, target: 'clash', profile: 'v2o' });
    const exported = await callPath(`/s/${TOKEN}/clash/v2o`);
    expect(preview.status).toBe(200);
    expect(preview.body).toBe(exported.body);
    expect(preview.profile).toBe('v2o');

    // Without the override the preview matches /s/:token/clash.
    const assigned = await previewSubscription(db, { userId, target: 'clash' });
    expect(assigned.body).toBe((await callPath(`/s/${TOKEN}/clash`)).body);
    expect(assigned.profile).toBeNull();
  });

  it('answers 404 for an unknown profile name', async () => {
    await expect(
      previewSubscription(db, { userId, target: 'clash', profile: 'nope' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a non-string profile', async () => {
    await expect(previewSubscription(db, { userId, profile: 5 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

/** True when the two bodies differ (helper keeps the intent readable). */
function overriddenBodyDiffers(a: string, b: string): boolean {
  return a !== b;
}
