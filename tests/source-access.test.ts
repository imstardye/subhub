// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Source access model v2 (dedicated / public / shared) — end to end.
 *
 * Same harness as the other admin API tests: the real route handlers are called
 * with fake events (tests/helpers/admin-api.ts) against a temporary SQLite
 * database, and the export itself is rendered through
 * `handleSubscriptionExport` (the code path behind GET /s/:token).
 *
 * Every fixture URL is on `example.com`; no test touches the network (all
 * sources are `local` with an inline cache blob).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import sourcesListHandler from '../server/api/admin/sources/index.get';
import sourcesCreateHandler from '../server/api/admin/sources/index.post';
import sourceGetHandler from '../server/api/admin/sources/[id].get';
import sourceUpdateHandler from '../server/api/admin/sources/[id].patch';
import sourceDeleteHandler from '../server/api/admin/sources/[id].delete';
import userDeleteHandler from '../server/api/admin/users/[id].delete';
import usersCreateHandler from '../server/api/admin/users/index.post';
import { createSessionRevocationStore, type SessionRevocationStore } from '../server/utils/session-revocation';
import { openDb, type SubhubDb } from '../server/db';
import { resetCryptoCache } from '../server/db/crypto';
import { sources, sourceAllowedUsers, users } from '../server/db/schema';
import {
  handleSubscriptionExport,
  resetExportRateLimiter,
} from '../server/utils/subscription';
import { parseAllowedUserIds } from '../server/utils/admin-sources';
import { parseIdList, parseSourceAccessMode } from '../server/utils/admin-validation';
import type { AdminApiEvent } from '../server/utils/admin-api';
import { authenticatedEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;

type AdminApiHandler = (
  event: AdminApiEvent,
  options?: { db?: SubhubDb; revocations?: SessionRevocationStore },
) => unknown;

interface FixtureUser {
  id: number;
  name: string;
  token: string;
}

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let db: SubhubDb;
let options: { db: SubhubDb; revocations: SessionRevocationStore };

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;
  resetExportRateLimiter();

  const dir = mkdtempSync(join(tmpdir(), 'subhub-access-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
  options = { db, revocations: createSessionRevocationStore() };
});

afterEach(() => {
  resetExportRateLimiter();
  resetCryptoCache();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authed(body?: unknown, url = '/api/admin/sources', method = 'POST') {
  return authenticatedEvent({ url, method, body }, options.revocations);
}

/** A user created through the users API, so tokens are real. */
async function createUser(name: string): Promise<FixtureUser> {
  const { event } = authed({ name }, '/api/admin/users');
  const res = (await usersCreateHandler(event, options)) as { item: FixtureUser };
  expect(event.node.res.statusCode).toBe(201);
  return res.item;
}

/** A `local` source with one node in its cache, created through the API. */
async function createSource(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { event } = authed({
    name,
    url: `https://example.com/${name}`,
    ...overrides,
  });
  const res = (await sourcesCreateHandler(event, options)) as {
    item: Record<string, unknown>;
  };
  expect(event.node.res.statusCode).toBe(201);
  db.update(sources)
    .set({
      cacheBlob: `ss://YWVzLTI1Ni1nY206c2VjcmV0@node.example.com:8388#${name}`,
      type: 'local',
    })
    .where(eq(sources.id, res.item.id as number))
    .run();
  return { ...res.item, cacheBlob: undefined };
}

async function patchSource(id: unknown, body: Record<string, unknown>) {
  const { event } = authed(body, `/api/admin/sources/${id}`, 'PATCH');
  const res = await sourceUpdateHandler(event, options);
  return { status: event.node.res.statusCode, res };
}

/** Node names a user's export contains, in order. */
async function exportedNodes(user: FixtureUser): Promise<string[]> {
  resetExportRateLimiter();
  const response = await handleSubscriptionExport(
    { token: user.token, target: 'mihomo', userAgent: 'clash', ip: '127.0.0.1' },
    { db },
  );
  expect(response.status).toBe(200);
  const yaml = parseYaml(response.body) as { proxies: Array<{ name: string }> };
  return yaml.proxies.map((proxy) => proxy.name);
}

function allowlistRows(): Array<{ sourceId: number; userId: number }> {
  return db
    .select({ sourceId: sourceAllowedUsers.sourceId, userId: sourceAllowedUsers.userId })
    .from(sourceAllowedUsers)
    .all()
    .sort((a, b) => a.sourceId - b.sourceId || a.userId - b.userId);
}

describe('source creation: the three kinds', () => {
  it('defaults to public (owner null, accessMode all, empty allowlist)', async () => {
    const created = await createSource('default-public');
    expect(created).toMatchObject({ ownerUserId: null, accessMode: 'all', allowedUserIds: [] });
    const stored = db.select().from(sources).all()[0]!;
    expect(stored.ownerUserId).toBeNull();
    expect(stored.accessMode).toBe('all');
    expect(allowlistRows()).toEqual([]);
  });

  it('creates a shared source with a deduped, sorted allowlist', async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    const shared = await createSource('shared', {
      accessMode: 'restricted',
      allowedUserIds: [b.id, a.id, b.id],
    });
    expect(shared).toMatchObject({ ownerUserId: null, accessMode: 'restricted' });
    expect(shared.allowedUserIds).toEqual([a.id, b.id].sort((x, y) => x - y));
    expect(allowlistRows()).toEqual([
      { sourceId: shared.id as number, userId: a.id },
      { sourceId: shared.id as number, userId: b.id },
    ]);
  });

  it('keeps a dedicated source consistent: owner wins, allowlist ignored', async () => {
    const owner = await createUser('owner');
    const other = await createUser('other');
    const dedicated = await createSource('dedicated', {
      ownerUserId: owner.id,
      accessMode: 'restricted',
      allowedUserIds: [other.id],
    });
    expect(dedicated).toMatchObject({
      ownerUserId: owner.id,
      accessMode: 'all',
      allowedUserIds: [],
    });
    const stored = db.select().from(sources).all()[0]!;
    expect(stored.accessMode).toBe('all');
    expect(allowlistRows()).toEqual([]);
  });

  it('accepts numeric-string allowlist ids (form payloads)', async () => {
    const user = await createUser('alice');
    const shared = await createSource('string-ids', {
      accessMode: 'restricted',
      allowedUserIds: [String(user.id)],
    });
    expect(shared.allowedUserIds).toEqual([user.id]);
  });

  it('a shared source with an empty list is valid (reaches nobody)', async () => {
    const shared = await createSource('empty-shared', { accessMode: 'restricted' });
    expect(shared).toMatchObject({ accessMode: 'restricted', allowedUserIds: [] });
  });

  it('responses keep every pre-existing field', async () => {
    const created = await createSource('fields');
    expect(created).toMatchObject({
      name: 'fields',
      urlMasked: 'https://example.com/fields?***',
      type: 'remote',
      ua: null,
      refreshMinutes: 60,
      lastOkAt: null,
      lastError: null,
      hasCache: false,
    });
    expect(Object.keys(created)).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'ownerUserId',
        'accessMode',
        'allowedUserIds',
        'urlMasked',
        'type',
        'ua',
        'refreshMinutes',
        'lastOkAt',
        'lastError',
        'hasCache',
      ]),
    );
  });
});

