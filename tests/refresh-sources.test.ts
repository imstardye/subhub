// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { parse as parseYaml } from 'yaml';
import { openDb, type SubhubDb } from '../server/db';
import { decrypt, encrypt } from '../server/db/crypto';
import { sources, users } from '../server/db/schema';
import {
  isSourceDue,
  refreshAllDueSources,
  refreshSource,
  type Fetcher,
  type FetchResponse,
} from '../server/tasks/refresh-sources';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import refreshSourcesHandler, {
  BodyTooLargeError,
  MAX_TRIGGER_BODY_BYTES,
  readBodyWithLimit,
  type TaskEvent,
  type TaskRequest,
} from '../server/api/tasks/refresh-sources.post';
import { __setServerDbForTest } from '../server/utils/db';
import { MAX_CACHE_BLOB_BYTES } from '../server/tasks/refresh-sources';

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

  it('refreshSource re-stamps a local source without fetching and keeps its cache', async () => {
    const id = insertSource({ type: 'local', cacheBlob: OLD_BODY, lastError: 'stale error' });
    const fetcher = vi.fn<Fetcher>(async () => okResponse(NEW_BODY));
    expect(await refreshSource(db, id, { fetcher, now: () => NOW })).toEqual({
      sourceId: id,
      outcome: 'refreshed',
      bytes: Buffer.byteLength(OLD_BODY, 'utf8'),
    });
    expect(fetcher).not.toHaveBeenCalled();
    const row = db.select().from(sources).where(eq(sources.id, id)).get()!;
    expect(row.cacheBlob).toBe(OLD_BODY);
    expect(row.lastError).toBeNull();
    expect(row.lastOkAt?.getTime()).toBe(NOW);
  });

  it('refreshSource reports failed for a local source without a cache', async () => {
    const id = insertSource({ type: 'local' });
    const fetcher = vi.fn<Fetcher>(async () => okResponse(NEW_BODY));
    const result = await refreshSource(db, id, { fetcher, now: () => NOW });
    expect(result).toMatchObject({ sourceId: id, outcome: 'failed' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.select().from(sources).where(eq(sources.id, id)).get()!.lastError).toContain('no cache');
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
    // Dedicated sources (ownerUserId): the export reads the owner column, not
    // the legacy user_sources join table.
    db.update(sources).set({ ownerUserId: user.id }).where(eq(sources.id, first)).run();
    db.update(sources).set({ ownerUserId: user.id }).where(eq(sources.id, second)).run();

    const fetcher = vi.fn<Fetcher>(async (url) =>
      okResponse(url === SECOND_SOURCE_URL ? OLD_BODY : NEW_BODY),
    );
    await refreshAllDueSources(db, { fetcher, now: () => NOW });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const mihomo = await handleSubscriptionExport({ token: TOKEN, target: 'mihomo' }, { db });
    expect(mihomo.status).toBe(200);
    const mihomoYaml = parseYaml(mihomo.body) as { proxies: Array<{ name: string }> };
    expect(mihomoYaml.proxies.map((proxy) => proxy.name)).toEqual(['cached-node', 'second-node', 'old-node']);

    const legacy = await handleSubscriptionExport({ token: TOKEN, target: 'clash' }, { db });
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
    db.update(sources).set({ ownerUserId: user.id }).where(eq(sources.id, id)).run();

    const fetcher = vi.fn<Fetcher>(async () => errorResponse(500));
    await refreshAllDueSources(db, { fetcher, now: () => NOW });

    const response = await handleSubscriptionExport({ token: TOKEN, target: 'mihomo' }, { db });
    const yaml = parseYaml(response.body) as { proxies: Array<{ name: string }> };
    expect(yaml.proxies.map((proxy) => proxy.name)).toEqual(['old-node']);
    expect(decrypt(db.select().from(sources).where(eq(sources.id, id)).get()!.url)).toBe(SOURCE_URL);
    resetExportRateLimiter();
  });
});


