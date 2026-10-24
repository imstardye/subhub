// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/stats — dashboard counters (P3).
 *
 * Same harness as the other admin API tests: the handler is called with fake
 * events (tests/helpers/admin-api.ts) against a temporary SQLite database. No
 * Nuxt/Nitro server runs; every value below is a fixture.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import statsHandler from '../server/api/admin/stats/index.get';
import {
  createSessionRevocationStore,
  type SessionRevocationStore,
} from '../server/utils/session-revocation';
import { STATS_WINDOW_MS } from '../server/utils/admin-stats';
import { openDb, type SubhubDb } from '../server/db';
import { accessLogs, profiles, sources, users } from '../server/db/schema';
import { authenticatedEvent, makeApiEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;
const HOUR_MS = 60 * 60 * 1000;

interface StatsBody {
  users: number;
  sources: number;
  profiles: number;
  accessLogs24h: number;
}

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let base: { db: SubhubDb; options: { db: SubhubDb; revocations: SessionRevocationStore } };

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;

  const dir = mkdtempSync(join(tmpdir(), 'subhub-admin-stats-'));
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

/** Authenticated request using the store the handler verifies against. */
async function fetchStats() {
  const { event } = authenticatedEvent({ url: '/api/admin/stats' }, base.options.revocations);
  const body = await statsHandler(event, base.options);
  return { status: event.node.res.statusCode, body: body as StatsBody };
}

function insertAccessLog(createdAt: Date, target = 'mihomo') {
  base.db
    .insert(accessLogs)
    .values({ userId: null, target, status: 200, ms: 10, createdAt })
    .run();
}

describe('GET /api/admin/stats auth', () => {
  it('answers 401 for anonymous requests', async () => {
    const { event } = makeApiEvent({ url: '/api/admin/stats' });
    const body = await statsHandler(event, base.options);
    expect(event.node.res.statusCode).toBe(401);
    expect(body).toEqual({ error: 'unauthorized' });
  });
});

describe('GET /api/admin/stats counters', () => {
  it('returns zeros on an empty database', async () => {
    const { status, body } = await fetchStats();
    expect(status).toBe(200);
    // `settings` (the subscription prefix the UI builds links with) rides on
    // the payload; see server/api/admin/stats/index.get.ts.
    expect(body).toEqual({
      users: 0,
      sources: 0,
      profiles: 0,
      accessLogs24h: 0,
      settings: { subPath: 's' },
    });
  });

  it('counts users, sources and profiles independently', async () => {
    base.db.insert(users).values([
      { name: 'fixture-a', token: 'a'.repeat(64) },
      { name: 'fixture-b', token: 'b'.repeat(64) },
      { name: 'fixture-c', token: 'c'.repeat(64) },
    ]).run();
    base.db.insert(sources).values([
      { name: 'fixture-source-1', url: 'ciphertext-1', type: 'remote' },
      { name: 'fixture-source-2', url: 'ciphertext-2', type: 'local' },
    ]).run();
    base.db.insert(profiles).values({ name: 'fixture-profile', iniText: '[ruleset]' }).run();

    const { body } = await fetchStats();
    expect(body).toEqual({ users: 3, sources: 2, profiles: 1, accessLogs24h: 0, settings: { subPath: 's' } });
  });

  it('counts only access logs inside the 24h window', async () => {
    const now = Date.now();
    // Inside the window: 23h ago and "just now".
    insertAccessLog(new Date(now - 23 * HOUR_MS));
    insertAccessLog(new Date(now - 1_000));
    // Outside the window: 25h ago and much older.
    insertAccessLog(new Date(now - 25 * HOUR_MS));
    insertAccessLog(new Date(now - 30 * 24 * HOUR_MS));
    // Right at the 24h boundary (a second of slack: the handler re-reads the
    // clock, so an exact `now - 24h` row could otherwise drift outside).
    insertAccessLog(new Date(now - STATS_WINDOW_MS + 1_000));

    const { body } = await fetchStats();
    expect(body.accessLogs24h).toBe(3);
    expect(body.users).toBe(0);
  });
});
