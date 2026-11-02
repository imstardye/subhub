// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Opt-in built-in Tailscale outbound (`feat/tailscale`).
 *
 * Covers the pure hostname helper, the core injection (`produceMihomo` /
 * `stringifyMihomoConfig`), the write-only save path and user API, the admin
 * clear-only surface, and the export handler (`?tailscale=1`) end to end. The
 * rule: without the parameter nothing changes byte-for-byte; the key itself
 * never leaves the server (only `tailscaleKeySet`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  QUIC_BLOCK_RULE,
  TAILSCALE_GROUP_NAME,
  TAILSCALE_PROXY_NAME,
  TAILSCALE_RULES,
  buildTailscaleHostname,
  buildTailscaleInjection,
  produceMihomo,
  resolveTailscaleDialerProxy,
  stringifyMihomoConfig,
  type ProxyNode,
} from '../core';
import { openDb, type SubhubDb } from '../server/db';
import { encrypt } from '../server/db/crypto';
import { profiles, sources, users } from '../server/db/schema';import {
  TAILSCALE_KEY_MAX_LENGTH,
  clearUserTailscaleKey,
  readUserTailscaleKey,
  setUserTailscaleKey,
} from '../server/utils/tailscale';
import {
  loadTailscaleDialerGroups,
  tailscaleDialerGroupsFromIni,
} from '../server/utils/tailscale-dialer';
import { toAdminUser, updateUser } from '../server/utils/admin-users';
import { tailscaleDialerSelectOptions, tailscaleDialerSelectable } from '../core/utils/user-center';
import { loadUserCenterData } from '../server/utils/user-center';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { isTailscaleRequested, requestFromEvent } from '../server/utils/export-handler';
import { hashPassword } from '../server/utils/user-password';
import { issueUserSession, USER_SESSION_COOKIE } from '../server/utils/user-session';
import userTailscaleKeyHandler from '../server/api/user/[token]/tailscale-key.put';
import userTailscaleDialerHandler from '../server/api/user/[token]/tailscale-dialer.put';
import { makeApiEvent } from './helpers/admin-api';
import type { AdminApiEvent } from '../server/utils/admin-api';

const TOKEN = 'a'.repeat(32);
const PASSWORD = 'tailscale-test-password';
const AUTH_KEY = 'tskey-auth-k1234567890CNTRL-abcdefghijklmnop';
const NODE_NAME = 'fixture-ss';

function cacheWith(name = NODE_NAME): string {
  return [
    'proxies:',
    `  - {name: "${name}", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}`,
    '',
  ].join('\n');
}

const dirs: string[] = [];
let db: SubhubDb;
let userId: number;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'subhub-tailscale-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
  userId = db
    .insert(users)
    .values({
      name: 'Alice Wong',
      token: TOKEN,
      enabled: true,
      passwordHash: hashPassword(PASSWORD),
      passwordVersion: 1,
    })
    .returning({ id: users.id })
    .get()!.id;
  db.insert(sources)
    .values({
      name: 'public-source',
      url: encrypt('https://source.example.com/sub'),
      type: 'remote',
      ownerUserId: null,
      cacheBlob: cacheWith(),
    })
    .run();
});

