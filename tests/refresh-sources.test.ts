// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { openDb, type SubhubDb } from '../server/db';
import { decrypt, encrypt } from '../server/db/crypto';
import { sources, userSources, users } from '../server/db/schema';
import {
  isSourceDue,
  refreshAllDueSources,
  refreshSource,
  type Fetcher,
  type FetchResponse,
} from '../server/tasks/refresh-sources';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';

/**
 * All URLs and payloads below are fake: `example.com` hosts and placeholder
 * credentials only. The fetcher is always mocked, so no test touches the
 * network.
 */
const SOURCE_URL = 'https://example.com/fake-subscription?token=fake';
const SECOND_SOURCE_URL = 'https://example.com/fake-subscription?token=fake-2';
const NEW_BODY = [
  'ss://YWVzLTEyOC1nY206ZmFrZS1wYXNzd29yZA@example.com:8388#cached-node',
  'ss://YWVzLTEyOC1nY206ZmFrZS1wYXNzd29yZA@example.com:8389#second-node',
].join('\n');
const OLD_BODY = 'proxies:\n  - {name: "old-node", type: ss, server: example.com, port: 9000, cipher: aes-128-gcm, password: "fake"}\n';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const dirs: string[] = [];
let db: SubhubDb;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'subhub-refresh-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function insertSource(overrides: Partial<typeof sources.$inferInsert> = {}): number {
  const row = db
    .insert(sources)
    .values({
      name: 'fixture-remote',
      url: encrypt(SOURCE_URL),
      type: 'remote',
      refreshMinutes: 60,
      ...overrides,
    })
    .returning({ id: sources.id })
    .get();
  return row!.id;
}

function okResponse(body: string): FetchResponse {
  return { ok: true, status: 200, text: async () => body };
}

function errorResponse(status = 500): FetchResponse {
  return { ok: false, status, text: async () => '' };
}

describe('isSourceDue', () => {
  it('treats missing lastOkAt as due and honours refresh_minutes', () => {
    expect(isSourceDue({ refreshMinutes: 60, lastOkAt: null }, NOW)).toBe(true);
    expect(isSourceDue({ refreshMinutes: 60, lastOkAt: new Date(NOW - 30 * 60_000) }, NOW)).toBe(false);
    expect(isSourceDue({ refreshMinutes: 60, lastOkAt: new Date(NOW - 61 * 60_000) }, NOW)).toBe(true);
  });
});

