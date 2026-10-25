// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /my password gate — hashing, session cookie, server-enforced lock,
 * setup/unlock/change flow and admin password management.
 *
 * Same harness style as the rest of the suite: plain fake events against a
 * temporary SQLite database, no Nitro server. The subscription export is
 * deliberately not involved; it must keep working without any password.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type SubhubDb } from '../server/db';
import { users } from '../server/db/schema';
import { hashPassword, verifyPassword } from '../server/utils/user-password';
import {
  issueUserSession,
  USER_SESSION_COOKIE,
  USER_SESSION_TTL_SECONDS,
  verifyUserSession,
} from '../server/utils/user-session';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '../core/utils/user-password';
import {
  decodeUserSessionPayload,
  encodeUserSessionPayload,
  userSessionMatches,
} from '../core/utils/user-session';
import { createLoginThrottle } from '../server/utils/login-throttle';
import userCenterReadHandler from '../server/api/user/[token].get';
import userSourceCreateHandler from '../server/api/user/[token]/sources/index.post';
import userRefreshHandler from '../server/api/user/[token]/refresh.post';
import userPasswordSetupHandler from '../server/api/user/[token]/password.post';
import userUnlockHandler from '../server/api/user/[token]/unlock.post';
import userPasswordChangeHandler from '../server/api/user/[token]/password.put';
import adminUserPasswordSetHandler from '../server/api/admin/users/[id]/password.put';
import adminUserPasswordResetHandler from '../server/api/admin/users/[id]/password.delete';
import adminUserGetHandler from '../server/api/admin/users/[id].get';
import type { AdminApiEvent } from '../server/utils/admin-api';
import type { UserRequestOptions } from '../server/utils/user-routes';
import { authenticatedEvent, makeApiEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;
const TOKEN = 'a'.repeat(32);
const OTHER_TOKEN = 'b'.repeat(32);
const PASSWORD = 'correct-horse';
const NEW_PASSWORD = 'battery-staple';

type UserHandler = (event: AdminApiEvent, options?: UserRequestOptions) => unknown;

const dirs: string[] = [];
let db: SubhubDb;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;

  const dir = mkdtempSync(join(tmpdir(), 'subhub-user-password-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedUser(options: {
  name?: string;
  token?: string;
  password?: string | null;
  version?: number;
} = {}): { id: number; token: string } {
  const token = options.token ?? TOKEN;
  const passwordHash = options.password === null ? null : hashPassword(options.password ?? PASSWORD);
  const row = db
    .insert(users)
    .values({
      name: options.name ?? 'fixture-user',
      token,
      enabled: true,
      passwordHash,
      passwordVersion: options.version ?? (passwordHash ? 1 : 0),
    })
    .returning({ id: users.id, token: users.token })
    .get()!;
  return row;
}

interface CallResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  json: string;
}

