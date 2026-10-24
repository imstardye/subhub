// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Remote source cache refresh.
 *
 * For every `type = 'remote'` source whose `last_ok_at` is missing or older than
 * `refresh_minutes`, fetch the (decrypted) subscription URL and store the raw
 * payload in `cache_blob`, then stamp `last_ok_at`. On failure only
 * `last_error` is written — the previous `cache_blob` is kept so exports keep
 * working with the last known-good subscription.
 *
 * Plain module (no Nitro globals) so it can be driven by a Nitro task, a manual
 * call, or unit tests with an injected fetcher. Tests must never hit the
 * network: pass `fetcher` (see tests/refresh-sources.test.ts).
 */
import { and, asc, eq } from 'drizzle-orm';
import { decrypt } from '../db/crypto';
import type { SubhubDb } from '../db';
import { sources, type Source } from '../db/schema';

/** Default response cap; remote sources above this are rejected as too large. */
export const MAX_CACHE_BLOB_BYTES = 10 * 1024 * 1024;

/** Default per-request timeout in milliseconds. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Minimal fetcher shape (compatible with global `fetch`). */
export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchResponse>;

export interface RefreshOptions {
  /** Injected HTTP client; defaults to the global `fetch`. */
  fetcher?: Fetcher;
  /** Clock override for tests. */
  now?: () => number;
  /** Per-request timeout, default `DEFAULT_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Max accepted body size, default `MAX_CACHE_BLOB_BYTES`. */
  maxBytes?: number;
}

export type RefreshOutcome = 'refreshed' | 'failed' | 'skipped';

export interface RefreshResult {
  sourceId: number;
  outcome: RefreshOutcome;
  /** Error message for `failed`, undefined otherwise. */
  error?: string;
  /** Body size written for `refreshed`. */
  bytes?: number;
}

export interface RefreshAllResult {
  checked: number;
  refreshed: number;
  failed: number;
  skipped: number;
  results: RefreshResult[];
}

function defaultFetcher(): Fetcher {
  return (url, init) => fetch(url, init) as unknown as Promise<FetchResponse>;
}

/** A source is due when it never succeeded or its last success is older than refresh_minutes. */
export function isSourceDue(source: Pick<Source, 'refreshMinutes' | 'lastOkAt'>, now: number): boolean {
  if (!source.lastOkAt) return true;
  const minutes = Number.isFinite(source.refreshMinutes) ? source.refreshMinutes : 60;
  if (minutes <= 0) return true;
  return now - source.lastOkAt.getTime() >= minutes * 60_000;
}

function truncateError(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim() || 'unknown error';
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function fetchSourceBody(
  source: Source,
  options: RefreshOptions,
): Promise<{ body: string; bytes: number }> {
  let url: string;
  try {
    url = decrypt(source.url);
  } catch (error) {
    throw new Error(`cannot decrypt source URL: ${errorMessage(error)}`);
  }

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme: ${parsed.protocol}`);
  }

  const fetcher = options.fetcher ?? defaultFetcher();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_CACHE_BLOB_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      'user-agent': source.ua?.trim() || 'subhub/1.0',
      accept: '*/*',
    };
    const response = await fetcher(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.text();
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes === 0) throw new Error('empty response body');
    if (bytes > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    return { body, bytes };
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh a single source regardless of whether it is due. Never throws. */
export async function refreshSource(
  db: SubhubDb,
  sourceId: number,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const now = (options.now ?? Date.now)();
  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source || source.type !== 'remote') {
    return { sourceId, outcome: 'skipped' };
  }

  try {
    const { body, bytes } = await fetchSourceBody(source, options);
    db.update(sources)
      .set({
        cacheBlob: body,
        lastOkAt: new Date(now),
        lastError: null,
      })
      .where(eq(sources.id, sourceId))
      .run();
    return { sourceId, outcome: 'refreshed', bytes };
  } catch (error) {
    // Keep the previous cache_blob; only record the failure.
    const message = truncateError(errorMessage(error));
    db.update(sources)
      .set({ lastError: message })
      .where(eq(sources.id, sourceId))
      .run();
    return { sourceId, outcome: 'failed', error: message };
  }
}

/**
 * Refresh every remote source whose cache is stale. `sourceId` narrows the run
 * to one source (still skipped when it is not due unless `force` is set).
 */
export async function refreshAllDueSources(
  db: SubhubDb,
  options: RefreshOptions & { sourceId?: number; force?: boolean } = {},
): Promise<RefreshAllResult> {
  const now = (options.now ?? Date.now)();
  const rows = db
    .select()
    .from(sources)
    .where(
      options.sourceId !== undefined
        ? and(eq(sources.type, 'remote'), eq(sources.id, options.sourceId))
        : eq(sources.type, 'remote'),
    )
    .orderBy(asc(sources.id))
    .all();

  const summary: RefreshAllResult = { checked: 0, refreshed: 0, failed: 0, skipped: 0, results: [] };
  for (const row of rows) {
    summary.checked += 1;
    if (!options.force && !isSourceDue(row, now)) {
      summary.skipped += 1;
      summary.results.push({ sourceId: row.id, outcome: 'skipped' });
      continue;
    }
    const result = await refreshSource(db, row.id, options);
    summary[result.outcome] += 1;
    summary.results.push(result);
  }
  return summary;
}