describe('refresh source body limits', () => {
  /** Build a fake streaming response from chunks, tracking cancellation. */
  function streamResponse(
    chunks: Uint8Array[],
    options: { contentLength?: string; cancelAfterChunks?: number } = {},
  ): { response: FetchResponse; state: { pulled: number; cancelled: boolean; cancelAfterChunks?: number } } {
    let index = 0;
    const state = { pulled: 0, cancelled: false, cancelAfterChunks: options.cancelAfterChunks };
    const response: FetchResponse = {
      ok: true,
      status: 200,
      headers: {
        get: (name) =>
          name.toLowerCase() === 'content-length' ? (options.contentLength ?? null) : null,
      },
      text: async () => {
        throw new Error('text() must not be used for streaming bodies');
      },
      body: {
        async cancel() {
          state.cancelled = true;
        },
        getReader() {
          return {
            async read() {
              if (state.cancelled || index >= chunks.length) return { done: true, value: undefined };
              state.pulled += 1;
              return { done: false, value: chunks[index++]! };
            },
            async cancel() {
              state.cancelled = true;
            },
            releaseLock() {},
            get closed(): Promise<void> {
              return Promise.resolve();
            },
          };
        },
      },
    };
    return { response, state };
  }

  it('rejects a stream that crosses maxBytes mid-way and cancels the reader', async () => {
    const sourceId = insertSource({ lastOkAt: null, cacheBlob: OLD_BODY });
    const chunk = new Uint8Array(1024).fill(0x61);
    const { response, state } = streamResponse(new Array(20).fill(chunk));
    const fetcher = vi.fn<Fetcher>(async () => response);

    const result = await refreshSource(db, sourceId, { fetcher, now: () => NOW, maxBytes: 4 * 1024 });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('response exceeds 4096 bytes');
    expect(state.cancelled).toBe(true);
    // Stopped pulling as soon as the cap was crossed (5th 1 KiB chunk).
    expect(state.pulled).toBe(5);

    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
    expect(row.cacheBlob).toBe(OLD_BODY);
    expect(row.lastOkAt).toBeNull();
    expect(row.lastError).toContain('response exceeds');
  });

  it('rejects an oversized Content-Length before reading the body', async () => {
    const sourceId = insertSource({ lastOkAt: null });
    const { response, state } = streamResponse([new Uint8Array(8).fill(0x61)], {
      contentLength: String(MAX_CACHE_BLOB_BYTES + 1),
    });
    const fetcher = vi.fn<Fetcher>(async () => response);

    const result = await refreshSource(db, sourceId, { fetcher, now: () => NOW });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain(`response exceeds ${MAX_CACHE_BLOB_BYTES} bytes`);
    expect(state.pulled).toBe(0);
    expect(state.cancelled).toBe(true);

    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
    expect(row.cacheBlob).toBeNull();
    expect(row.lastOkAt).toBeNull();
  });

  it('streams a body under the cap and decodes it as UTF-8', async () => {
    const sourceId = insertSource({ lastOkAt: null });
    const encoded = new TextEncoder().encode(NEW_BODY);
    // Split inside a multi-byte sequence to exercise whole-buffer decoding.
    const splitAt = encoded.length - 5;
    const { response, state } = streamResponse(
      [encoded.slice(0, splitAt), encoded.slice(splitAt)],
      { contentLength: String(encoded.length) },
    );
    const fetcher = vi.fn<Fetcher>(async () => response);

    const result = await refreshSource(db, sourceId, { fetcher, now: () => NOW });

    expect(result).toMatchObject({ outcome: 'refreshed', bytes: encoded.length });
    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
    expect(row.cacheBlob).toBe(NEW_BODY);
  });

  it('falls back to text() when the response has no stream, still enforcing the cap', async () => {
    const sourceId = insertSource({ lastOkAt: null, cacheBlob: OLD_BODY });
    const small = await refreshSource(db, sourceId, {
      fetcher: async () => ({ ok: true, status: 200, text: async () => NEW_BODY, body: null }),
      now: () => NOW,
      maxBytes: 1024,
    });
    expect(small.outcome).toBe('refreshed');

    const large = await refreshSource(db, sourceId, {
      fetcher: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(2048) }),
      now: () => NOW,
      maxBytes: 1024,
    });
    expect(large.outcome).toBe('failed');
    expect(large.error).toContain('response exceeds 1024 bytes');
    const row = db.select().from(sources).where(eq(sources.id, sourceId)).get()!;
    expect(row.cacheBlob).toBe(NEW_BODY);
  });
});

/** Minimal fake Nitro event: a request with headers/stream and a response. */
function fakeEvent(options: {
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
  body?: Readable;
} = {}): TaskEvent & { headersSent: Map<string, string>; destroyed: boolean } {
  const headersSent = new Map<string, string>();
  const req = {
    url: options.url ?? '/api/tasks/refresh-sources',
    headers: options.headers ?? {},
    on: options.body
      ? (event: string, listener: (...args: unknown[]) => void) => {
          options.body!.on(event, listener);
          return req;
        }
      : undefined,
    destroy: () => {},
  };
  const event = {
    node: {
      req: req as TaskRequest,
      res: {
        statusCode: 200,
        setHeader(name: string, value: string) {
          headersSent.set(name.toLowerCase(), value);
        },
      },
    },
    headersSent,
    destroyed: false,
  };
  event.node.req.destroy = () => {
    event.destroyed = true;
    options.body?.destroy();
  };
  return event;
}