describe('allowlist validation', () => {
  const badLists: unknown[] = [0, -1, 1.5, 'abc', {}, true, 9999, [0], [-1], [1.5], ['abc'], [{}], [true], [9999], 42, 'not-a-list'];

  it('rejects a malformed or unknown id with 400 invalid allowedUserIds', async () => {
    const user = await createUser('alice');
    for (const allowedUserIds of badLists) {
      // A valid id alongside the bad one must not rescue the request.
      for (const list of [allowedUserIds, [user.id, allowedUserIds]]) {
        const { event } = authed({
          name: 'x',
          url: 'https://example.com/a',
          accessMode: 'restricted',
          allowedUserIds: list,
        });
        expect(await sourcesCreateHandler(event, options)).toEqual({
          error: 'invalid allowedUserIds',
        });
        expect(event.node.res.statusCode).toBe(400);
      }
    }
    expect(db.select().from(sources).all()).toHaveLength(0);
    expect(allowlistRows()).toEqual([]);
  });

  it('rejects an unknown id on PATCH without changing the stored list', async () => {
    const a = await createUser('alice');
    const shared = await createSource('shared', {
      accessMode: 'restricted',
      allowedUserIds: [a.id],
    });
    const { status, res } = await patchSource(shared.id, { allowedUserIds: [a.id, 9999] });
    expect(status).toBe(400);
    expect(res).toEqual({ error: 'invalid allowedUserIds' });
    expect(allowlistRows()).toEqual([{ sourceId: shared.id as number, userId: a.id }]);
  });

  it('validates the id list even when the mode would ignore it', async () => {
    const owner = await createUser('owner');
    const dedicated = await createSource('dedicated', { ownerUserId: owner.id });
    const { status, res } = await patchSource(dedicated.id, { allowedUserIds: [9999] });
    expect(status).toBe(400);
    expect(res).toEqual({ error: 'invalid allowedUserIds' });
  });

  it('rejects an unknown accessMode', async () => {
    for (const accessMode of ['some', 'ALL', 1, {}]) {
      const { event } = authed({
        name: 'x',
        url: 'https://example.com/a',
        accessMode,
      });
      expect(await sourcesCreateHandler(event, options)).toEqual({
        error: 'accessMode must be one of: all, restricted',
      });
      expect(event.node.res.statusCode).toBe(400);
    }
  });

  it('parsers are pure and behave as documented', () => {
    expect(parseSourceAccessMode(undefined)).toBe('all');
    expect(parseSourceAccessMode('restricted')).toBe('restricted');
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList([3, '3', 1, 2, 1])).toEqual([1, 2, 3]);
    expect(parseIdList(['7', 2])).toEqual([2, 7]);
    expect(() => parseIdList([0])).toThrow(/invalid allowedUserIds/);
    expect(() => parseIdList('1,2')).toThrow(/invalid allowedUserIds/);
    expect(() => parseAllowedUserIds(db, [9999])).toThrow(/invalid allowedUserIds/);
  });
});