describe('refreshAllDueSources', () => {
  it('refreshes a stale source, decrypting the URL and caching the body', async () => {
    const sourceId = insertSource({ lastOkAt: new Date(NOW - 120 * 60_000), lastError: 'stale error' });
    const fetcher = vi.fn<Fetcher>(async () => okResponse(NEW_BODY));

    const summary = await refreshAllDueSources(db, { fetcher, now: () => NOW });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetcher.mock.calls[0]!;
    expect(calledUrl).toBe(SOURCE_URL);
    expect(init.headers['user-agent']).toBe('subhub/1.0');
    expect(summary).toMatchObject({ checked: 1, refreshed: 1, failed: 0, skipped: 0 });

    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
    expect(row.cacheBlob).toBe(NEW_BODY);
    expect(row.lastOkAt?.getTime()).toBe(NOW);
    expect(row.lastError).toBeNull();
  });

  it('refreshes a source that has never succeeded', async () => {
    insertSource({ lastOkAt: null });
    const fetcher = vi.fn<Fetcher>(async () => okResponse(NEW_BODY));
    const summary = await refreshAllDueSources(db, { fetcher, now: () => NOW });
    expect(summary.refreshed).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('skips fresh sources, local sources and non-due runs', async () => {
    insertSource({ lastOkAt: new Date(NOW - 5 * 60_000) });
    insertSource({ type: 'local', lastOkAt: null });
    const fetcher = vi.fn<Fetcher>(async () => okResponse(NEW_BODY));

    const summary = await refreshAllDueSources(db, { fetcher, now: () => NOW });
    expect(summary).toMatchObject({ checked: 1, refreshed: 0, skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the old cache_blob and records last_error when the fetch fails', async () => {
    const sourceId = insertSource({ lastOkAt: new Date(NOW - 120 * 60_000), cacheBlob: OLD_BODY });
    const fetcher = vi.fn<Fetcher>(async () => errorResponse(503));

    const summary = await refreshAllDueSources(db, { fetcher, now: () => NOW });
    expect(summary).toMatchObject({ refreshed: 0, failed: 1, results: [{ outcome: 'failed' }] });

    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
    expect(row.cacheBlob).toBe(OLD_BODY);
    expect(row.lastError).toContain('HTTP 503');
    // last_ok_at is unchanged so the source stays due for the next run.
    expect(row.lastOkAt?.getTime()).toBe(NOW - 120 * 60_000);
  });

  it('records a failure for network errors and undecryptable URLs', async () => {
    const networkId = insertSource({ lastOkAt: null });
    const brokenId = insertSource({ lastOkAt: null, url: 'not-a-ciphertext' });
    const fetcher = vi.fn<Fetcher>(async () => {
      throw new Error('fetch failed');
    });

    const summary = await refreshAllDueSources(db, { fetcher, now: () => NOW });
    expect(summary.failed).toBe(2);

    const network = db.select().from(sources).where(eq(sources.id, networkId)).get()!;
    expect(network.lastError).toContain('fetch failed');
    expect(network.cacheBlob).toBeNull();

    const broken = db.select().from(sources).where(eq(sources.id, brokenId)).get()!;
    expect(broken.lastError).toContain('cannot decrypt source URL');
  });

  it('force re-fetches a fresh source on demand', async () => {
    insertSource({ lastOkAt: new Date(NOW - 60_000) });
    const fetcher = vi.fn<Fetcher>(async () => okResponse(NEW_BODY));
    const summary = await refreshAllDueSources(db, { fetcher, now: () => NOW, force: true });
    expect(summary.refreshed).toBe(1);
  });

  it('refreshSource reports skipped for local sources', async () => {
    const id = insertSource({ type: 'local' });
    const fetcher = vi.fn<Fetcher>(async () => okResponse(NEW_BODY));
    expect(await refreshSource(db, id, { fetcher, now: () => NOW })).toEqual({ sourceId: id, outcome: 'skipped' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('subscription export reads the cache', () => {
  const TOKEN = 'b'.repeat(32);

  it('aggregates cached nodes from user sources into mihomo and legacy output', async () => {
    resetExportRateLimiter();
    const user = db
      .insert(users)
      .values({ name: 'cache-user', token: TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!;

    const first = insertSource({ lastOkAt: null });
    const second = insertSource({ lastOkAt: null, url: encrypt(SECOND_SOURCE_URL) });
    db.insert(userSources).values({ userId: user.id, sourceId: first, sort: 0 }).run();
    db.insert(userSources).values({ userId: user.id, sourceId: second, sort: 1 }).run();

    const fetcher = vi.fn<Fetcher>(async (url) =>
      okResponse(url === SECOND_SOURCE_URL ? OLD_BODY : NEW_BODY),
    );
    await refreshAllDueSources(db, { fetcher, now: () => NOW });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const mihomo = handleSubscriptionExport({ token: TOKEN, target: 'mihomo' }, { db });
    expect(mihomo.status).toBe(200);
    const mihomoYaml = parseYaml(mihomo.body) as { proxies: Array<{ name: string }> };
    expect(mihomoYaml.proxies.map((proxy) => proxy.name)).toEqual(['cached-node', 'second-node', 'old-node']);

    const legacy = handleSubscriptionExport({ token: TOKEN, target: 'clash' }, { db });
    const legacyYaml = parseYaml(legacy.body) as { proxies: Array<{ name: string }> };
    expect(legacyYaml.proxies.map((proxy) => proxy.name)).toEqual(['cached-node', 'second-node', 'old-node']);
    resetExportRateLimiter();
  });

  it('still serves the old cached nodes after a failed refresh', async () => {
    resetExportRateLimiter();
    const user = db
      .insert(users)
      .values({ name: 'stale-user', token: TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!;
    const id = insertSource({ lastOkAt: new Date(NOW - 120 * 60_000), cacheBlob: OLD_BODY });
    db.insert(userSources).values({ userId: user.id, sourceId: id, sort: 0 }).run();

    const fetcher = vi.fn<Fetcher>(async () => errorResponse(500));
    await refreshAllDueSources(db, { fetcher, now: () => NOW });

    const response = handleSubscriptionExport({ token: TOKEN, target: 'mihomo' }, { db });
    const yaml = parseYaml(response.body) as { proxies: Array<{ name: string }> };
    expect(yaml.proxies.map((proxy) => proxy.name)).toEqual(['old-node']);
    expect(decrypt(db.select().from(sources).where(eq(sources.id, id)).get()!.url)).toBe(SOURCE_URL);
    resetExportRateLimiter();
  });
});
