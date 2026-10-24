// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Regression: admin create/update routes read the real request stream.
 *
 * Production bug: every admin write answered 400 'invalid JSON body' even for
 * perfectly valid JSON. In the Nitro node runtime none of the buffered body
 * sources exist (`req.body`, `event._requestBody`, the h3 raw-body symbol,
 * `web.request.body`), and `readJsonBody` never touched `event.node.req` — so
 * the body was simply undefined. The old unit tests missed it because their
 * fake events carried a pre-parsed `req.body`.
 *
 * These events therefore have a node readable stream as the ONLY body source
 * (tests/helpers/admin-api.ts -> `streamApiEvent`). Same harness as the other
 * admin tests: handlers called directly, temp SQLite, `example.com` fixtures.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import usersCreateHandler from '../server/api/admin/users/index.post';
import userUpdateHandler from '../server/api/admin/users/[id].patch';
import sourcesCreateHandler from '../server/api/admin/sources/index.post';
import sourceUpdateHandler from '../server/api/admin/sources/[id].patch';
import profilesCreateHandler from '../server/api/admin/profiles/index.post';
import profileUpdateHandler from '../server/api/admin/profiles/[id].patch';
import previewHandler from '../server/api/admin/preview/index.post';
import {
  createSessionRevocationStore,
  type SessionRevocationStore,
} from '../server/utils/session-revocation';
import { MAX_JSON_BODY_BYTES } from '../server/utils/admin-api';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import type { AdminApiEvent } from '../server/utils/admin-api';
import { authenticatedStreamEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;
const INI_TEXT = '[custom_proxy_group]\n🚀 节点选择`select`.*\n\n[ruleset]\n[]GEOIP,CN';

type AdminApiHandler = (
  event: AdminApiEvent,
  options?: { db?: SubhubDb; revocations?: SessionRevocationStore },
) => unknown;

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let base: { db: SubhubDb; options: { db: SubhubDb; revocations: SessionRevocationStore } };

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;

  const dir = mkdtempSync(join(tmpdir(), 'subhub-admin-stream-'));
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

/** Authenticated event whose body only exists as a node request stream. */
function streamed(url: string, body: string | Buffer | Array<Buffer | string>, method = 'POST') {
  return authenticatedStreamEvent({ url, method, body }, base.options.revocations);
}

/** Send `raw` and return the handler result plus the recorded status. */
async function send(handler: AdminApiHandler, url: string, raw: string, method = 'POST') {
  const { event } = streamed(url, raw, method);
  const result = await handler(event, base.options);
  return { event, status: event.node.res.statusCode, result };
}

const VALID: Array<[string, string, AdminApiHandler, Record<string, unknown>]> = [
  [
    'POST /api/admin/users',
    '/api/admin/users',
    usersCreateHandler,
    { name: 'stream-user', note: 'fixture note' },
  ],
  [
    'POST /api/admin/sources',
    '/api/admin/sources',
    sourcesCreateHandler,
    { name: 'stream-source', url: 'https://example.com/subscribe?id=fixture-token' },
  ],
  [
    'POST /api/admin/profiles',
    '/api/admin/profiles',
    profilesCreateHandler,
    { name: 'stream-profile', iniText: INI_TEXT },
  ],
];

describe('admin create routes read the raw request stream', () => {
  for (const [label, url, handler, body] of VALID) {
    it(`${label} succeeds with valid JSON on node.req`, async () => {
      const { status, result } = await send(handler, url, JSON.stringify(body));
      expect(status).toBe(201);
      const item = (result as { item: Record<string, unknown> }).item;
      expect(item.name).toBe(body.name);
    });
  }

  it('POST /api/admin/preview succeeds with valid JSON on node.req', async () => {
    const { event: createEvent } = streamed('/api/admin/users', JSON.stringify({ name: 'fixture' }));
    await usersCreateHandler(createEvent, base.options);
    const created = base.db.select().from(users).all()[0]!;

    const { status, result } = await send(
      previewHandler,
      '/api/admin/preview',
      JSON.stringify({ userId: created.id }),
    );
    expect(status).toBe(200);
    expect((result as { userId: unknown }).userId).toBe(created.id);
  });

  it('accepts a body split across several stream chunks', async () => {
    const raw = JSON.stringify({ name: 'chunked-user' });
    const { event } = streamed('/api/admin/users', [
      raw.slice(0, 5),
      raw.slice(5, 12),
      raw.slice(12),
    ]);
    const res = await usersCreateHandler(event, base.options);
    expect(event.node.res.statusCode).toBe(201);
    expect((res as { item: Record<string, unknown> }).item.name).toBe('chunked-user');
  });
});

describe('admin routes reject bad streamed JSON as before', () => {
  for (const [label, url, handler, body] of VALID) {
    it(`${label} answers 400 'invalid JSON body' for malformed JSON`, async () => {
      const { status, result } = await send(handler, url, '{"name":');
      expect(status).toBe(400);
      expect(result).toEqual({ error: 'invalid JSON body' });
    });

    it(`${label} answers 400 'invalid JSON body' for an over-cap stream`, async () => {
      // Valid JSON overall, but past MAX_JSON_BODY_BYTES: must be rejected
      // exactly like any other invalid body (no partial parse, no 500).
      const oversized = JSON.stringify({ ...body, note: 'x'.repeat(MAX_JSON_BODY_BYTES) });
      expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_JSON_BODY_BYTES);
      const { status, result } = await send(handler, url, oversized);
      expect(status).toBe(400);
      expect(result).toEqual({ error: 'invalid JSON body' });
    });

    it(`${label} answers 400 'invalid JSON body' for a non-object JSON body`, async () => {
      const { status, result } = await send(handler, url, '[]');
      expect(status).toBe(400);
      expect(result).toEqual({ error: 'invalid JSON body' });
    });
  }

  it('POST /api/admin/preview rejects malformed and over-cap streams', async () => {
    for (const raw of ['not json', JSON.stringify({ userId: 1, pad: 'y'.repeat(MAX_JSON_BODY_BYTES) })]) {
      const { status, result } = await send(previewHandler, '/api/admin/preview', raw);
      expect(status).toBe(400);
      expect(result).toEqual({ error: 'invalid JSON body' });
    }
  });

  it('treats an empty stream as an invalid body', async () => {
    const { status, result } = await send(usersCreateHandler, '/api/admin/users', '');
    expect(status).toBe(400);
    expect(result).toEqual({ error: 'invalid JSON body' });
  });
});