afterEach(() => {
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function userRow() {
  return db.select().from(users).where(eq(users.id, userId)).get()!;
}

describe('tailscale hostname helper', () => {
  it('lowercases, collapses non [a-z0-9] runs, trims and prefixes', () => {
    expect(buildTailscaleHostname('Alice Wong')).toBe('subhub-alice-wong');
    expect(buildTailscaleHostname('Foo_Bar!!Baz')).toBe('subhub-foo-bar-baz');
    expect(buildTailscaleHostname('  --Hello--  ')).toBe('subhub-hello');
    expect(buildTailscaleHostname('小明')).toBe('subhub-node');
    expect(buildTailscaleHostname('')).toBe('subhub-node');
    expect(buildTailscaleHostname('   ')).toBe('subhub-node');
    expect(buildTailscaleHostname(null)).toBe('subhub-node');
  });

  it('caps the hostname at 40 chars and never leaves a trailing dash', () => {
    const hostname = buildTailscaleHostname('A'.repeat(100));
    expect(hostname).toHaveLength(40);
    expect(hostname.startsWith('subhub-')).toBe(true);
    expect(hostname.endsWith('-')).toBe(false);
    expect(buildTailscaleHostname('x-'.repeat(30)).endsWith('-')).toBe(false);
  });
});

function mihomoDoc(nodes: ProxyNode[], options: Parameters<typeof produceMihomo>[1] = {}) {
  return parseYaml(produceMihomo(nodes, options)) as {
    proxies: Array<Record<string, unknown>>;
    rules?: string[];
    'proxy-groups'?: Array<{ name: string; type: string; proxies: string[] }>;
  };
}

const node = (name = NODE_NAME): ProxyNode => ({
  name,
  type: 'ss',
  server: 'example.com',
  port: 8388,
} as ProxyNode);

describe('produceMihomo tailscale injection', () => {
  it('appends the proxy/group and the two head rules without an auth key', () => {
    const document = mihomoDoc([node()], { tailscale: { hostname: 'subhub-alice-wong' } });

    expect(document.proxies).toHaveLength(2);
    expect(document.proxies[1]).toEqual({
      name: TAILSCALE_PROXY_NAME,
      type: 'tailscale',
      hostname: 'subhub-alice-wong',
      'state-dir': './tailscale',
      ephemeral: false,
      udp: true,
      'accept-routes': true,
    });
    // No `auth-key` field at all when the user has not bound one.
    expect(document.proxies[1]).not.toHaveProperty('auth-key');
    expect(document['proxy-groups']).toEqual([
      { name: TAILSCALE_GROUP_NAME, type: 'select', proxies: [TAILSCALE_PROXY_NAME, 'DIRECT'] },
    ]);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, ...TAILSCALE_RULES]);
  });

  it('emits the auth-key when one is provided', () => {
    const document = mihomoDoc([node()], {
      tailscale: { hostname: 'subhub-alice-wong', authKey: AUTH_KEY },
    });
    expect(document.proxies[1]!['auth-key']).toBe(AUTH_KEY);
  });

  it('skips injection when a node already owns the reserved name', () => {
    const document = mihomoDoc([node('Tailscale')], {
      tailscale: { hostname: 'subhub-alice-wong' },
    });
    expect(document.proxies).toHaveLength(1);
    expect(document.proxies[0]!.name).toBe('Tailscale');
    expect(document.proxies[0]!.type).toBe('ss');
    expect(document['proxy-groups']).toBeUndefined();
    expect(document.rules).toEqual([QUIC_BLOCK_RULE]);
  });

  it('is byte-identical when the option is absent', () => {
    const plain = produceMihomo([node()]);
    expect(produceMihomo([node()], {})).toBe(plain);
    expect(produceMihomo([node()], { tailscale: undefined })).toBe(plain);
    expect(plain).not.toContain('tailscale');
    expect(plain).not.toContain(TAILSCALE_GROUP_NAME);
  });

  it('inserts the rules after the QUIC block and before profile rules', () => {
    // `stringifyMihomoConfig` is the shared assembler both render paths use;
    // `produceMihomo` calls it for the no-profile case.
    const body = stringifyMihomoConfig(
      [node()],
      {},
      ['MATCH,DIRECT'],
      { rules: TAILSCALE_RULES },
    );
    const document = parseYaml(body) as { rules: string[] };
    expect(document.rules).toEqual([
      QUIC_BLOCK_RULE,
      ...TAILSCALE_RULES,
      'MATCH,DIRECT',
    ]);
  });
});

