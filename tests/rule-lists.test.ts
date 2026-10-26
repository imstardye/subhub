// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb, type SubhubDb } from '../server/db';
import { ruleListCache } from '../server/db/schema';
import {
  getRuleListBodies,
  RULE_LIST_CACHE_TTL_MS,
} from '../server/utils/rule-lists';

const URL_A = 'https://rules.example.com/a.list';
const URL_B = 'https://rules.example.com/b.list';
const BODY_A = 'DOMAIN-SUFFIX,a.example.com';
const BODY_B = 'DOMAIN-SUFFIX,b.example.com';

const dirs: string[] = [];
let db: SubhubDb;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'subhub-rule-lists-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(url: string, body: string, fetchedAt: number): void {
  db.insert(ruleListCache).values({ url, body, fetchedAt }).run();
}

function row(url: string) {
  return db.select().from(ruleListCache).where(eq(ruleListCache.url, url)).get();
}

function ok(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}

function failure(status = 503): Response {
  return { ok: false, status, text: async () => '' } as Response;
}

describe('getRuleListBodies', () => {
  it('uses a fresh cached body without fetching', async () => {
    seed(URL_A, BODY_A, Date.now() - 1_000);
    const fetcher = vi.spyOn(globalThis, 'fetch');

    const bodies = await getRuleListBodies(db, [URL_A]);

    expect(bodies).toEqual(new Map([[URL_A, BODY_A]]));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refetches a stale body and upserts it', async () => {
    const oldFetchedAt = Date.now() - RULE_LIST_CACHE_TTL_MS - 1_000;
    seed(URL_A, 'STALE', oldFetchedAt);
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(ok(BODY_A));

    const bodies = await getRuleListBodies(db, [URL_A]);

    expect(bodies.get(URL_A)).toBe(BODY_A);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(URL_A);
    const cached = row(URL_A)!;
    expect(cached.body).toBe(BODY_A);
    expect(cached.fetchedAt).toBeGreaterThan(oldFetchedAt);
  });

  it('falls back to the stale body when the fetch fails', async () => {
    const oldFetchedAt = Date.now() - RULE_LIST_CACHE_TTL_MS - 1_000;
    seed(URL_A, 'LAST GOOD', oldFetchedAt);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(failure());

    const bodies = await getRuleListBodies(db, [URL_A]);

    expect(bodies.get(URL_A)).toBe('LAST GOOD');
    const cached = row(URL_A)!;
    expect(cached.body).toBe('LAST GOOD');
    expect(cached.fetchedAt).toBe(oldFetchedAt);
  });

  it('returns null for an uncached URL that cannot be fetched', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const bodies = await getRuleListBodies(db, [URL_A]);

    expect(bodies).toEqual(new Map([[URL_A, null]]));
    expect(row(URL_A)).toBeUndefined();
  });

  it('fetches each distinct URL once and fills every entry', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url) === URL_A) return ok(BODY_A);
      return ok(BODY_B);
    });

    const bodies = await getRuleListBodies(db, [URL_A, URL_B, URL_A]);

    expect(bodies).toEqual(
      new Map([
        [URL_A, BODY_A],
        [URL_B, BODY_B],
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(row(URL_A)?.body).toBe(BODY_A);
    expect(row(URL_B)?.body).toBe(BODY_B);
  });

  it('treats an oversized body as a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok('x'.repeat(16 * 1024 * 1024 + 1)));

    expect(await getRuleListBodies(db, [URL_A])).toEqual(new Map([[URL_A, null]]));
  });

  it('has a 12-hour TTL', () => {
    expect(RULE_LIST_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});
