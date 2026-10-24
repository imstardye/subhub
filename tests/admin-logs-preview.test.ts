// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin access logs (GET /api/admin/logs) and subscription preview
 * (POST /api/admin/preview).
 *
 * Same harness as the other admin API tests: handlers are called with fake
 * events (tests/helpers/admin-api.ts) against a temporary SQLite database. No
 * Nuxt/Nitro server runs, and every fixture URL is on `example.com`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import logsListHandler from '../server/api/admin/logs/index.get';
import previewHandler from '../server/api/admin/preview/index.post';
import { createSessionRevocationStore, type SessionRevocationStore } from '../server/utils/session-revocation';
import { openDb, type SubhubDb } from '../server/db';
import { accessLogs, profiles, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import { EXPORT_TARGETS } from '../server/utils/targets';
import { QUIC_BLOCK_RULE } from '../core';
import type { AdminApiEvent } from '../server/utils/admin-api';
import { authenticatedEvent, makeApiEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;

type AdminApiHandler = (
  event: AdminApiEvent,
  options?: { db?: SubhubDb; revocations?: SessionRevocationStore },
) => unknown;

/** Plain share link on a fixture host (never a real subscription URL). */
const NODE_LINKS = [
  'ss://YWVzLTI1Ni1nY206c2VjcmV0@node1.example.com:8388#node-one',
  'ss://YWVzLTI1Ni1nY206c2VjcmV0@node2.example.com:8388#node-two',
].join('\n');

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let base: { db: SubhubDb; options: { db: SubhubDb; revocations: SessionRevocationStore } };
let userId: number;
let disabledUserId: number;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;

  const dir = mkdtempSync(join(tmpdir(), 'subhub-admin-logs-'));
  dirs.push(dir);
  const db = openDb({ path: join(dir, 'subhub.sqlite') });
  base = { db, options: { db, revocations: createSessionRevocationStore() } };

  userId = db
    .insert(users)
    .values({ name: 'fixture-user', token: 'a'.repeat(64), enabled: true })
    .returning({ id: users.id })
    .get()!.id;
  disabledUserId = db
    .insert(users)
    .values({ name: 'suspended-user', token: 'b'.repeat(64), enabled: false })
    .returning({ id: users.id })
    .get()!.id;
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

function insertLog(
  values: Partial<typeof accessLogs.$inferInsert> = {},
): typeof accessLogs.$inferInsert {
  return {
    userId,
    target: 'mihomo',
    ua: 'clash-verge/v2.0',
    ip: '127.0.0.1',
    status: 200,
    ms: 12,
    ...values,
  };
}

async function listLogs(url: string, handler = logsListHandler) {
  const { event } = authed({ url, method: 'GET' });
  const body = await handler(event, base.options);
  return { status: event.node.res.statusCode, body: body as Record<string, unknown> };
}

async function preview(body: Record<string, unknown>) {
  const { event } = authed({ url: '/api/admin/preview', method: 'POST', body });
  const result = await previewHandler(event, base.options);
  return { status: event.node.res.statusCode, body: result as Record<string, unknown> };
}

/** Insert a source; `ownerId` null makes it public (shared by every user). */
function attachSource(cacheBlob: string | null, ownerId: number | null = userId): number {
  const source = base.db
    .insert(sources)
    .values({
      name: 'fixture-source',
      // Encrypted placeholder text (never a real URL).
      url: encrypt('https://example.com/fixture-source'),
      type: 'local',
      cacheBlob,
      ownerUserId: ownerId,
    })
    .returning({ id: sources.id })
    .get()!;
  return source.id;
}

describe('GET /api/admin/logs auth', () => {
  it('answers 401 for anonymous requests', async () => {
    const { event } = makeApiEvent({ url: '/api/admin/logs' });
    const body = await logsListHandler(event, base.options);
    expect(event.node.res.statusCode).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });
});

describe('GET /api/admin/logs listing', () => {
  it('returns an empty page when there are no logs', async () => {
    const { status, body } = await listLogs('/api/admin/logs');
    expect(status).toBe(200);
    expect(body).toMatchObject({ items: [], total: 0, limit: 50, offset: 0 });
  });

  it('returns newest first and pages with limit/offset while total counts all rows', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) {
      base.db
        .insert(accessLogs)
        .values(
          insertLog({
            createdAt: new Date(now + i * 1000),
            ua: `ua-${i}`,
          }),
        )
        .run();
    }

    const first = await listLogs('/api/admin/logs?limit=2&offset=0');
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(5);
    const firstItems = first.body.items as Array<Record<string, unknown>>;
    expect(firstItems).toHaveLength(2);
    expect(firstItems.map((item) => item.ua)).toEqual(['ua-4', 'ua-3']);
    expect(firstItems[0]).toMatchObject({
      userId,
      userName: 'fixture-user',
      target: 'mihomo',
      ip: '127.0.0.1',
      status: 200,
      ms: 12,
    });
    expect(typeof firstItems[0]!.createdAt).toBe('string');
    expect(new Date(firstItems[0]!.createdAt as string).getTime()).toBe(now + 4000);

    const second = await listLogs('/api/admin/logs?limit=2&offset=2');
    expect((second.body.items as unknown[]).length).toBe(2);
    expect((second.body.items as Array<Record<string, unknown>>).map((item) => item.ua)).toEqual([
      'ua-2',
      'ua-1',
    ]);
    expect(second.body.total).toBe(5);
  });

  it('caps limit at 200 and defaults invalid paging to a 400', async () => {
    const capped = await listLogs('/api/admin/logs?limit=1000');
    expect(capped.status).toBe(200);
    expect(capped.body.limit).toBe(200);

    const badLimit = await listLogs('/api/admin/logs?limit=-1');
    expect(badLimit.status).toBe(400);
    const badOffset = await listLogs('/api/admin/logs?offset=x');
    expect(badOffset.status).toBe(400);
  });

  it('filters by userId and status and keeps total in sync', async () => {
    base.db.insert(accessLogs).values(insertLog({ status: 200 })).run();
    base.db.insert(accessLogs).values(insertLog({ status: 404, userId: null })).run();
    base.db.insert(accessLogs).values(insertLog({ status: 404, userId: disabledUserId })).run();

    const byUser = await listLogs(`/api/admin/logs?userId=${userId}`);
    expect(byUser.body.total).toBe(1);
    expect((byUser.body.items as Array<Record<string, unknown>>)[0]!.userName).toBe('fixture-user');

    const byStatus = await listLogs('/api/admin/logs?status=404');
    expect(byStatus.body.total).toBe(2);

    const both = await listLogs(`/api/admin/logs?status=404&userId=${disabledUserId}`);
    expect(both.body.total).toBe(1);
    expect((both.body.items as Array<Record<string, unknown>>)[0]!.userName).toBe('suspended-user');

    const none = await listLogs(`/api/admin/logs?status=200&userId=${disabledUserId}`);
    expect(none.body.total).toBe(0);
  });

  it('reports userName null once the user has been deleted', async () => {
    base.db.insert(accessLogs).values(insertLog({ userId: disabledUserId })).run();
    base.db.delete(users).where(eq(users.id, disabledUserId)).run();

    const { body } = await listLogs('/api/admin/logs');
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.userId).toBe(disabledUserId);
    expect(items[0]!.userName).toBeNull();
  });

  it('keeps userName null for rows without a user id', async () => {
    base.db.insert(accessLogs).values(insertLog({ userId: null, status: 404 })).run();
    const { body } = await listLogs('/api/admin/logs');
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ userId: null, userName: null, status: 404 });
  });
});