describe('access matrix (dedicated / public / shared)', () => {
  it('a public source reaches everyone, a restricted one only listed users, a dedicated one only its owner', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const carol = await createUser('carol');

    await createSource('public');
    await createSource('shared-ab', {
      accessMode: 'restricted',
      allowedUserIds: [alice.id, bob.id],
    });
    await createSource('dedicated-a', { ownerUserId: alice.id });

    expect(await exportedNodes(alice)).toEqual(['dedicated-a', 'shared-ab', 'public']);
    expect(await exportedNodes(bob)).toEqual(['shared-ab', 'public']);
    expect(await exportedNodes(carol)).toEqual(['public']);
  });

  it('a restricted source with an empty allowlist reaches nobody', async () => {
    const alice = await createUser('alice');
    await createSource('public');
    await createSource('nobody', { accessMode: 'restricted', allowedUserIds: [] });
    expect(await exportedNodes(alice)).toEqual(['public']);
  });

  it('an unlisted user gets nothing from a restricted source (even if enabled)', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    await createSource('only-alice', { accessMode: 'restricted', allowedUserIds: [alice.id] });
    expect(await exportedNodes(bob)).toEqual([]);
    expect(await exportedNodes(alice)).toEqual(['only-alice']);
  });

  it('orders dedicated first, then shared/public by source id', async () => {
    const user = await createUser('alice');
    // Inserted out of order: public, shared, public, dedicated, shared.
    await createSource('public-1');
    await createSource('shared-2', { accessMode: 'restricted', allowedUserIds: [user.id] });
    await createSource('public-3');
    await createSource('dedicated-4', { ownerUserId: user.id });
    await createSource('shared-5', { accessMode: 'restricted', allowedUserIds: [user.id] });
    await createSource('shared-6', { accessMode: 'restricted', allowedUserIds: [] });

    // Dedicated first; then the shared and public sources interleaved by id
    // (dedicated-4, shared-2/public-1/public-3/shared-5 -> sorted by id).
    expect(await exportedNodes(user)).toEqual([
      'dedicated-4',
      'shared-2',
      'shared-5',
      'public-1',
      'public-3',
    ]);
  });

  it('a dedicated source never reaches allowlisted outsiders', async () => {
    const owner = await createUser('owner');
    const other = await createUser('other');
    await createSource('dedicated', { ownerUserId: owner.id, allowedUserIds: [other.id] });
    expect(await exportedNodes(other)).toEqual([]);
    expect(await exportedNodes(owner)).toEqual(['dedicated']);
  });

  it('rows written before v2 (access_mode null) behave as public', async () => {
    const user = await createUser('alice');
    const created = await createSource('legacy-public');
    // Simulate a database migrated from the previous schema.
    db.update(sources).set({ accessMode: 'all' }).where(eq(sources.id, created.id as number)).run();
    expect(await exportedNodes(user)).toEqual(['legacy-public']);
  });
});

