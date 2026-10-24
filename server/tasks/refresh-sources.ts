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

/** Minimal subset of `Response`/`Headers` used by the refresh task. */
export interface ReadableBody {
  getReader(): ReadableStreamDefaultReader<Uint8Array>;
  cancel?(reason?: unknown): Promise<void>;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
  /** Streaming body; when absent the task falls back to `text()`. */
  body?: ReadableBody | null;
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

/** Abort a response body when we already know it is unacceptable. */
function abortSilently(body: FetchResponse['body']): void {
  try {
    const close = (body as { close?: () => void } | null | undefined)?.close;
    if (typeof close === 'function') close.call(body);
    // `close()` releases undici's connection; `cancel()` marks the stream done.
    const result = body?.cancel?.();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // Aborting is best effort; the caller already has its error.
  }
}

/**
 * Read a response body while counting bytes, aborting the stream (and throwing)
 * as soon as `maxBytes` is crossed. Falls back to `text()` for responses without
 * a streaming body, still validating the resulting size.
 */
async function readBodyWithLimit(
  response: FetchResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ body: string; bytes: number }> {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
    return { body: text, bytes };
  }

  const responseBody = response.body;
  const reader = responseBody.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const oversize = (): Error => new Error(`response exceeds ${maxBytes} bytes`);

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error('response aborted');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          // Stop pulling data from the socket immediately.
          await reader.cancel(oversize()).catch(() => {});
          throw oversize();
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    // Make sure a rejected read / timeout also tears down the stream.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }

  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
  return { body: new TextDecoder('utf-8').decode(buffer), bytes };
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
    const declared = response.headers?.get('content-length');
    if (declared !== null && declared !== undefined && declared.trim() !== '') {
      const declaredBytes = Number(declared);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        abortSilently(response.body);
        throw new Error(`response exceeds ${maxBytes} bytes (content-length ${declaredBytes})`);
      }
    }

    const body = await readBodyWithLimit(response, maxBytes, controller.signal);
    if (body.bytes === 0) throw new Error('empty response body');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mark a `local` source as successfully refreshed: it has no URL to fetch, so
 * "refresh" only clears a previously recorded error and keeps the cache. A
 * source without any cache still records that there is nothing to load.
 */
function refreshLocalSource(db: SubhubDb, source: Source, now: number): RefreshResult {
  if (!source.cacheBlob) {
    const message = 'local source has no cache';
    db.update(sources).set({ lastError: message }).where(eq(sources.id, source.id)).run();
    return { sourceId: source.id, outcome: 'failed', error: message };
  }
  db.update(sources)
    .set({ lastOkAt: new Date(now), lastError: null })
    .where(eq(sources.id, source.id))
    .run();
  return { sourceId: source.id, outcome: 'refreshed', bytes: Buffer.byteLength(source.cacheBlob, 'utf8') };
}

/**
 * Refresh a single source regardless of whether it is due. Never throws.
 *
 * `remote` sources are fetched and cached; `local` sources cannot be fetched,
 * so they are only re-stamped (their cache is kept). This is also the path the
 * manual refresh endpoint (`POST /api/admin/sources/:id/refresh`) uses.
 */
export async function refreshSource(
  db: SubhubDb,
  sourceId: number,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
  const now = (options.now ?? Date.now)();
  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!source) return { sourceId, outcome: 'skipped' };
  if (source.type !== 'remote') return refreshLocalSource(db, source, now);

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