describe('POST /api/admin/preview auth and validation', () => {
  it('answers 401 for anonymous requests', async () => {
    const { event } = makeApiEvent({
      url: '/api/admin/preview',
      method: 'POST',
      body: { userId },
    });
    const body = await previewHandler(event, base.options);
    expect(event.node.res.statusCode).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('answers 404 for a missing user', async () => {
    const { status, body } = await preview({ userId: 9999 });
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'user not found' });
  });

  it('answers 400 for an unknown target', async () => {
    const { status, body } = await preview({ userId, target: 'not-a-target' });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('target must be one of');
  });
});

describe('POST /api/admin/preview rendering', () => {
  it('renders cached nodes as valid YAML containing proxies (default mihomo)', async () => {
    attachSource(NODE_LINKS);
    const { status, body } = await preview({ userId });

    expect(status).toBe(200);
    expect(body).toMatchObject({ userId, name: 'fixture-user', enabled: true, target: 'mihomo', status: 200 });
    expect(body.contentType).toBe('text/yaml; charset=utf-8');
    expect(body.truncated).toBeUndefined();

    const text = body.body as string;
    expect(text).toContain('proxies');
    const parsed = parseYaml(text) as { proxies?: unknown[] };
    expect(Array.isArray(parsed.proxies)).toBe(true);
    expect(parsed.proxies!.length).toBe(2);
  });

  it('renders without a cache and accepts every EXPORT_TARGETS value', async () => {
    for (const target of EXPORT_TARGETS) {
      const { status, body } = await preview({ userId, target });
      expect(status).toBe(200);
      expect(body.target).toBe(target);
      expect(typeof body.body).toBe('string');
    }
  });

  it('previews a disabled user and reports enabled: false', async () => {
    const { status, body } = await preview({ userId: disabledUserId });
    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: disabledUserId, enabled: false });
  });

  it('applies the user\'s rule profile so an admin preview matches the export', async () => {
    attachSource(NODE_LINKS);
    // Public source in this test: the preview uses the same aggregation as /s/:token.
    const profile = base.db
      .insert(profiles)
      .values({
        name: 'fixture-profile',
        iniText: [
          '[custom]',
          'custom_proxy_group=🚀 节点选择`select`.*',
          'ruleset=🚀 节点选择,[]MATCH',
        ].join('\n'),
      })
      .returning({ id: profiles.id })
      .get()!;
    base.db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();

    const { status, body } = await preview({ userId });
    expect(status).toBe(200);
    const parsed = parseYaml(body.body as string) as {
      proxies: Array<{ name: string }>;
      'proxy-groups': Array<{ name: string; proxies: string[] }>;
      rules: string[];
    };
    expect(parsed.proxies.map((proxy) => proxy.name)).toEqual(['node-one', 'node-two']);
    expect(parsed['proxy-groups'][0]!.name).toBe('🚀 节点选择');
    expect(parsed['proxy-groups'][0]!.proxies).toEqual(['node-one', 'node-two']);
    // The built-in QUIC block is prepended to the profile rules (see
    // tests/dns-template.test.ts for the full template coverage).
    expect(parsed.rules).toEqual([QUIC_BLOCK_RULE, 'MATCH,🚀 节点选择']);
  });

  it('does not write access_logs', async () => {
    attachSource(NODE_LINKS);
    const before = base.db.select().from(accessLogs).all().length;
    await preview({ userId });
    await preview({ userId: disabledUserId, target: 'clash' });
    const after = base.db.select().from(accessLogs).all().length;
    expect(after).toBe(before);

    // And the public listing stays empty, i.e. no row was inserted at all.
    const { body } = await listLogs('/api/admin/logs');
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });
});
