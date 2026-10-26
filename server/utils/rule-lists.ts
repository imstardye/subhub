// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Remote rule-list fetch + cache for inline rule-provider expansion.
 *
 * Bodies are cached in `rule_list_cache` for 12 hours. A cache miss or a stale
 * entry triggers a fetch; a failed fetch falls back to the stale body, or to
 * `null` when there has never been one. Callers get a per-URL map and the
 * function never throws: an unreachable list must leave today's remote
 * `RULE-SET` reference in place, not fail an export.
 */
import { inArray } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { ruleListCache } from '../db/schema';

/** How long a cached list body counts as fresh. */
export const RULE_LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Per-request timeout for one list fetch. */
export const RULE_LIST_FETCH_TIMEOUT_MS = 10_000;

/** Maximum accepted list body size. */
export const RULE_LIST_MAX_BYTES = 16 * 1024 * 1024;

/** Distinct lists fetched in parallel. */
export const RULE_LIST_FETCH_CONCURRENCY = 6;

async function fetchListBody(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RULE_LIST_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > RULE_LIST_MAX_BYTES) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function upsertBody(db: SubhubDb, url: string, body: string, fetchedAt: number): void {
  db.insert(ruleListCache)
    .values({ url, body, fetchedAt })
    .onConflictDoUpdate({
      target: ruleListCache.url,
      set: { body, fetchedAt },
    })
    .run();
}

/**
 * Bodies for every distinct URL, fresh from cache or fetched within the TTL.
 * The map has one entry per input URL; `null` means "no usable body".
 */
export async function getRuleListBodies(
  db: SubhubDb,
  urls: readonly string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const unique = [...new Set(urls.filter((url) => typeof url === 'string' && url !== ''))];
  if (unique.length === 0) return result;

  let rows: Array<typeof ruleListCache.$inferSelect>;
  try {
    rows = db.select().from(ruleListCache).where(inArray(ruleListCache.url, unique)).all();
  } catch {
    for (const url of unique) result.set(url, null);
    return result;
  }

  const cached = new Map(rows.map((row) => [row.url, row]));
  const now = Date.now();
  const pending: string[] = [];
  for (const url of unique) {
    const row = cached.get(url);
    if (row && now - row.fetchedAt < RULE_LIST_CACHE_TTL_MS) {
      result.set(url, row.body);
    } else {
      pending.push(url);
    }
  }

  const queue = [...pending];
  const workers = Math.min(RULE_LIST_FETCH_CONCURRENCY, queue.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        const stale = cached.get(url)?.body ?? null;
        const body = await fetchListBody(url);
        if (body === null) {
          result.set(url, stale);
          continue;
        }
        try {
          upsertBody(db, url, body, Date.now());
        } catch {
          // A cache write failure must not lose a successfully fetched body.
        }
        result.set(url, body);
      }
    }),
  );

  return result;
}