describe('tailscale save path', () => {
  it('encrypts on write, never stores plaintext, and reports the DTO state', () => {
    expect(setUserTailscaleKey(db, userId, `  ${AUTH_KEY}  `)).toEqual({ tailscaleKeySet: true });
    const stored = userRow().tailscaleAuthKey;
    expect(stored).toBeTruthy();
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(AUTH_KEY);
    expect(readUserTailscaleKey(userRow())).toBe(AUTH_KEY);
  });

  it('clears with a blank string and via clearUserTailscaleKey', () => {
    setUserTailscaleKey(db, userId, AUTH_KEY);
    expect(setUserTailscaleKey(db, userId, '   ')).toEqual({ tailscaleKeySet: false });
    expect(userRow().tailscaleAuthKey).toBeNull();

    setUserTailscaleKey(db, userId, AUTH_KEY);
    expect(clearUserTailscaleKey(db, userId)).toEqual({ tailscaleKeySet: false });
    expect(userRow().tailscaleAuthKey).toBeNull();
  });

  it('rejects a non-string and an over-length key with a 400', () => {
    expect(() => setUserTailscaleKey(db, userId, 123)).toThrowError(/authKey must be a string/);
    expect(() => setUserTailscaleKey(db, userId, 'x'.repeat(TAILSCALE_KEY_MAX_LENGTH + 1)))
      .toThrowError(/at most/);
    try {
      setUserTailscaleKey(db, userId, 'x'.repeat(TAILSCALE_KEY_MAX_LENGTH + 1));
    } catch (error) {
      expect((error as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it('treats a decrypt failure as unbound instead of throwing', () => {
    db.update(users).set({ tailscaleAuthKey: 'v1:not-real-ciphertext' }).where(eq(users.id, userId)).run();
    expect(readUserTailscaleKey(userRow())).toBeNull();
  });
});

async function callTailscalePut(
  body: unknown,
  behavior: { session?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { event } = makeApiEvent({
    url: `/api/user/${TOKEN}/tailscale-key`,
    method: 'PUT',
    body,
  });
  if (behavior.session !== false) {
    const session = issueUserSession({ id: userId, passwordVersion: 1 });
    event.node.req.headers.cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
  }
  const result = (await userTailscaleKeyHandler(event as AdminApiEvent, { db })) as Record<
    string,
    unknown
  >;
  return { status: event.node.res.statusCode, body: result };
}

describe('user API PUT /api/user/:token/tailscale-key', () => {
  it('is locked without a valid /my session', async () => {
    const result = await callTailscalePut({ authKey: AUTH_KEY }, { session: false });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ status: 'needs-password' });
  });

  it('binds a key and answers only { tailscaleKeySet }', async () => {
    const result = await callTailscalePut({ authKey: AUTH_KEY });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tailscaleKeySet: true });
    expect(JSON.stringify(result.body)).not.toContain('tskey');
    expect(userRow().tailscaleAuthKey).toMatch(/^v1:/);
  });

  it('clears with an empty string', async () => {
    await callTailscalePut({ authKey: AUTH_KEY });
    const result = await callTailscalePut({ authKey: '' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tailscaleKeySet: false });
    expect(userRow().tailscaleAuthKey).toBeNull();
  });

  it('rejects an over-length key with 400 and leaves the binding untouched', async () => {
    await callTailscalePut({ authKey: AUTH_KEY });
    const result = await callTailscalePut({ authKey: 'x'.repeat(TAILSCALE_KEY_MAX_LENGTH + 1) });
    expect(result.status).toBe(400);
    expect(readUserTailscaleKey(userRow())).toBe(AUTH_KEY);
  });

  it('never exposes the key in the /my payload', async () => {
    await callTailscalePut({ authKey: AUTH_KEY });
    const data = loadUserCenterData(db, TOKEN);
    expect('tailscaleKeySet' in data && data.tailscaleKeySet).toBe(true);
    expect(JSON.stringify(data)).not.toContain(AUTH_KEY);
    expect(JSON.stringify(data)).not.toContain('tskey');
  });
});

describe('admin clear-only surface', () => {
  it('reports tailscaleKeySet and never the key', () => {
    setUserTailscaleKey(db, userId, AUTH_KEY);
    const dto = toAdminUser(userRow());
    expect(dto.tailscaleKeySet).toBe(true);
    expect(JSON.stringify(dto)).not.toContain(AUTH_KEY);
    expect(JSON.stringify(dto)).not.toContain('tskey');
  });

  it('clears via updateUser and refuses a non-empty value', async () => {
    setUserTailscaleKey(db, userId, AUTH_KEY);
    const cleared = await updateUser(db, userId, { tailscaleAuthKey: '' });
    expect(cleared.tailscaleKeySet).toBe(false);
    expect(userRow().tailscaleAuthKey).toBeNull();

    await expect(updateUser(db, userId, { tailscaleAuthKey: AUTH_KEY })).rejects.toThrow(
      /can only be cleared/,
    );
  });
});

function eventFor(path: string, userAgent = 'clash-verge/v2.0') {
  return {
    path,
    context: {},
    node: {
      req: { headers: { 'user-agent': userAgent } },
      res: { statusCode: 200, setHeader() {} },
    },
  };
}

async function exportPath(path: string, userAgent?: string) {
  resetExportRateLimiter();
  return handleSubscriptionExport(requestFromEvent(eventFor(path, userAgent) as never), { db });
}

describe('export handler ?tailscale=1', () => {
  it('recognises only 1/true', () => {
    for (const value of ['1', 'true', ' TRUE ', 'True']) expect(isTailscaleRequested(value)).toBe(true);
    for (const value of [null, undefined, '', '0', 'false', 'yes', 'on', '2']) {
      expect(isTailscaleRequested(value as string | null | undefined)).toBe(false);
    }
  });

  it('injects into mihomo only when the parameter is present', async () => {
    const plain = await exportPath(`/s/${TOKEN}/mihomo`);
    expect(plain.status).toBe(200);
    const withoutParam = parseYaml(plain.body) as { proxies: Array<{ name: string }> };
    expect(withoutParam.proxies.map((p) => p.name)).toEqual([NODE_NAME]);

    const withParam = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    const injected = parseYaml(withParam.body) as {
      proxies: Array<Record<string, unknown>>;
      rules: string[];
      'proxy-groups': Array<{ name: string; proxies: string[] }>;
    };
    expect(injected.proxies.map((p) => p.name)).toEqual([NODE_NAME, TAILSCALE_PROXY_NAME]);
    expect(injected.proxies[1]).toMatchObject({ type: 'tailscale', hostname: 'subhub-alice-wong' });
    expect(injected.rules).toEqual([QUIC_BLOCK_RULE, ...TAILSCALE_RULES]);
    expect(injected['proxy-groups'][0]).toEqual({
      name: TAILSCALE_GROUP_NAME,
      type: 'select',
      proxies: [TAILSCALE_PROXY_NAME, 'DIRECT'],
    });
  });

  it('puts the bound key in the mihomo config and changed nothing elsewhere', async () => {
    setUserTailscaleKey(db, userId, AUTH_KEY);
    const result = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    expect(result.body).toContain(AUTH_KEY);
    const document = parseYaml(result.body) as { proxies: Array<Record<string, unknown>> };
    expect(document.proxies[1]!['auth-key']).toBe(AUTH_KEY);
  });

  it('ignores the parameter for non-mihomo/clash targets', async () => {
    for (const target of ['surge', 'uri', 'singbox', 'loon', 'shadowrocket']) {
      const ua = target === 'uri' ? 'curl/8' : 'clash-verge/v2.0';
      const plain = await exportPath(`/s/${TOKEN}/${target}`, ua);
      const flagged = await exportPath(`/s/${TOKEN}/${target}?tailscale=1`, ua);
      expect(flagged.status).toBe(200);
      expect(flagged.body).toBe(plain.body);
      expect(flagged.body).not.toContain(TAILSCALE_GROUP_NAME);
    }
  });

  it('applies the profile render with the injection ordered correctly', async () => {
    db.insert(profiles)
      .values({
        name: 'fixture-profile',
        iniText: [
          '[custom]',
          'custom_proxy_group=🚀 节点选择`select`.*',
          'ruleset=🚀 节点选择,[]MATCH',
        ].join('\n'),
      })
      .run();
    const profileId = db.select({ id: profiles.id }).from(profiles).get()!.id;
    db.update(users).set({ profileId }).where(eq(users.id, userId)).run();

    const result = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    const document = parseYaml(result.body) as {
      proxies: Array<{ name: string }>;
      rules: string[];
      'proxy-groups': Array<{ name: string }>;
    };
    expect(document.proxies.map((p) => p.name)).toEqual([NODE_NAME, TAILSCALE_PROXY_NAME]);
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, ...TAILSCALE_RULES, 'MATCH,🚀 节点选择']);
    expect(document['proxy-groups'].map((g) => g.name)).toEqual(['🚀 节点选择', TAILSCALE_GROUP_NAME]);
  });

  it('skips injection when a profile group owns the reserved name', async () => {
    db.insert(profiles)
      .values({
        name: 'reserved-group',
        iniText: [
          '[custom]',
          'custom_proxy_group=🔗 Tailscale`select`.*',
          'ruleset=🔗 Tailscale,[]MATCH',
        ].join('\n'),
      })
      .run();
    const profileId = db.select({ id: profiles.id }).from(profiles).get()!.id;
    db.update(users).set({ profileId }).where(eq(users.id, userId)).run();

    const result = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    const document = parseYaml(result.body) as {
      proxies: Array<{ name: string }>;
      'proxy-groups': Array<{ name: string }>;
    };
    expect(document.proxies.map((p) => p.name)).toEqual([NODE_NAME]);
    expect(document['proxy-groups'].map((g) => g.name)).toEqual([TAILSCALE_GROUP_NAME]);
    // No duplicate group and no injected tailscale proxy.
    expect(document['proxy-groups']).toHaveLength(1);
  });
});