describe('mode switches', () => {
  it('public -> shared -> public manages the allowlist consistently', async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    const source = await createSource('switch');

    const toShared = await patchSource(source.id, {
      accessMode: 'restricted',
      allowedUserIds: [a.id, b.id],
    });
    expect(toShared.status).toBe(200);
    expect(toShared.res).toMatchObject({
      item: { accessMode: 'restricted', allowedUserIds: [a.id, b.id].sort((x, y) => x - y) },
    });
    expect(allowlistRows()).toHaveLength(2);

    const backToPublic = await patchSource(source.id, { accessMode: 'all' });
    expect(backToPublic.res).toMatchObject({
      item: { accessMode: 'all', allowedUserIds: [] },
    });
    // The allowlist is cleared, not just hidden.
    expect(allowlistRows()).toEqual([]);
  });

  it('omitting allowedUserIds keeps the stored list; sending one replaces it', async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    const source = await createSource('keep', {
      accessMode: 'restricted',
      allowedUserIds: [a.id, b.id],
    });

    // Rename only: the allowlist must survive.
    const renamed = await patchSource(source.id, { name: 'renamed' });
    expect(renamed.res).toMatchObject({
      item: { name: 'renamed', accessMode: 'restricted', allowedUserIds: [a.id, b.id].sort((x, y) => x - y) },
    });

    const replaced = await patchSource(source.id, { allowedUserIds: [b.id] });
    expect(replaced.res).toMatchObject({ item: { allowedUserIds: [b.id] } });
    expect(allowlistRows()).toEqual([{ sourceId: source.id as number, userId: b.id }]);

    const emptied = await patchSource(source.id, { allowedUserIds: [] });
    expect(emptied.res).toMatchObject({ item: { accessMode: 'restricted', allowedUserIds: [] } });
    expect(allowlistRows()).toEqual([]);
  });

  it('setting an owner clears accessMode and the allowlist; releasing it leaves a public source', async () => {
    const a = await createUser('alice');
    const owner = await createUser('owner');
    const source = await createSource('adopt', {
      accessMode: 'restricted',
      allowedUserIds: [a.id],
    });

    const adopted = await patchSource(source.id, { ownerUserId: owner.id });
    expect(adopted.res).toMatchObject({
      item: { ownerUserId: owner.id, accessMode: 'all', allowedUserIds: [] },
    });
    expect(allowlistRows()).toEqual([]);
    expect(db.select().from(sources).all()[0]!.accessMode).toBe('all');
    expect(await exportedNodes(a)).toEqual([]);
    expect(await exportedNodes(owner)).toEqual(['adopt']);

    const released = await patchSource(source.id, { ownerUserId: null });
    expect(released.res).toMatchObject({
      item: { ownerUserId: null, accessMode: 'all', allowedUserIds: [] },
    });
  });

  it('requesting shared for a dedicated source is ignored (owner wins)', async () => {
    const owner = await createUser('owner');
    const a = await createUser('alice');
    const dedicated = await createSource('dedicated', { ownerUserId: owner.id });
    const res = await patchSource(dedicated.id, {
      accessMode: 'restricted',
      allowedUserIds: [a.id],
    });
    expect(res.res).toMatchObject({
      item: { ownerUserId: owner.id, accessMode: 'all', allowedUserIds: [] },
    });
    expect(allowlistRows()).toEqual([]);
  });

  it('a dedicated source can become shared once the owner is released', async () => {
    const owner = await createUser('owner');
    const source = await createSource('dedicated', { ownerUserId: owner.id });
    const res = await patchSource(source.id, {
      ownerUserId: null,
      accessMode: 'restricted',
      allowedUserIds: [owner.id],
    });
    expect(res.res).toMatchObject({
      item: { ownerUserId: null, accessMode: 'restricted', allowedUserIds: [owner.id] },
    });
    expect(await exportedNodes(owner)).toEqual(['dedicated']);
  });
});