async function call(
  handler: UserHandler,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    sessionToken?: string | null;
    handlerOptions?: UserRequestOptions;
  } = {},
): Promise<CallResult> {
  const { event, headers } = makeApiEvent({
    url: path,
    method: options.method ?? 'GET',
    body: options.body,
  });
  if (options.sessionToken) {
    event.node.req.headers.cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(options.sessionToken)}`;
  }
  const body = await handler(event, { db, ...options.handlerOptions });
  return {
    status: event.node.res.statusCode,
    body,
    headers,
    json: JSON.stringify(body ?? null),
  };
}

function cookieToken(headers: Record<string, string>): string {
  const raw = headers['set-cookie'];
  expect(raw).toBeTruthy();
  const match = new RegExp(`^${USER_SESSION_COOKIE}=([^;]*)`).exec(raw!);
  expect(match, `unexpected Set-Cookie: ${raw}`).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

function read(token = TOKEN, sessionToken?: string | null) {
  return call(userCenterReadHandler, `/api/user/${token}`, { sessionToken });
}

function setup(token: string, password: unknown) {
  return call(userPasswordSetupHandler, `/api/user/${token}/password`, {
    method: 'POST',
    body: { password },
  });
}

function unlock(token: string, password: unknown, handlerOptions?: UserRequestOptions) {
  return call(userUnlockHandler, `/api/user/${token}/unlock`, {
    method: 'POST',
    body: { password },
    handlerOptions,
  });
}

function changePassword(
  token: string,
  sessionToken: string,
  currentPassword: unknown,
  newPassword: unknown,
) {
  return call(userPasswordChangeHandler, `/api/user/${token}/password`, {
    method: 'PUT',
    sessionToken,
    body: { currentPassword, newPassword },
  });
}

describe('password policy', () => {
  it('accepts 6–64 characters and rejects shorter/longer/non-string values', () => {
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH))).toEqual({
      ok: true,
      password: 'a'.repeat(PASSWORD_MIN_LENGTH),
    });
    expect(validatePassword('a'.repeat(PASSWORD_MAX_LENGTH)).ok).toBe(true);
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toMatchObject({ ok: false });
    expect(validatePassword('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatchObject({ ok: false });
    expect(validatePassword('')).toMatchObject({ ok: false, error: '请填写密码' });
    expect(validatePassword(null)).toMatchObject({ ok: false });
    // No trimming: spaces are part of the password.
    expect(validatePassword('  abc ')).toMatchObject({ ok: true, password: '  abc ' });
  });
});

describe('scrypt password hashes', () => {
  it('uses a fresh salt per hash and verifies only the right password', () => {
    const first = hashPassword(PASSWORD);
    const second = hashPassword(PASSWORD);
    expect(first).not.toBe(second);
    expect(first.startsWith('scrypt$')).toBe(true);
    expect(first).not.toContain(PASSWORD);
    expect(verifyPassword(PASSWORD, first)).toBe(true);
    expect(verifyPassword(PASSWORD, second)).toBe(true);
    expect(verifyPassword('wrong-password', first)).toBe(false);
    expect(verifyPassword('', first)).toBe(false);
    expect(verifyPassword(PASSWORD, '')).toBe(false);
    expect(verifyPassword(PASSWORD, 'scrypt$1$2$3$bad')).toBe(false);
    expect(verifyPassword(PASSWORD, 'not-a-hash')).toBe(false);
  });
});

describe('session payload and signature', () => {
  it('round-trips the unsigned payload and rejects malformed values', () => {
    const encoded = encodeUserSessionPayload({ userId: 7, passwordVersion: 3, expiresAtSeconds: 1_900_000_000 });
    expect(encoded).toBe('v1.7.3.1900000000');
    expect(decodeUserSessionPayload(encoded)).toEqual({
      userId: 7,
      passwordVersion: 3,
      expiresAtSeconds: 1_900_000_000,
    });
    for (const bad of ['', 'v2.7.3.1', 'v1.0.3.1', 'v1.7.-1.1', 'v1.7.3.x', 'v1.7.3']) {
      expect(decodeUserSessionPayload(bad)).toBeNull();
    }
  });

  it('signs, expires and rejects tampering', () => {
    const now = 1_700_000_000_000;
    const { token } = issueUserSession({ id: 7, passwordVersion: 3 }, { now: () => now });
    const verified = verifyUserSession(token, { now: () => now });
    expect(verified).toMatchObject({ userId: 7, passwordVersion: 3 });
    expect(verified!.expiresAtMs).toBe((Math.floor(now / 1000) + USER_SESSION_TTL_SECONDS) * 1000);

    expect(verifyUserSession(token, { now: () => now + USER_SESSION_TTL_SECONDS * 1000 + 1 })).toBeNull();
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifyUserSession(tampered, { now: () => now })).toBeNull();
    expect(verifyUserSession(token, { now: () => now, secret: 'another-secret' })).toBeNull();
    expect(verifyUserSession('v1.7.3.9999999999', { now: () => now })).toBeNull();
  });

  it('binds a session to one user at one password version', () => {
    const session = { userId: 7, passwordVersion: 3 };
    expect(userSessionMatches(session, { id: 7, passwordHash: 'scrypt$x', passwordVersion: 3 })).toBe(true);
    expect(userSessionMatches(session, { id: 7, passwordHash: 'scrypt$x', passwordVersion: 4 })).toBe(false);
    expect(userSessionMatches(session, { id: 8, passwordHash: 'scrypt$x', passwordVersion: 3 })).toBe(false);
    expect(userSessionMatches(session, { id: 7, passwordHash: null, passwordVersion: 3 })).toBe(false);
    expect(userSessionMatches(null, { id: 7, passwordHash: 'scrypt$x', passwordVersion: 3 })).toBe(false);
  });
});

describe('server-enforced gate', () => {
  it('401 needs-setup when no password exists, even for a read', async () => {
    seedUser({ password: null });
    const result = await read();
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: '请先设置密码', status: 'needs-setup' });

    const write = await call(userSourceCreateHandler, `/api/user/${TOKEN}/sources`, {
      method: 'POST',
      body: { name: 'x', url: 'https://example.com/sub' },
    });
    expect(write.status).toBe(401);
    expect(write.body).toEqual({ error: '请先设置密码', status: 'needs-setup' });
  });

  it('401 needs-password for a user with a password but no valid cookie', async () => {
    seedUser();
    const result = await read();
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: '请输入密码', status: 'needs-password' });

    // A session for another user is not accepted either.
    const other = seedUser({ name: 'other', token: OTHER_TOKEN, password: PASSWORD });
    const foreign = issueUserSession(other).token;
    expect((await read(TOKEN, foreign)).status).toBe(401);
  });

  it('keeps unknown tokens a bare 404 (not a password hint)', async () => {
    const result = await read('f'.repeat(32));
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'not found' });
  });
});

describe('setup → unlock → change password', () => {
  it('sets a password, enters the dashboard, then keeps only the current session after a change', async () => {
    const user = seedUser({ password: null });

    const setupResult = await setup(TOKEN, PASSWORD);
    expect(setupResult.status).toBe(200);
    const firstSession = cookieToken(setupResult.headers);
    expect(firstSession).toMatch(/^v1\./);

    const entered = await read(TOKEN, firstSession);
    expect(entered.status).toBe(200);
    expect((entered.body as { user: { name: string } }).user.name).toBe('fixture-user');

    // A second setup is refused once a password exists.
    expect((await setup(TOKEN, PASSWORD)).status).toBe(409);

    // Wrong password: 401 and no cookie.
    const wrong = await unlock(TOKEN, 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: '密码错误', status: 'wrong-password' });
    expect(wrong.headers['set-cookie']).toBeUndefined();

    // Correct password issues a fresh cookie for the same version.
    const unlocked = await unlock(TOKEN, PASSWORD);
    expect(unlocked.status).toBe(200);
    const secondSession = cookieToken(unlocked.headers);
    expect(verifyUserSession(secondSession)).toMatchObject({ userId: user.id, passwordVersion: 1 });

    // Change password: current password required, version bumps.
    const wrongCurrent = await changePassword(TOKEN, secondSession, 'nope', NEW_PASSWORD);
    expect(wrongCurrent.status).toBe(401);
    expect(wrongCurrent.body).toEqual({ error: '密码错误', status: 'wrong-password' });

    const changed = await changePassword(TOKEN, secondSession, PASSWORD, NEW_PASSWORD);
    expect(changed.status).toBe(200);
    const thirdSession = cookieToken(changed.headers);
    expect(verifyUserSession(thirdSession)).toMatchObject({ userId: user.id, passwordVersion: 2 });

    // Every older session is dead; the cookie issued by the change still works.
    expect((await read(TOKEN, firstSession)).status).toBe(401);
    expect((await read(TOKEN, secondSession)).status).toBe(401);
    expect((await read(TOKEN, thirdSession)).status).toBe(200);

    // Old password no longer unlocks; the new one does.
    expect((await unlock(TOKEN, PASSWORD)).status).toBe(401);
    expect((await unlock(TOKEN, NEW_PASSWORD)).status).toBe(200);
  });

  it('validates the new password before changing anything', async () => {
    seedUser();
    const session = issueUserSession({ id: db.select({ id: users.id }).from(users).where(eq(users.token, TOKEN)).get()!.id, passwordVersion: 1 }).token;
    const result = await changePassword(TOKEN, session, PASSWORD, 'short');
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: `密码长度需在 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符之间` });
    expect(verifyUserSession(session)).toMatchObject({ passwordVersion: 1 });
  });

  it('keeps the session across a subscription-token rotation', async () => {
    seedUser();
    const session = issueUserSession({
      id: db.select({ id: users.id }).from(users).where(eq(users.token, TOKEN)).get()!.id,
      passwordVersion: 1,
    }).token;
    expect((await read(TOKEN, session)).status).toBe(200);

    const rotated = await call(userRefreshHandler, `/api/user/${TOKEN}/refresh`, {
      method: 'POST',
      sessionToken: session,
    });
    expect(rotated.status).toBe(200);
    const newToken = (rotated.body as { token: string }).token;
    // The cookie is bound to the user, not the old token.
    expect((await read(newToken, session)).status).toBe(200);
  });
});

describe('login throttle on password attempts', () => {
  it('slows repeated failures per user+IP and refunds a success', async () => {
    seedUser();
    const sleeps: number[] = [];
    const throttle = createLoginThrottle({ maxPerIp: 1, maxGlobal: 100, windowMs: 60_000 });
    const handlerOptions: UserRequestOptions = {
      password: {
        ip: '203.0.113.9',
        throttle,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    };

    // First failure is free (budget 1), the next one is slowed.
    expect((await unlock(TOKEN, 'wrong-1', handlerOptions)).status).toBe(401);
    expect(sleeps).toEqual([]);
    expect((await unlock(TOKEN, 'wrong-2', handlerOptions)).status).toBe(401);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000);

    // A correct password still works and refunds the counted failure (it may
    // itself wait, like the admin login: the throttle slows, never blocks).
    expect((await unlock(TOKEN, PASSWORD, handlerOptions)).status).toBe(200);
    const slowedBefore = sleeps.length;
    expect((await unlock(TOKEN, 'wrong-3', handlerOptions)).status).toBe(401);
    // The refund restored the budget: this attempt is not slowed again.
    expect(sleeps).toHaveLength(slowedBefore);
  });
});

describe('admin password management', () => {
  function adminAuthed(options: { url: string; method?: string; body?: unknown }) {
    return authenticatedEvent(options);
  }

  async function adminCall(
    handler: (event: AdminApiEvent, options?: { db?: SubhubDb; revocations?: never }) => unknown,
    options: { url: string; method?: string; body?: unknown },
  ) {
    const authed = adminAuthed(options);
    // The fake admin session is valid without a revocation entry; pass the DB.
    const body = await handler(authed.event, { db } as never);
    return { status: authed.event.node.res.statusCode, body, headers: authed.headers };
  }

  it('is admin-only (401 without the admin session cookie)', async () => {
    const anonPut = makeApiEvent({
      url: '/api/admin/users/1/password',
      method: 'PUT',
      body: { password: PASSWORD },
    });
    expect(await adminUserPasswordSetHandler(anonPut.event, { db })).toEqual({ error: 'unauthorized' });
    expect(anonPut.event.node.res.statusCode).toBe(401);

    const anonDelete = makeApiEvent({ url: '/api/admin/users/1/password', method: 'DELETE' });
    expect(await adminUserPasswordResetHandler(anonDelete.event, { db })).toEqual({ error: 'unauthorized' });
    expect(anonDelete.event.node.res.statusCode).toBe(401);
  });

  it('PUT sets the password (never echoing hash/plaintext) and invalidates old sessions', async () => {
    const user = seedUser({ password: null });
    const set = await adminCall(adminUserPasswordSetHandler, {
      url: `/api/admin/users/${user.id}/password`,
      method: 'PUT',
      body: { password: PASSWORD },
    });
    expect(set.status).toBe(200);
    const item = (set.body as { item: Record<string, unknown> }).item;
    expect(item).toMatchObject({ id: user.id, passwordSet: true });
    expect(JSON.stringify(set.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(set.body)).not.toContain('scrypt$');

    const stored = db.select().from(users).where(eq(users.id, user.id)).get()!;
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
    expect(stored.passwordVersion).toBe(1);

    // The user's /my now requires the admin-chosen password.
    expect((await read()).status).toBe(401);
    const unlocked = await unlock(TOKEN, PASSWORD);
    expect(unlocked.status).toBe(200);
    const session = cookieToken(unlocked.headers);

    // A second admin PUT bumps the version -> the session above dies.
    const updated = await adminCall(adminUserPasswordSetHandler, {
      url: `/api/admin/users/${user.id}/password`,
      method: 'PUT',
      body: { password: NEW_PASSWORD },
    });
    expect((updated.body as { item: { passwordSet: boolean } }).item.passwordSet).toBe(true);
    expect(db.select().from(users).where(eq(users.id, user.id)).get()!.passwordVersion).toBe(2);
    expect((await read(TOKEN, session)).status).toBe(401);
    expect((await unlock(TOKEN, PASSWORD)).status).toBe(401);
    expect((await unlock(TOKEN, NEW_PASSWORD)).status).toBe(200);
  });

  it('DELETE clears the password, bumps the version and returns to setup', async () => {
    const user = seedUser({ password: PASSWORD });
    const session = issueUserSession({ id: user.id, passwordVersion: 1 }).token;
    expect((await read(TOKEN, session)).status).toBe(200);

    const reset = await adminCall(adminUserPasswordResetHandler, {
      url: `/api/admin/users/${user.id}/password`,
      method: 'DELETE',
    });
    expect(reset.status).toBe(200);
    expect((reset.body as { item: Record<string, unknown> }).item).toMatchObject({
      id: user.id,
      passwordSet: false,
    });
    const stored = db.select().from(users).where(eq(users.id, user.id)).get()!;
    expect(stored.passwordHash).toBeNull();
    expect(stored.passwordVersion).toBe(2);

    // Old session and old password are useless; the page starts at setup.
    const locked = await read(TOKEN, session);
    expect(locked.status).toBe(401);
    expect(locked.body).toEqual({ error: '请先设置密码', status: 'needs-setup' });
    expect((await unlock(TOKEN, PASSWORD)).body).toEqual({ error: '请先设置密码', status: 'needs-setup' });

    // The admin can also set a fresh password directly.
    const setAgain = await adminCall(adminUserPasswordSetHandler, {
      url: `/api/admin/users/${user.id}/password`,
      method: 'PUT',
      body: { password: NEW_PASSWORD },
    });
    expect((setAgain.body as { item: { passwordSet: boolean } }).item.passwordSet).toBe(true);
    expect((await unlock(TOKEN, NEW_PASSWORD)).status).toBe(200);
  });

  it('rejects out-of-policy passwords and keeps admin DTOs hash-free', async () => {
    const user = seedUser({ password: null });
    for (const password of ['', 'short', 'x'.repeat(PASSWORD_MAX_LENGTH + 1), null]) {
      const res = await adminCall(adminUserPasswordSetHandler, {
        url: `/api/admin/users/${user.id}/password`,
        method: 'PUT',
        body: { password },
      });
      expect(res.status).toBe(400);
      expect(db.select().from(users).where(eq(users.id, user.id)).get()!.passwordHash).toBeNull();
    }

    await adminCall(adminUserPasswordSetHandler, {
      url: `/api/admin/users/${user.id}/password`,
      method: 'PUT',
      body: { password: PASSWORD },
    });
    const read = await adminCall(adminUserGetHandler, {
      url: `/api/admin/users/${user.id}`,
    });
    expect(read.status).toBe(200);
    const json = JSON.stringify(read.body);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('scrypt$');
    expect((read.body as { item: { passwordSet: boolean } }).item.passwordSet).toBe(true);
  });
});