describe('admin update routes read the raw request stream', () => {
  async function seed() {
    const { event: userEvent } = streamed('/api/admin/users', JSON.stringify({ name: 'fixture' }));
    const user = ((await usersCreateHandler(userEvent, base.options)) as {
      item: Record<string, unknown>;
    }).item;
    const { event: sourceEvent } = streamed(
      '/api/admin/sources',
      JSON.stringify({ name: 'fixture', url: 'https://example.com/subscribe?id=fixture-token' }),
    );
    const source = ((await sourcesCreateHandler(sourceEvent, base.options)) as {
      item: Record<string, unknown>;
    }).item;
    const { event: profileEvent } = streamed(
      '/api/admin/profiles',
      JSON.stringify({ name: 'fixture', iniText: INI_TEXT }),
    );
    const profile = ((await profilesCreateHandler(profileEvent, base.options)) as {
      item: Record<string, unknown>;
    }).item;
    return { user, source, profile };
  }

  it('PATCH /api/admin/users/[id] applies a streamed body', async () => {
    const { user } = await seed();
    const { status, result } = await send(
      userUpdateHandler,
      `/api/admin/users/${user.id}`,
      JSON.stringify({ name: 'renamed', enabled: false }),
      'PATCH',
    );
    expect(status).toBe(200);
    expect((result as { item: Record<string, unknown> }).item).toMatchObject({
      name: 'renamed',
      enabled: false,
    });
  });

  it('PATCH /api/admin/sources/[id] applies a streamed body', async () => {
    const { source } = await seed();
    const { status, result } = await send(
      sourceUpdateHandler,
      `/api/admin/sources/${source.id}`,
      JSON.stringify({ name: 'renamed', refreshMinutes: 120 }),
      'PATCH',
    );
    expect(status).toBe(200);
    expect((result as { item: Record<string, unknown> }).item).toMatchObject({
      name: 'renamed',
      refreshMinutes: 120,
    });
  });

  it('PATCH /api/admin/profiles/[id] applies a streamed body', async () => {
    const { profile } = await seed();
    const { status, result } = await send(
      profileUpdateHandler,
      `/api/admin/profiles/${profile.id}`,
      JSON.stringify({ name: 'renamed' }),
      'PATCH',
    );
    expect(status).toBe(200);
    expect((result as { item: Record<string, unknown> }).item.name).toBe('renamed');
  });

  it('PATCH routes answer 400 for malformed streamed bodies', async () => {
    const { user, source, profile } = await seed();
    for (const [handler, url] of [
      [userUpdateHandler, `/api/admin/users/${user.id}`],
      [sourceUpdateHandler, `/api/admin/sources/${source.id}`],
      [profileUpdateHandler, `/api/admin/profiles/${profile.id}`],
    ] as const) {
      const { status, result } = await send(handler, url, '{"name":', 'PATCH');
      expect(status).toBe(400);
      expect(result).toEqual({ error: 'invalid JSON body' });
    }
  });
});

