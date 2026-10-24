// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user subscription token: refresh (regenerate) and custom tokens.
 *
 * Covers the two admin endpoints and their effect on the public export:
 * - POST /api/admin/users/:id/reset-token — the old token 404s immediately, the
 *   new one serves the byte-identical body;
 * - PUT  /api/admin/users/:id/token      — admin-chosen token (8–64 chars,
 *   /^[a-z0-9][a-z0-9_-]*$/i, unique across users: 409 when taken);
 * - another user's token is never touched, and the access log follows the new
 *   token because the export looks the user up by token on every request.
 *
 * Same harness as the other admin tests: fake events
 * (tests/helpers/admin-api.ts) against a temporary SQLite database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import userResetTokenHandler from '../server/api/admin/users/[id]/reset-token.post';
import userTokenHandler from '../server/api/admin/users/[id]/token.put';
import { openDb, type SubhubDb } from '../server/db';
import { accessLogs, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import {
  CUSTOM_TOKEN_MAX_LENGTH,
  CUSTOM_TOKEN_MIN_LENGTH,
  generateUserToken,
  parseCustomToken,
  TOKEN_BYTES,
} from '../server/utils/admin-validation';
import { resetUserToken, setUserToken } from '../server/utils/admin-users';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { createSessionRevocationStore, type SessionRevocationStore } from '../server/utils/session-revocation';
import { validateCustomToken } from '../core/utils/token-form';
import { authenticatedEvent, makeApiEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;
/** 32 hex chars (fixture only). */
const ALICE_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BOB_TOKEN = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let db: SubhubDb;
let options: { db: SubhubDb; revocations: SessionRevocationStore };
let aliceId: number;
let bobId: number;

beforeEach(() => {
  resetExportRateLimiter();
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;

  const dir = mkdtempSync(join(tmpdir(), 'subhub-token-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
  options = { db, revocations: createSessionRevocationStore() };

  aliceId = db
    .insert(users)
    .values({ name: 'fixture-alice', token: ALICE_TOKEN, enabled: true })
    .returning({ id: users.id })
    .get()!.id;
  bobId = db
    .insert(users)
    .values({ name: 'fixture-bob', token: BOB_TOKEN, enabled: true })
    .returning({ id: users.id })
    .get()!.id;

  // One dedicated source per user so each body is distinct and non-empty.
  for (const [owner, host] of [
    [aliceId, 'a.example.com'],
    [bobId, 'b.example.com'],
  ] as const) {
    db.insert(sources)
      .values({
        name: `fixture-source-${owner}`,
        url: encrypt('placeholder-source-not-a-real-subscription'),
        type: 'local',
        ownerUserId: owner,
        cacheBlob: `proxies:\n  - {name: "node-${owner}", type: ss, server: ${host}, port: 8388, cipher: aes-128-gcm, password: "fake"}\n`,
      })
      .run();
  }
});

afterEach(() => {
  resetExportRateLimiter();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function post(id: number, body?: unknown) {
  const { event } = authenticatedEvent(
    { url: `/api/admin/users/${id}/token`, method: 'PUT', body },
    options.revocations,
  );
  const result = await userTokenHandler(event, options);
  return { status: event.node.res.statusCode, body: result as { item?: Record<string, unknown>; error?: string } };
}

async function refresh(id: number) {
  const { event } = authenticatedEvent(
    { url: `/api/admin/users/${id}/reset-token`, method: 'POST' },
    options.revocations,
  );
  const result = await userResetTokenHandler(event, options);
  return { status: event.node.res.statusCode, body: result as { item?: Record<string, unknown> } };
}

function exportWith(token: string) {
  return handleSubscriptionExport({ token, target: 'clash', userAgent: 'clash-verge/v2.0' }, { db });
}

describe('parseCustomToken', () => {
  it('accepts 8–64 URL-safe characters', () => {
    expect(parseCustomToken('abcd1234')).toBe('abcd1234');
    expect(parseCustomToken('My-Company_01')).toBe('My-Company_01');
    expect(parseCustomToken('a'.repeat(CUSTOM_TOKEN_MAX_LENGTH))).toHaveLength(64);
    expect(parseCustomToken(`  ${'x'.repeat(64)}  `)).toHaveLength(64);
  });

  it('rejects too short/long and non-URL characters', () => {
    for (const bad of [
      '',
      '   ',
      'abc1234', // 7 chars
      'x'.repeat(CUSTOM_TOKEN_MAX_LENGTH + 1),
      '-abc1234',
      '_abc1234',
      'ab.cdefgh',
      'ab/cdefgh',
      'ab cdefgh',
      '中文令牌abcdef',
    ]) {
      expect(() => parseCustomToken(bad), bad).toThrow();
    }
    expect(() => parseCustomToken(42)).toThrow();
    expect(CUSTOM_TOKEN_MIN_LENGTH).toBe(8);
  });
});

describe('POST /api/admin/users/:id/reset-token', () => {
  it('changes the token; the old link 404s and the new one serves the same body', async () => {
    const before = await exportWith(ALICE_TOKEN);
    expect(before.status).toBe(200);

    const res = await refresh(aliceId);
    expect(res.status).toBe(200);
    const token = res.body.item!.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(ALICE_TOKEN);
    // Same strength as the generator (32 random bytes, hex).
    expect(token.length).toBe(TOKEN_BYTES * 2);

    expect((await exportWith(ALICE_TOKEN)).status).toBe(404);
    const after = await exportWith(token);
    expect(after.status).toBe(200);
    expect(after.body).toBe(before.body);

    // The row is the source of truth and only the token changed.
    const row = db.select().from(users).where(eq(users.id, aliceId)).get()!;
    expect(row.token).toBe(token);
    expect(row.name).toBe('fixture-alice');
  });

  it('leaves the other user untouched', async () => {
    await refresh(aliceId);
    expect(db.select().from(users).where(eq(users.id, bobId)).get()!.token).toBe(BOB_TOKEN);
    expect((await exportWith(BOB_TOKEN)).status).toBe(200);
  });

  it('access logs follow the new token (no token→user cache)', async () => {
    const res = await refresh(aliceId);
    const token = res.body.item!.token as string;
    await exportWith(token);
    const last = db.select().from(accessLogs).orderBy(accessLogs.id).all().at(-1)!;
    expect(last.userId).toBe(aliceId);
    expect(last.status).toBe(200);
    // The old token is an unknown-token 404, not a stale user hit.
    await exportWith(ALICE_TOKEN);
    const miss = db.select().from(accessLogs).orderBy(accessLogs.id).all().at(-1)!;
    expect(miss.userId).toBeNull();
    expect(miss.status).toBe(404);
  });

  it('404s for an unknown user', async () => {
    const res = await refresh(999);
    expect(res.status).toBe(404);
  });

  it('requires a session', async () => {
    const anon = makeApiEvent({ url: `/api/admin/users/${aliceId}/reset-token`, method: 'POST' });
    const result = (await userResetTokenHandler(anon.event, options)) as { error?: string };
    expect(anon.event.node.res.statusCode).toBe(401);
    expect(result.error).toBe('unauthorized');
    expect(db.select().from(users).where(eq(users.id, aliceId)).get()!.token).toBe(ALICE_TOKEN);
  });
});

describe('PUT /api/admin/users/:id/token', () => {
  it('sets a custom token and serves the export under it', async () => {
    const before = await exportWith(ALICE_TOKEN);
    const res = await post(aliceId, { token: 'My-Private-Link' });
    expect(res.status).toBe(200);
    expect(res.body.item!.token).toBe('My-Private-Link');

    expect((await exportWith(ALICE_TOKEN)).status).toBe(404);
    const after = await exportWith('My-Private-Link');
    expect(after.status).toBe(200);
    expect(after.body).toBe(before.body);
  });

  it('rejects a duplicate token with 409 and keeps both users working', async () => {
    const res = await post(aliceId, { token: BOB_TOKEN });
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
    expect(db.select().from(users).where(eq(users.id, aliceId)).get()!.token).toBe(ALICE_TOKEN);
    expect(db.select().from(users).where(eq(users.id, bobId)).get()!.token).toBe(BOB_TOKEN);

    // Case matters (the token is the URL segment): a different case is fine.
    const other = await post(aliceId, { token: BOB_TOKEN.toUpperCase() });
    expect(other.status).toBe(200);
    expect((await exportWith(BOB_TOKEN)).status).toBe(200);
  });

  it('rejects an invalid token with 400 and keeps the old one', async () => {
    for (const bad of ['short', 'a'.repeat(65), '-leading', 'has space', 'a/b', '', null, 42]) {
      const res = await post(aliceId, { token: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(db.select().from(users).where(eq(users.id, aliceId)).get()!.token).toBe(ALICE_TOKEN);
    }
    // Missing body.
    const noBody = await post(aliceId);
    expect(noBody.status).toBe(400);
  });

  it('is idempotent for the user\'s own current token', async () => {
    const res = await post(aliceId, { token: ALICE_TOKEN });
    expect(res.status).toBe(200);
    expect((await exportWith(ALICE_TOKEN)).status).toBe(200);
  });

  it('404s for an unknown user and 401s without a session', async () => {
    expect((await post(999, { token: 'valid-token-1' })).status).toBe(404);

    const anon = makeApiEvent({
      url: `/api/admin/users/${aliceId}/token`,
      method: 'PUT',
      body: { token: 'valid-token-1' },
    });
    const result = (await userTokenHandler(anon.event, options)) as { error?: string };
    expect(anon.event.node.res.statusCode).toBe(401);
    expect(result.error).toBe('unauthorized');
    expect(db.select().from(users).where(eq(users.id, aliceId)).get()!.token).toBe(ALICE_TOKEN);
  });

  it('never touches the other user, even when taking the token of a deleted one', async () => {
    db.delete(users).where(eq(users.id, bobId)).run();
    const res = await setUserTokenSafe(aliceId, BOB_TOKEN);
    expect(res.status).toBe(200);
    expect((await exportWith(BOB_TOKEN)).status).toBe(200);
  });
});

/** `setUserToken` without the route, to read the thrown ValidationError status. */
async function setUserTokenSafe(id: number, token: string) {
  try {
    setUserToken(db, id, token);
    return { status: 200 };
  } catch (error) {
    return { status: (error as { statusCode?: number }).statusCode ?? 500 };
  }
}

describe('UI token validation', () => {
  it('mirrors the server rule on the client (the API stays the authority)', () => {
    expect(validateCustomToken(' My-Private-Link ')).toEqual({ ok: true, token: 'My-Private-Link' });
    for (const bad of ['', '   ', 'short', 'a'.repeat(65), '-x', 'a b', 'a/b']) {
      expect(validateCustomToken(bad).ok, bad).toBe(false);
    }
  });
});

describe('token helpers', () => {
  it('resetUserToken returns a fresh generator-strength token', () => {
    const first = resetUserToken(db, aliceId);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    // Same generator: a rotation is never weaker than a fresh user's token.
    expect(first.token).toMatch(new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`));
    expect(generateUserToken()).toMatch(new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`));
    expect(first.token).toBe(db.select().from(users).where(eq(users.id, aliceId)).get()!.token);
  });
});