/* --------------------------------------------------------------------------
 * dialer-proxy: route the Tailscale control connection through a policy group
 * ------------------------------------------------------------------------ */

/**
 * A profile whose groups all survive a render of `fixture-ss` (the reserved
 * `🔗 Tailscale` name is only *declared* here so the derivation can be shown to
 * exclude it; exporting assigns a variant without it, see `assignExportProfile`).
 */
const DIALER_PROFILE_INI = [
  '[custom]',
  'custom_proxy_group=🚀 节点选择`select`.*',
  'custom_proxy_group=🔗 备用链路`select`fixture-ss',
  'custom_proxy_group=🔗 Tailscale`select`.*',
  'ruleset=🚀 节点选择,[]MATCH',
].join('\n');

/** The same profile without the reserved-name group (safe to export). */
const EXPORT_PROFILE_INI = [
  '[custom]',
  'custom_proxy_group=🚀 节点选择`select`.*',
  'custom_proxy_group=🔗 备用链路`select`fixture-ss',
  'ruleset=🚀 节点选择,[]MATCH',
].join('\n');

function assignProfile(iniText: string, name = 'dialer-profile'): number {
  db.insert(profiles).values({ name, iniText }).run();
  const profileId = db.select({ id: profiles.id }).from(profiles).get()!.id;
  db.update(users).set({ profileId }).where(eq(users.id, userId)).run();
  return profileId;
}

