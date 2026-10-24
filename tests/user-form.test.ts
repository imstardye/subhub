// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Regression: editing a user silently failed when the 规则档 ID input held a
 * value.
 *
 * The submit path of `pages/users.vue` is exercised end-to-end at the unit
 * level: the form state is seeded the way `openEdit` seeds it, the payload is
 * built by the pure helper the page uses, and that exact payload is sent to the
 * real PATCH handler against a temporary SQLite database. The page's error
 * banner is driven by `apiErrorMessage`, which is covered here as well (it used
 * to return an empty string for non-API exceptions, i.e. a *blank* red banner).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import usersCreateHandler from '../server/api/admin/users/index.post';
import usersListHandler from '../server/api/admin/users/index.get';
import userUpdateHandler from '../server/api/admin/users/[id].patch';
import { createSessionRevocationStore, type SessionRevocationStore } from '../server/utils/session-revocation';
import { openDb, type SubhubDb } from '../server/db';
import { resetCryptoCache } from '../server/db/crypto';
import type { AdminApiEvent } from '../server/utils/admin-api';
import { apiErrorMessage } from '../core/utils/api-error';
import {
  buildUserPayload,
  emptyUserForm,
  userFormFromUser,
  type UserForm,
} from '../core/utils/user-form';
import { authenticatedEvent } from './helpers/admin-api';

const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV'] as const;

type AdminApiHandler = (
  event: AdminApiEvent,
  options?: { db?: SubhubDb; revocations?: SessionRevocationStore },
) => unknown;

let savedEnv: Record<string, string | undefined>;
const dirs: string[] = [];
let db: SubhubDb;
let revocations: SessionRevocationStore;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = 'correct-horse-battery';
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;
  revocations = createSessionRevocationStore();
  resetCryptoCache();

  const dir = mkdtempSync(join(tmpdir(), 'subhub-user-form-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetCryptoCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authed(options: { url: string; method?: string; body?: unknown }) {
  return authenticatedEvent(options, revocations);
}

async function send(handler: AdminApiHandler, options: { url: string; method?: string; body?: unknown }) {
  const { event } = authed(options);
  const result = await handler(event, { db, revocations });
  return { status: event.node.res.statusCode, body: result as Record<string, unknown> };
}

async function createUser(body: Record<string, unknown> = { name: 'fixture-user' }) {
  const res = await send(usersCreateHandler, { url: '/api/admin/users', method: 'POST', body });
  expect(res.status).toBe(201);
  return (
    res.body as { item: { id: number; name: string; enabled: boolean; note: string | null; profileId: number | null } }
  ).item;
}

describe('users page form: payload building', () => {
  it('builds exactly the body the API accepts, including a string profileId', () => {
    const form: UserForm = { name: '  fixture-user  ', enabled: true, note: ' note ', profileId: '1' };
    expect(buildUserPayload(form)).toEqual({
      ok: true,
      payload: { name: 'fixture-user', enabled: true, note: 'note', profileId: '1' },
    });
  });

  it('treats an empty (or whitespace) profile id as "no profile"', () => {
    for (const profileId of ['', '   ']) {
      expect(buildUserPayload({ ...emptyUserForm(), name: 'x', profileId })).toEqual({
        ok: true,
        payload: { name: 'x', enabled: true, note: null, profileId: null },
      });
    }
    // Every field is present even when the form was reset.
    const built = buildUserPayload({ ...emptyUserForm(), name: 'x' });
    expect(built).toEqual({
      ok: true,
      payload: { name: 'x', enabled: true, note: null, profileId: null },
    });
  });

  it('rejects a missing name and a non-positive/non-integer profile id', () => {
    expect(buildUserPayload({ ...emptyUserForm(), name: '   ' })).toEqual({
      ok: false,
      error: '请填写名称',
    });
    for (const profileId of ['0', '-1', '1.5', 'abc']) {
      expect(buildUserPayload({ ...emptyUserForm(), name: 'x', profileId })).toEqual({
        ok: false,
        error: '规则档 ID 必须是正整数',
      });
    }
  });

  it('seeds the edit form from a user with and without a profile', () => {
    expect(userFormFromUser({ name: 'a', enabled: false, note: null, profileId: 7 })).toEqual({
      name: 'a',
      enabled: false,
      note: '',
      profileId: '7',
    });
    expect(userFormFromUser({ name: 'b', enabled: true, profileId: null }).profileId).toBe('');
    // A missing column (older API shape) is treated as "no profile" too.
    expect(userFormFromUser({ name: 'c', enabled: true }).profileId).toBe('');
  });
});

describe('users page form: submit path against the API', () => {
  it('persists an edit whose 规则档 ID field holds a value', async () => {
    const created = await createUser({ name: 'fixture-user', note: 'fixture note', profileId: 1 });

    // What the form holds after openEdit + clicking 保存, unchanged fields included.
    const form = userFormFromUser({ ...created, note: 'updated note' });
    expect(form.profileId).toBe('1');
    const built = buildUserPayload({ ...form, name: 'x' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // The brief's exact body shape, as the browser sends it.
    expect(JSON.parse(JSON.stringify(built.payload))).toEqual({
      name: 'x',
      enabled: true,
      note: 'updated note',
      profileId: '1',
    });

    const res = await send(userUpdateHandler, {
      url: `/api/admin/users/${created.id}`,
      method: 'PATCH',
      body: built.payload,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      item: { id: created.id, name: 'x', note: 'updated note', profileId: 1 },
    });

    const listed = await send(usersListHandler, { url: '/api/admin/users' });
    expect((listed.body as { items: Array<Record<string, unknown>> }).items[0]).toMatchObject({
      id: created.id,
      name: 'x',
      note: 'updated note',
      profileId: 1,
    });
  });

  it('clears the profile when the field is emptied', async () => {
    const created = await createUser({ name: 'fixture-user', profileId: 3 });
    const built = buildUserPayload({ ...userFormFromUser(created), profileId: '' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const res = await send(userUpdateHandler, {
      url: `/api/admin/users/${created.id}`,
      method: 'PATCH',
      body: built.payload,
    });
    expect(res.status).toBe(200);
    expect((res.body as { item: Record<string, unknown> }).item.profileId).toBeNull();
  });

  it('surfaces the server error message for a value the API rejects', async () => {
    const created = await createUser({ name: 'fixture-user' });
    // Bypass the form validation on purpose: the API is the second line of defence.
    const res = await send(userUpdateHandler, {
      url: `/api/admin/users/${created.id}`,
      method: 'PATCH',
      body: { name: 'x', enabled: true, note: null, profileId: 'abc' },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid profileId' });
    // ...and the page turns that into a visible banner.
    expect(apiErrorMessage({ data: { error: 'invalid profileId' } })).toBe('invalid profileId');
  });
});

describe('users page form: error banner text', () => {
  it('reads the server error field, including non-JSON bodies', () => {
    expect(apiErrorMessage({ data: { error: 'user not found' } })).toBe('user not found');
    expect(apiErrorMessage(new Error('fetch failed'))).toBe('fetch failed');
    expect(apiErrorMessage('plain string failure')).toBe('plain string failure');
  });

  it('never returns an empty message (the silent-failure symptom)', () => {
    for (const error of [undefined, null, '', {}, { data: {} }, { data: { error: '  ' } }, { data: '' }]) {
      const message = apiErrorMessage(error);
      expect(message.trim()).not.toBe('');
      expect(message).toBe('请求失败，请稍后再试');
    }
  });
});