describe('admin body reader never hangs or throws on a missing/spent stream', () => {
  it('answers 400 when the request has no stream at all', async () => {
    const { event } = authenticatedStreamEvent({ body: '', url: '/api/admin/users' }, base.options.revocations);
    // Simulate an adapter/test request without a node readable.
    const bare = {
      ...event,
      node: { ...event.node, req: { ...event.node.req, on: undefined } },
    } as AdminApiEvent;
    const res = await usersCreateHandler(bare, base.options);
    expect(bare.node.res.statusCode).toBe(400);
    expect(res).toEqual({ error: 'invalid JSON body' });
  });

  it('answers 400 when the stream was already consumed', async () => {
    const { event, readable } = streamed('/api/admin/users', JSON.stringify({ name: 'spent' }));
    for await (const _chunk of readable) {
      // drain the body the way an earlier handler would
    }
    expect(readable.readableEnded).toBe(true);
    const res = await usersCreateHandler(event, base.options);
    expect(event.node.res.statusCode).toBe(400);
    expect(res).toEqual({ error: 'invalid JSON body' });
    expect(base.db.select().from(users).all()).toHaveLength(0);
  });

  it('answers 400 when the stream errors', async () => {
    const { event } = streamed('/api/admin/users', JSON.stringify({ name: 'broken' }));
    const broken = {
      ...event,
      node: {
        ...event.node,
        req: {
          ...event.node.req,
          on(eventName: string, listener: (...args: unknown[]) => void) {
            if (eventName === 'error') {
              setImmediate(() => listener(new Error('fixture stream error')));
            }
            return event.node.req;
          },
        },
      },
    } as AdminApiEvent;
    const res = await usersCreateHandler(broken, base.options);
    expect(broken.node.res.statusCode).toBe(400);
    expect(res).toEqual({ error: 'invalid JSON body' });
  });

  it('prefers a buffered body over the stream, unchanged', async () => {
    // Buffered sources keep working exactly as before (regression guard for
    // the old behaviour); the stream here carries different data and must be
    // ignored.
    const { event } = authenticatedStreamEvent(
      { body: JSON.stringify({ name: 'from-stream' }), url: '/api/admin/users' },
      base.options.revocations,
    );
    (event.node.req as { body?: unknown }).body = { name: 'from-buffer' };
    const res = await usersCreateHandler(event, base.options);
    expect(event.node.res.statusCode).toBe(201);
    expect((res as { item: Record<string, unknown> }).item.name).toBe('from-buffer');
    expect(base.db.select().from(users).all()).toHaveLength(1);
    expect(base.db.select().from(sources).all()).toHaveLength(0);
    expect(base.db.select().from(profiles).all()).toHaveLength(0);
  });

  it('still rejects an over-cap buffered body', async () => {
    const { event } = authenticatedStreamEvent(
      { body: '{}', url: '/api/admin/users' },
      base.options.revocations,
    );
    (event.node.req as { body?: unknown }).body = JSON.stringify({
      name: 'x',
      note: 'z'.repeat(MAX_JSON_BODY_BYTES),
    });
    const res = await usersCreateHandler(event, base.options);
    expect(event.node.res.statusCode).toBe(400);
    expect(res).toEqual({ error: 'invalid JSON body' });
  });
});