describe('buildTailscaleInjection dialer-proxy', () => {
  const groups = ['🚀 节点选择', '🔗 备用链路'];

  it('emits dialer-proxy after accept-routes when the group is emitted', () => {
    const injected = buildTailscaleInjection(
      { hostname: 'subhub-alice-wong', dialerProxy: '🚀 节点选择' },
      [NODE_NAME],
      groups,
    );
    const proxy = injected!.proxy as unknown as Record<string, unknown>;
    expect(proxy['dialer-proxy']).toBe('🚀 节点选择');
    expect(Object.keys(proxy)).toEqual([
      'name',
      'type',
      'hostname',
      'state-dir',
      'ephemeral',
      'udp',
      'accept-routes',
      'dialer-proxy',
    ]);

    const second = buildTailscaleInjection(
      { hostname: 'subhub-alice-wong', dialerProxy: '🔗 备用链路' },
      [NODE_NAME],
      groups,
    );
    expect(second?.proxy['dialer-proxy']).toBe('🔗 备用链路');
  });

  it('omits the field when the group is not among the emitted groups', () => {
    const injected = buildTailscaleInjection(
      { hostname: 'subhub-alice-wong', dialerProxy: '不存在的组' },
      [NODE_NAME],
      groups,
    );
    expect(injected).not.toBeNull();
    expect(injected!.proxy).not.toHaveProperty('dialer-proxy');
  });

  it('never emits a reserved Tailscale name even if it is in the group list', () => {
    for (const name of [TAILSCALE_PROXY_NAME, TAILSCALE_GROUP_NAME]) {
      expect(resolveTailscaleDialerProxy(name, [...groups, name])).toBeNull();
    }
    // (A group named 🔗 Tailscale would also skip the whole injection — that
    // guard is covered above; the proxy name is a node name, not a group.)
    expect(resolveTailscaleDialerProxy(` ${TAILSCALE_PROXY_NAME} `, [TAILSCALE_PROXY_NAME])).toBeNull();
    expect(resolveTailscaleDialerProxy('🚀 节点选择', groups)).toBe('🚀 节点选择');
  });

  it('omits the field when unset, blank or null', () => {
    for (const dialerProxy of [undefined, null, '', '   ']) {
      const injected = buildTailscaleInjection(
        { hostname: 'subhub-alice-wong', dialerProxy: dialerProxy as string | undefined },
        [NODE_NAME],
        groups,
      );
      expect(injected?.proxy).not.toHaveProperty('dialer-proxy');
    }
  });

  it('is byte-identical to the no-dialer output when nothing is configured', () => {
    const plain = produceMihomo([node()], { tailscale: { hostname: 'subhub-alice-wong' } });
    expect(plain).not.toContain('dialer-proxy');
    const absent = produceMihomo([node()], {
      tailscale: { hostname: 'subhub-alice-wong', dialerProxy: undefined },
    });
    expect(absent).toBe(plain);
    // A configured dialer on a group-less render (no-profile path) is dropped.
    const noGroups = produceMihomo([node()], {
      tailscale: { hostname: 'subhub-alice-wong', dialerProxy: '🚀 节点选择' },
    });
    expect(noGroups).toBe(plain);
  });
});