/** A Readable emitting `chunks` asynchronously, like a socket body. */
function chunkedBody(chunks: Array<Buffer | string>, chunkSize = 4 * 1024): Readable {
  const buffers = chunks.flatMap((chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const slices: Buffer[] = [];
    for (let i = 0; i < buffer.length; i += chunkSize) slices.push(buffer.subarray(i, i + chunkSize));
    return slices;
  });
  return Readable.from(buffers);
}

describe('POST /api/tasks/refresh-sources auth', () => {
  const PASSWORD = 'test-admin-password';
  const auth = { password: PASSWORD };

  beforeEach(() => {
    __setServerDbForTest(db);
  });

  afterEach(() => {
    __setServerDbForTest(null);
  });

  function call(headers: Record<string, string | string[] | undefined>, url?: string) {
    return refreshSourcesHandler(fakeEvent({ headers, url }), auth);
  }

  it('rejects a missing header with 401', async () => {
    const event = fakeEvent({});
    expect(await refreshSourcesHandler(event, auth)).toEqual({ error: 'unauthorized' });
    expect(event.node.res.statusCode).toBe(401);
  });

  it('rejects a wrong header with 401', async () => {
    const event = fakeEvent({ headers: { 'x-admin-password': 'wrong' } });
    await refreshSourcesHandler(event, auth);
    expect(event.node.res.statusCode).toBe(401);
  });

  it('rejects every request when SUBHUB_ADMIN_PASSWORD is not configured', async () => {
    const event = fakeEvent({ headers: { 'x-admin-password': 'subhub-dev-admin' } });
    await refreshSourcesHandler(event, { password: null });
    expect(event.node.res.statusCode).toBe(401);
  });

  it('refreshes when the header matches the configured password', async () => {
    const sourceId = insertSource({ lastOkAt: null });
    // The trigger uses the real task and therefore the global `fetch`.
    // Stub it so the test stays hermetic (no network, no proxy, no timeout
    // flakiness) — this asserts the auth/trigger wiring, not the fetch itself.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(NEW_BODY, { status: 200 }),
    );
    try {
      const event = fakeEvent({
        headers: { 'x-admin-password': PASSWORD },
        url: `/api/tasks/refresh-sources?sourceId=${sourceId}`,
      });
      const result = (await refreshSourcesHandler(event, auth)) as { checked: number };
      expect(event.node.res.statusCode).toBe(200);
      expect(result.checked).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('validates sourceId only after authentication', async () => {
    const event = fakeEvent({ url: '/api/tasks/refresh-sources?sourceId=abc' });
    expect(await refreshSourcesHandler(event, auth)).toEqual({ error: 'unauthorized' });
    expect(event.node.res.statusCode).toBe(401);
  });
});

describe('POST /api/tasks/refresh-sources body limit', () => {
  const PASSWORD = 'test-admin-password';
  const auth = { password: PASSWORD };
  const headers = { 'x-admin-password': PASSWORD };

  beforeEach(() => {
    __setServerDbForTest(db);
  });

  afterEach(() => {
    __setServerDbForTest(null);
  });

  it('rejects an oversized Content-Length immediately, without reading', async () => {
    let read = false;
    const body = new Readable({
      read() {
        read = true;
      },
    });
    const event = fakeEvent({
      headers: { ...headers, 'content-length': String(MAX_TRIGGER_BODY_BYTES + 1) },
      body,
    });
    expect(await refreshSourcesHandler(event, auth)).toEqual({ error: 'request body too large' });
    expect(event.node.res.statusCode).toBe(413);
    expect(event.destroyed).toBe(true);
    expect(read).toBe(false);
  });

  it('readBodyWithLimit aborts mid-stream once the cap is crossed', async () => {
    const body = chunkedBody([Buffer.alloc(MAX_TRIGGER_BODY_BYTES * 4, 0x61)]);
    const event = fakeEvent({ body });
    await expect(readBodyWithLimit(event.node.req)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(event.destroyed).toBe(true);
  });

  it('responds 413 when a chunked body exceeds the cap', async () => {
    const body = chunkedBody([Buffer.alloc(MAX_TRIGGER_BODY_BYTES * 2, 0x62)]);
    const event = fakeEvent({ headers, body });
    expect(await refreshSourcesHandler(event, auth)).toEqual({ error: 'request body too large' });
    expect(event.node.res.statusCode).toBe(413);
    expect(event.headersSent.get('connection')).toBe('close');
    expect(event.destroyed).toBe(true);
  });

  it('accepts a small body and still runs the refresh', async () => {
    const event = fakeEvent({
      headers: { ...headers, 'content-length': '2' },
      body: chunkedBody(['{}']),
    });
    const result = (await refreshSourcesHandler(event, auth)) as { checked: number };
    expect(event.node.res.statusCode).toBe(200);
    expect(result.checked).toBe(0);
  });

  it('uses the exported default body cap', () => {
    expect(MAX_TRIGGER_BODY_BYTES).toBeLessThanOrEqual(16 * 1024);
  });
});