describe('list/get responses carry the access fields', () => {
  it('lists every source with accessMode and allowedUserIds', async () => {
    const a = await createUser('alice');
    const owner = await createUser('owner');
    await createSource('public');
    await createSource('shared', { accessMode: 'restricted', allowedUserIds: [a.id] });
    await createSource('dedicated', { ownerUserId: owner.id });

    const { event } = authed(undefined, '/api/admin/sources', 'GET');
    const listed = (await sourcesListHandler(event, options)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(listed.items.map((item) => item.accessMode)).toEqual(['all', 'restricted', 'all']);
    expect(listed.items.map((item) => item.allowedUserIds)).toEqual([[], [a.id], []]);

    const { event: one } = authed(undefined, `/api/admin/sources/${listed.items[1]!.id}`, 'GET');
    const read = (await sourceGetHandler(one, options)) as { item: Record<string, unknown> };
    expect(read.item).toMatchObject({ accessMode: 'restricted', allowedUserIds: [a.id] });
  });
});

describe('deletion cleans up allowlists', () => {
  it('deleting a shared source removes its allowlist rows', async () => {
    const a = await createUser('alice');
    const shared = await createSource('shared', {
      accessMode: 'restricted',
      allowedUserIds: [a.id],
    });
    const kept = await createSource('kept', { accessMode: 'restricted', allowedUserIds: [a.id] });
    expect(allowlistRows()).toHaveLength(2);

    const { event } = authed(undefined, `/api/admin/sources/${shared.id}`, 'DELETE');
    expect(await sourceDeleteHandler(event, options)).toEqual({ ok: true, id: shared.id });
    expect(allowlistRows()).toEqual([{ sourceId: kept.id as number, userId: a.id }]);
  });

  it('deleting a user removes them from allowlists but keeps the shared source', async () => {
    const a = await createUser('alice');
    const b = await createUser('bob');
    const shared = await createSource('shared', {
      accessMode: 'restricted',
      allowedUserIds: [a.id, b.id],
    });
    const dedicated = await createSource('dedicated', { ownerUserId: a.id });
    const publicSource = await createSource('public');
    expect(await exportedNodes(a)).toEqual(['dedicated', 'shared', 'public']);

    const { event } = authed(undefined, `/api/admin/users/${a.id}`, 'DELETE');
    expect(await userDeleteHandler(event, options)).toEqual({ ok: true, id: a.id });

    // The allowlist row of the deleted user is gone, bob keeps access.
    expect(allowlistRows()).toEqual([{ sourceId: shared.id as number, userId: b.id }]);
    const remaining = db.select().from(sources).all().map((row) => row.id as number);
    expect(remaining).toContain(shared.id as number);
    expect(remaining).toContain(publicSource.id as number);
    expect(remaining).not.toContain(dedicated.id as number);
    expect(db.select().from(users).where(eq(users.id, a.id)).all()).toEqual([]);
    expect(await exportedNodes(b)).toEqual(['shared', 'public']);
  });
});