describe('tailscale dialer allowed-set derivation', () => {
  it('lists the INI groups minus reserved names, relay groups and duplicates', () => {
    expect(tailscaleDialerGroupsFromIni(DIALER_PROFILE_INI)).toEqual([
      '🚀 节点选择',
      '🔗 备用链路',
    ]);
    expect(tailscaleDialerGroupsFromIni([
      'custom_proxy_group=A`select`.*',
      'custom_proxy_group=Chain`relay`A`B',
      'custom_proxy_group=A`select`.*',
      'custom_proxy_group=Tailscale`select`.*',
      'custom_proxy_group=🔗 Tailscale`select`.*',
    ].join('\n'))).toEqual(['A']);
    expect(tailscaleDialerGroupsFromIni(null)).toEqual([]);
    expect(tailscaleDialerGroupsFromIni('')).toEqual([]);
  });

  it('gives a profile-less user an empty option set', () => {
    expect(loadTailscaleDialerGroups(db, userRow())).toEqual([]);
  });
});

async function callDialerPut(
  body: unknown,
  behavior: { session?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { event } = makeApiEvent({
    url: `/api/user/${TOKEN}/tailscale-dialer`,
    method: 'PUT',
    body,
  });
  if (behavior.session !== false) {
    const session = issueUserSession({ id: userId, passwordVersion: 1 });
    event.node.req.headers.cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
  }
  const result = (await userTailscaleDialerHandler(event as AdminApiEvent, { db })) as Record<
    string,
    unknown
  >;
  return { status: event.node.res.statusCode, body: result };
}

describe('user API PUT /api/user/:token/tailscale-dialer', () => {
  beforeEach(() => {
    assignProfile(DIALER_PROFILE_INI);
  });

  it('is locked without a valid /my session', async () => {
    const result = await callDialerPut({ group: '🚀 节点选择' }, { session: false });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ status: 'needs-password' });
  });

  it('stores a valid group and the /my payload reflects it', async () => {
    const result = await callDialerPut({ group: '🚀 节点选择' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      tailscaleDialerProxy: '🚀 节点选择',
      tailscaleDialerOptions: ['🚀 节点选择', '🔗 备用链路'],
    });
    expect(userRow().tailscaleDialerProxy).toBe('🚀 节点选择');
    const data = loadUserCenterData(db, TOKEN) as {
      tailscaleDialerProxy: string | null;
      tailscaleDialerOptions: string[];
    };
    expect(data.tailscaleDialerProxy).toBe('🚀 节点选择');
    expect(data.tailscaleDialerOptions).toEqual(['🚀 节点选择', '🔗 备用链路']);
  });

  it('rejects an unknown or reserved group with 400 and keeps the value', async () => {
    await callDialerPut({ group: '🚀 节点选择' });
    for (const group of ['不存在的组', '🔗 Tailscale', 'Tailscale', 'DIRECT', '.*']) {
      const result = await callDialerPut({ group });
      expect(result.status).toBe(400);
    }
    expect(userRow().tailscaleDialerProxy).toBe('🚀 节点选择');
  });

  it('rejects a non-string group with 400', async () => {
    const result = await callDialerPut({ group: 42 });
    expect(result.status).toBe(400);
  });

  it('clears with null and with a blank string', async () => {
    await callDialerPut({ group: '🔗 备用链路' });
    const cleared = await callDialerPut({ group: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tailscaleDialerProxy).toBeNull();
    expect(userRow().tailscaleDialerProxy).toBeNull();

    await callDialerPut({ group: '🔗 备用链路' });
    const blank = await callDialerPut({ group: '  ' });
    expect(blank.status).toBe(200);
    expect(userRow().tailscaleDialerProxy).toBeNull();
  });

  it('refuses any group for a profile-less user and offers only 直连', async () => {
    db.update(users).set({ profileId: null }).where(eq(users.id, userId)).run();
    const data = loadUserCenterData(db, TOKEN) as {
      tailscaleDialerProxy: string | null;
      tailscaleDialerOptions: string[];
    };
    expect(data.tailscaleDialerOptions).toEqual([]);
    const result = await callDialerPut({ group: '🚀 节点选择' });
    expect(result.status).toBe(400);
  });

  it('keeps the stored choice visible while the key state changes', async () => {
    await callTailscalePut({ authKey: AUTH_KEY });
    await callDialerPut({ group: '🚀 节点选择' });
    await callTailscalePut({ authKey: '' });
    const data = loadUserCenterData(db, TOKEN) as {
      tailscaleKeySet: boolean;
      tailscaleDialerProxy: string | null;
    };
    expect(data.tailscaleKeySet).toBe(false);
    expect(data.tailscaleDialerProxy).toBe('🚀 节点选择');
  });
});

