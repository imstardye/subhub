// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin API CRUD for rule profiles (P3).
 *
 * Same harness as admin-api.test.ts: handlers are called with fake events
 * (tests/helpers/admin-api.ts) against a temp SQLite database. No Nuxt/Nitro
 * server runs. All URLs are fixtures on `example.com`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import profilesListHandler from '../server/api/admin/profiles/index.get';
import profilesCreateHandler from '../server/api/admin/profiles/index.post';
import profileGetHandler from '../server/api/admin/profiles/[id].get';
import profileUpdateHandler from '../server/api/admin/profiles/[id].patch';
import profileDeleteHandler from '../server/api/admin/profiles/[id].delete';
import {
  createSessionRevocationStore,
  type SessionRevocationStore,
} from '../server/utils/session-revocation';
import {
  INI_TEXT_MAX_LENGTH,
  OPTIONS_MAX_LENGTH,
  parseOptionalHttpUrl,
  parseProfileOptions,
  parseProfileVariant,
} from '../server/utils/admin-validation';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, users } from '../server/db/schema';
import type { AdminApiEvent } from '../server/utils/admin-api';
import { authenticatedEvent, makeApiEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;

type AdminApiHandler = (
  event: AdminApiEvent,
  options?: { db?: SubhubDb; revocations?: SessionRevocationStore },
) => unknown;

const INI_TEXT = '[custom_proxy_group]\n🚀 节点选择`select`.*\n\n[ruleset]\n[]GEOIP,CN';

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let base: { db: SubhubDb; options: { db: SubhubDb; revocations: SessionRevocationStore } };

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;

  const dir = mkdtempSync(join(tmpdir(), 'subhub-admin-profiles-'));
  dirs.push(dir);
  const db = openDb({ path: join(dir, 'subhub.sqlite') });
  base = { db, options: { db, revocations: createSessionRevocationStore() } };
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authed(options: { url: string; method?: string; body?: unknown }) {
  return authenticatedEvent(options, base.options.revocations);
}

async function createFixtureProfile(overrides: Record<string, unknown> = {}) {
  const { event } = authed({
    url: '/api/admin/profiles',
    method: 'POST',
    body: { name: 'fixture-profile', iniText: INI_TEXT, ...overrides },
  });
  const res = await profilesCreateHandler(event, base.options);
  expect(event.node.res.statusCode).toBe(201);
  return (res as { item: Record<string, unknown> }).item;
}

describe('/api/admin/profiles CRUD', () => {
  it('401 for every profile route without a session', async () => {
    const cases: Array<[string, string, AdminApiHandler]> = [
      ['GET', '/api/admin/profiles', profilesListHandler],
      ['POST', '/api/admin/profiles', profilesCreateHandler],
      ['GET', '/api/admin/profiles/1', profileGetHandler],
      ['PATCH', '/api/admin/profiles/1', profileUpdateHandler],
      ['DELETE', '/api/admin/profiles/1', profileDeleteHandler],
    ];
    for (const [method, url, handler] of cases) {
      const { event } = makeApiEvent({
        url,
        method,
        body: { name: 'x', iniText: '[ruleset]' },
      });
      const res = await handler(event, base.options);
      expect(event.node.res.statusCode).toBe(401);
      expect(res).toEqual({ error: 'unauthorized' });
    }
    expect(base.db.select().from(profiles).all()).toHaveLength(0);
  });

  it('creates a profile with defaults and returns every field', async () => {
    const created = await createFixtureProfile();
    expect(created).toMatchObject({
      name: 'fixture-profile',
      iniUrl: null,
      iniText: INI_TEXT,
      variant: 'mihomo',
      dnsTemplate: null,
      options: null,
    });
    expect(typeof created.id).toBe('number');

    const values = base.db.select().from(profiles).all();
    expect(values).toHaveLength(1);
    expect(values[0]!.variant).toBe('mihomo');
  });

  it('lists, reads, updates and deletes', async () => {
    const created = await createFixtureProfile({
      name: 'fixture-alpha',
      iniUrl: 'https://example.com/rules/base.ini',
      variant: 'legacy',
      dnsTemplate: 'nameserver:\n  - 1.1.1.1',
      options: { ruleProviderCache: true },
    });
    expect(created.iniUrl).toBe('https://example.com/rules/base.ini');
    expect(created.variant).toBe('legacy');
    expect(created.options).toEqual({ ruleProviderCache: true });

    const list = authed({ url: '/api/admin/profiles' });
    const listed = (await profilesListHandler(list.event, base.options)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id: created.id, name: 'fixture-alpha' });

    const read = authed({ url: `/api/admin/profiles/${created.id}` });
    const readRes = (await profileGetHandler(read.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(readRes.item).toMatchObject({
      name: 'fixture-alpha',
      iniUrl: 'https://example.com/rules/base.ini',
      iniText: INI_TEXT,
      variant: 'legacy',
    });

    // Patch only what changes; omitted fields keep their values.
    const renamed = authed({
      url: `/api/admin/profiles/${created.id}`,
      method: 'PATCH',
      body: { name: 'fixture-beta', variant: 'mihomo' },
    });
    const renameRes = (await profileUpdateHandler(renamed.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(renameRes.item).toMatchObject({
      name: 'fixture-beta',
      variant: 'mihomo',
      iniUrl: 'https://example.com/rules/base.ini',
      iniText: INI_TEXT,
      dnsTemplate: 'nameserver:\n  - 1.1.1.1',
      options: { ruleProviderCache: true },
    });

    // Clearing an optional field with null works as long as a rule source stays.
    const cleared = authed({
      url: `/api/admin/profiles/${created.id}`,
      method: 'PATCH',
      body: { iniUrl: null, dnsTemplate: null, options: null },
    });
    const clearedRes = (await profileUpdateHandler(cleared.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(clearedRes.item).toMatchObject({
      iniUrl: null,
      iniText: INI_TEXT,
      dnsTemplate: null,
      options: null,
    });

    const removed = authed({
      url: `/api/admin/profiles/${created.id}`,
      method: 'DELETE',
    });
    expect(await profileDeleteHandler(removed.event, base.options)).toEqual({
      ok: true,
      id: created.id,
    });
    expect(base.db.select().from(profiles).all()).toHaveLength(0);
  });

  it('clears users.profileId when the referenced profile is deleted', async () => {
    const created = await createFixtureProfile({ name: 'fixture-linked', iniText: INI_TEXT });
    const createdId = created.id as number;
    base.db
      .insert(users)
      .values({
        name: 'linked-user',
        token: 'tok-linked-profile-clear-01',
        enabled: true,
        note: null,
        profileId: createdId,
      })
      .run();
    const other = await createFixtureProfile({ name: 'fixture-keep', iniText: INI_TEXT });
    const otherId = other.id as number;
    base.db
      .insert(users)
      .values({
        name: 'other-user',
        token: 'tok-other-profile-keep-02',
        enabled: true,
        note: null,
        profileId: otherId,
      })
      .run();

    const removed = authed({
      url: `/api/admin/profiles/${createdId}`,
      method: 'DELETE',
    });
    expect(await profileDeleteHandler(removed.event, base.options)).toEqual({
      ok: true,
      id: createdId,
    });

    const linked = base.db.select().from(users).where(eq(users.token, 'tok-linked-profile-clear-01')).get();
    const kept = base.db.select().from(users).where(eq(users.token, 'tok-other-profile-keep-02')).get();
    expect(linked?.profileId).toBeNull();
    expect(kept?.profileId).toBe(otherId);
    expect(base.db.select().from(profiles).where(eq(profiles.id, createdId)).get()).toBeUndefined();
  });

  it('accepts options as a JSON string from form-ish callers', async () => {
    const created = await createFixtureProfile({ options: '{"inlineRules":false}' });
    expect(created.options).toEqual({ inlineRules: false });
  });

  it('keeps an existing rule source when a patch does not touch it', async () => {
    const created = await createFixtureProfile({ name: 'fixture-keep', iniText: INI_TEXT });
    const patched = authed({
      url: `/api/admin/profiles/${created.id}`,
      method: 'PATCH',
      body: { iniText: '' , iniUrl: 'https://example.com/rules/next.ini' },
    });
    const res = (await profileUpdateHandler(patched.event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(res.item).toMatchObject({ iniText: null, iniUrl: 'https://example.com/rules/next.ini' });
    expect(patched.event.node.res.statusCode).toBe(200);
  });

  it('404 for unknown ids', async () => {
    for (const [url, method, handler] of [
      ['/api/admin/profiles/999', 'GET', profileGetHandler],
      ['/api/admin/profiles/999', 'PATCH', profileUpdateHandler],
      ['/api/admin/profiles/999', 'DELETE', profileDeleteHandler],
    ] as const) {
      const { event } = authed({ url, method, body: { name: 'x' } });
      expect(await handler(event, base.options)).toEqual({ error: 'profile not found' });
      expect(event.node.res.statusCode).toBe(404);
    }
  });
});

describe('/api/admin/profiles validation', () => {
  it('rejects invalid create bodies with 400 and stores nothing', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'name is required'],
      [{ name: '   ', iniText: INI_TEXT }, 'name is required'],
      [{ name: 'x'.repeat(101), iniText: INI_TEXT }, 'name must be at most 100 characters'],
      [{ name: 'x' }, 'one of iniUrl or iniText is required'],
      [{ name: 'x', iniUrl: '', iniText: '   ' }, 'one of iniUrl or iniText is required'],
      [{ name: 'x', iniUrl: 'ftp://example.com/a.ini' }, 'iniUrl must use http or https'],
      [{ name: 'x', iniUrl: 'example.com/a.ini' }, 'iniUrl is not a valid URL'],
      [{ name: 'x', iniUrl: 'https://user:pass@example.com/a.ini' }, 'iniUrl must not contain credentials'],
      [
        { name: 'x', iniUrl: `https://example.com/${'a'.repeat(2100)}` },
        'iniUrl must be at most 2048 characters',
      ],
      [{ name: 'x', iniText: INI_TEXT, variant: 'clash' }, 'variant must be one of: mihomo, legacy'],
      [{ name: 'x', iniText: INI_TEXT, variant: 42 }, 'variant must be one of: mihomo, legacy'],
      [{ name: 'x', iniText: 42 }, 'iniText must be a string'],
      [
        { name: 'x', iniText: 'i'.repeat(INI_TEXT_MAX_LENGTH + 1) },
        `iniText must be at most ${INI_TEXT_MAX_LENGTH} characters`,
      ],
      [
        { name: 'x', iniText: INI_TEXT, dnsTemplate: 'd'.repeat(2049) },
        'dnsTemplate must be at most 2048 characters',
      ],
      [{ name: 'x', iniText: INI_TEXT, options: '{not json' }, 'options must be valid JSON'],
      [{ name: 'x', iniText: INI_TEXT, options: '[1,2]' }, 'options must be a JSON object'],
      [{ name: 'x', iniText: INI_TEXT, options: '"str"' }, 'options must be a JSON object'],
      [{ name: 'x', iniText: INI_TEXT, options: 7 }, 'options must be a JSON object'],
      [
        { name: 'x', iniText: INI_TEXT, options: { blob: 'o'.repeat(OPTIONS_MAX_LENGTH) } },
        `options must be at most ${OPTIONS_MAX_LENGTH} characters`,
      ],
    ];
    for (const [body, error] of cases) {
      const { event } = authed({ url: '/api/admin/profiles', method: 'POST', body });
      expect(await profilesCreateHandler(event, base.options)).toEqual({ error });
      expect(event.node.res.statusCode).toBe(400);
    }
    expect(base.db.select().from(profiles).all()).toHaveLength(0);
  });

  it('rejects a create without a body', async () => {
    const { event } = authed({ url: '/api/admin/profiles', method: 'POST' });
    expect(await profilesCreateHandler(event, base.options)).toEqual({ error: 'invalid JSON body' });
    expect(event.node.res.statusCode).toBe(400);
  });

  it('rejects updates that would leave the profile without a rule source', async () => {
    const created = await createFixtureProfile({ iniText: INI_TEXT });
    for (const body of [{ iniText: '' }, { iniText: null }, { iniUrl: null, iniText: '' }]) {
      const { event } = authed({
        url: `/api/admin/profiles/${created.id}`,
        method: 'PATCH',
        body,
      });
      expect(await profileUpdateHandler(event, base.options)).toEqual({
        error: 'one of iniUrl or iniText is required',
      });
      expect(event.node.res.statusCode).toBe(400);
    }
    // Nothing was written.
    expect(base.db.select().from(profiles).all()[0]!.iniText).toBe(INI_TEXT);
  });

  it('validates fields on update too', async () => {
    const created = await createFixtureProfile();
    for (const [body, error] of [
      [{ name: '' }, 'name is required'],
      [{ iniUrl: 'ws://example.com/a.ini' }, 'iniUrl must use http or https'],
      [{ variant: 'singbox' }, 'variant must be one of: mihomo, legacy'],
      [{ options: '[]' }, 'options must be a JSON object'],
      [{ dnsTemplate: 'd'.repeat(2049) }, 'dnsTemplate must be at most 2048 characters'],
    ] as const) {
      const { event } = authed({
        url: `/api/admin/profiles/${created.id}`,
        method: 'PATCH',
        body,
      });
      expect(await profileUpdateHandler(event, base.options)).toEqual({ error });
      expect(event.node.res.statusCode).toBe(400);
    }
  });

  it('is a no-op for an empty patch', async () => {
    const created = await createFixtureProfile();
    const { event } = authed({
      url: `/api/admin/profiles/${created.id}`,
      method: 'PATCH',
      body: {},
    });
    const res = (await profileUpdateHandler(event, base.options)) as {
      item: Record<string, unknown>;
    };
    expect(res.item).toEqual(created);
    expect(event.node.res.statusCode).toBe(200);
  });
});

describe('profile validation helpers', () => {
  it('parseOptionalHttpUrl accepts http(s), normalises and rejects the rest', () => {
    expect(parseOptionalHttpUrl(undefined, 'iniUrl')).toBeNull();
    expect(parseOptionalHttpUrl(null, 'iniUrl')).toBeNull();
    expect(parseOptionalHttpUrl('  ', 'iniUrl')).toBeNull();
    expect(parseOptionalHttpUrl(' https://example.com/a.ini ', 'iniUrl')).toBe(
      'https://example.com/a.ini',
    );
    expect(parseOptionalHttpUrl('http://example.com/a', 'iniUrl')).toBe('http://example.com/a');
    expect(() => parseOptionalHttpUrl('//example.com/a', 'iniUrl')).toThrow(/not a valid URL/);
    expect(() => parseOptionalHttpUrl(123, 'iniUrl')).toThrow(/must be a string/);
  });

  it('parseProfileVariant defaults to mihomo and enforces the enum', () => {
    expect(parseProfileVariant(undefined)).toBe('mihomo');
    expect(parseProfileVariant('')).toBe('mihomo');
    expect(parseProfileVariant('legacy')).toBe('legacy');
    expect(parseProfileVariant('mihomo')).toBe('mihomo');
    expect(() => parseProfileVariant('LEGACY')).toThrow(/variant must be one of/);
  });

  it('parseProfileOptions normalises strings, objects and empties', () => {
    expect(parseProfileOptions(undefined)).toBeNull();
    expect(parseProfileOptions('')).toBeNull();
    expect(parseProfileOptions('{"a":1}')).toEqual({ a: 1 });
    expect(parseProfileOptions({ a: 1 })).toEqual({ a: 1 });
    expect(parseProfileOptions('{}')).toEqual({});
    expect(() => parseProfileOptions('nope')).toThrow(/valid JSON/);
    expect(() => parseProfileOptions('null')).toThrow(/must be a JSON object/);
  });
});
