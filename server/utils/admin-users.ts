// SPDX-License-Identifier: AGPL-3.0-only
/**
 * User management for /api/admin/users (P3).
 *
 * Plain functions over the injected database handle so the routes stay thin and
 * tests can use an in-memory SQLite. Nothing here touches Nuxt.
 *
 * `token` is the secret part of the public subscription URL (/s/:token). It is
 * generated server-side, never accepted from the client, 32 random bytes
 * hex-encoded, and can be rotated ("reset") which immediately invalidates the
 * old URL.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { sourceAllowedUsers, sources, userSources, users, type User } from '../db/schema';
import {
  generateUserToken,
  parseEnabled,
  parseId,
  parseName,
  parseOptionalText,
  NOTE_MAX_LENGTH,
  ValidationError,
} from './admin-validation';

/** User as exposed by the API — the token is included on purpose (owner UI). */
export interface AdminUser {
  id: number;
  name: string;
  token: string;
  profileId: number | null;
  enabled: boolean;
  note: string | null;
  createdAt: string;
}

export function toAdminUser(row: User): AdminUser {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    profileId: row.profileId ?? null,
    enabled: row.enabled,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function listUsers(db: SubhubDb): AdminUser[] {
  return db.select().from(users).orderBy(users.id).all().map(toAdminUser);
}

export function getUser(db: SubhubDb, rawId: unknown): AdminUser {
  const id = parseId(rawId);
  const row = db.select().from(users).where(eq(users.id, id)).get();
  if (!row) throw new ValidationError('user not found', 404);
  return toAdminUser(row);
}

/** Username-like token for the profile link; `null`/absent stays null. */
function parseProfileId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('invalid profileId');
  return id;
}

export function createUser(db: SubhubDb, body: Record<string, unknown>): AdminUser {
  const name = parseName(body.name);
  const enabled = parseEnabled(body.enabled);
  const note = parseOptionalText(body.note, 'note', NOTE_MAX_LENGTH);
  const profileId = parseProfileId(body.profileId);

  // Retry on the (astronomically unlikely) unique-token collision.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generateUserToken();
    try {
      const row = db.insert(users).values({ name, token, enabled, note, profileId }).returning().get();
      if (row) return toAdminUser(row);
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error('could not create user');
}

/** Patch subset: only provided fields change; `token` is never settable. */
export function updateUser(db: SubhubDb, rawId: unknown, body: Record<string, unknown>): AdminUser {
  const id = parseId(rawId);
  const existing = db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) throw new ValidationError('user not found', 404);

  const patch: Partial<Pick<User, 'name' | 'enabled' | 'note' | 'profileId'>> = {};
  if ('name' in body) patch.name = parseName(body.name);
  if ('enabled' in body) patch.enabled = parseEnabled(body.enabled);
  if ('note' in body) patch.note = parseOptionalText(body.note, 'note', NOTE_MAX_LENGTH);
  if ('profileId' in body) patch.profileId = parseProfileId(body.profileId);

  if (Object.keys(patch).length === 0) return toAdminUser(existing);

  const row = db.update(users).set(patch).where(eq(users.id, id)).returning().get();
  if (!row) throw new ValidationError('user not found', 404);
  return toAdminUser(row);
}

/** Rotate the subscription token; the old /s/:token stops working at once. */
export function resetUserToken(db: SubhubDb, rawId: unknown): AdminUser {
  const id = parseId(rawId);
  const existing = db.select().from(users).where(eq(users.id, id)).get();
  if (!existing) throw new ValidationError('user not found', 404);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const row = db
        .update(users)
        .set({ token: generateUserToken() })
        .where(eq(users.id, id))
        .returning()
        .get();
      if (row) return toAdminUser(row);
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error('could not reset token');
}

/**
 * Delete a user.
 *
 * Deletion policy for DEDICATED sources: they are deleted together with the
 * user (a dedicated source has no other consumer, and keeping it would leak the
 * previous owner's subscription URL into the public pool). The delete happens
 * explicitly *before* the user row so it works on both fresh databases (FK with
 * ON DELETE CASCADE) and migrated ones (plain `owner_user_id` column without
 * FK), and removes the user's legacy `user_sources` links first for the same
 * reason. Public and shared sources (ownerUserId null) are never touched.
 *
 * Shared sources: the deleted user is also removed from every allowlist
 * (`source_allowed_users`), so a shared source they could see stops reaching a
 * recycled account. The source itself stays for the remaining members.
 */
export function deleteUser(db: SubhubDb, rawId: unknown): { ok: true; id: number } {
  const id = parseId(rawId);
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
  if (!existing) throw new ValidationError('user not found', 404);

  try {
    db.delete(sourceAllowedUsers).where(eq(sourceAllowedUsers.userId, id)).run();
    db.delete(userSources).where(eq(userSources.userId, id)).run();
    db.delete(sources).where(eq(sources.ownerUserId, id)).run();
    db.delete(users).where(eq(users.id, id)).run();
  } catch (error) {
    // Last resort for a foreign key we do not know about: detach what points at
    // the user instead of surfacing a raw FK error to the admin UI.
    if (!(error instanceof Error) || !/FOREIGN KEY/i.test(error.message)) throw error;
    db.delete(sourceAllowedUsers).where(eq(sourceAllowedUsers.userId, id)).run();
    db.update(sources).set({ ownerUserId: null }).where(eq(sources.ownerUserId, id)).run();
    db.update(users).set({ profileId: null }).where(eq(users.id, id)).run();
    db.delete(users).where(eq(users.id, id)).run();
  }
  return { ok: true, id };
}