describe('/my GET payload tailscale dialer options', () => {
  it('derives them from the assigned profile and excludes the reserved names', () => {
    assignProfile(DIALER_PROFILE_INI);
    const data = loadUserCenterData(db, TOKEN) as {
      tailscaleDialerProxy: string | null;
      tailscaleDialerOptions: string[];
    };
    expect(data.tailscaleDialerProxy).toBeNull();
    expect(data.tailscaleDialerOptions).toEqual(['🚀 节点选择', '🔗 备用链路']);
    expect(data.tailscaleDialerOptions).not.toContain(TAILSCALE_GROUP_NAME);
    expect(data.tailscaleDialerOptions).not.toContain(TAILSCALE_PROXY_NAME);
  });

  it('select options put 直连 first and are disabled without groups', () => {
    expect(tailscaleDialerSelectOptions([])).toEqual([{ label: '直连', value: null }]);
    expect(tailscaleDialerSelectOptions(['A', 'B'])).toEqual([
      { label: '直连', value: null },
      { label: 'A', value: 'A' },
      { label: 'B', value: 'B' },
    ]);
    expect(tailscaleDialerSelectable([])).toBe(false);
    expect(tailscaleDialerSelectable(['A'])).toBe(true);
  });
});

describe('export handler dialer-proxy', () => {
  it('emits dialer-proxy for a stored group that survives the render', async () => {
    assignProfile(EXPORT_PROFILE_INI);
    await callDialerPut({ group: '🚀 节点选择' });

    const result = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    expect(result.status).toBe(200);
    const document = parseYaml(result.body) as {
      proxies: Array<Record<string, unknown>>;
      rules: string[];
      'proxy-groups': Array<{ name: string }>;
    };
    expect(document.proxies[1]).toMatchObject({
      name: TAILSCALE_PROXY_NAME,
      'dialer-proxy': '🚀 节点选择',
    });
    expect(result.body).toContain("dialer-proxy: 🚀 节点选择");
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, ...TAILSCALE_RULES, 'MATCH,🚀 节点选择']);
    expect(document['proxy-groups'].map((g) => g.name)).toEqual([
      '🚀 节点选择',
      '🔗 备用链路',
      TAILSCALE_GROUP_NAME,
    ]);
  });

  it('drops the field when that group prunes away, keeping the rest intact', async () => {
    // 🔗 备用链路 is selectable here (the dialer allowlist is name-based), but
    // its regex matches no node, so the prune drops it from this export while
    // the choice stays stored. 🚀 节点选择 survives, so the rest of the
    // injection (proxy/group/rules) must be intact.
    assignProfile([
      '[custom]',
      'custom_proxy_group=🚀 节点选择`select`.*',
      'custom_proxy_group=🔗 备用链路`select`nothing-matches',
      'ruleset=🚀 节点选择,[]MATCH',
    ].join('\n'));
    const result = await callDialerPut({ group: '🔗 备用链路' });
    expect(result.status).toBe(200);
    expect(result.body.tailscaleDialerProxy).toBe('🔗 备用链路');

    const exported = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    const document = parseYaml(exported.body) as {
      proxies: Array<Record<string, unknown>>;
      rules: string[];
      'proxy-groups': Array<{ name: string }>;
    };
    expect(exported.body).not.toContain('dialer-proxy');
    expect(document['proxy-groups'].map((g) => g.name)).toEqual([
      '🚀 节点选择',
      TAILSCALE_GROUP_NAME,
    ]);
    expect(document.proxies.map((proxy) => proxy.name)).toEqual([
      NODE_NAME,
      TAILSCALE_PROXY_NAME,
    ]);
    expect(document.proxies[1]).toMatchObject({ name: TAILSCALE_PROXY_NAME, type: 'tailscale' });
    expect(document.proxies[1]).not.toHaveProperty('dialer-proxy');
    expect(document.rules).toEqual([QUIC_BLOCK_RULE, ...TAILSCALE_RULES, 'MATCH,🚀 节点选择']);
  });

  it('leaves the export byte-identical when no dialer is stored', async () => {
    assignProfile(EXPORT_PROFILE_INI);
    const withProfile = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    expect(withProfile.body).not.toContain('dialer-proxy');
    const plain = await exportPath(`/s/${TOKEN}/mihomo`);
    expect(plain.body).not.toContain('dialer-proxy');
  });

  it('never emits a reserved name (a stray stored value is dropped)', async () => {
    assignProfile(EXPORT_PROFILE_INI);
    // The INI's 🔗 Tailscale group makes the whole injection skip; the stored
    // value can only be set while the profile still offers other groups.
    await callDialerPut({ group: '🚀 节点选择' });
    db.update(users)
      .set({ tailscaleDialerProxy: TAILSCALE_PROXY_NAME })
      .where(eq(users.id, userId))
      .run();
    const result = await exportPath(`/s/${TOKEN}/mihomo?tailscale=1`);
    expect(result.body).not.toContain('dialer-proxy');
  });
});
