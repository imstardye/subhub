// SPDX-License-Identifier: AGPL-3.0-only
/**
 * User subscription token — the ONE place that generates/rotates it.
 *
 * The token is the credential of the whole product: it is the secret part of
 * `/s/<token>` and of the self-service user center (`/my/<token>`). No accounts,
 * no passwords; whoever holds the token owns the links. It is always generated
 * server-side (32 random bytes, hex), never accepted from a client.
 *
 * Used by the admin user API (`createUser` / `resetUserToken`) and by the user
 * center's self-service rotation (`POST /api/user/:token/refresh`).
 *
 * Seam (coordination with feat/sub-path): that branch adds DB-backed effective
 * subscription-prefix + admin token endpoints. The prefix half lives in
 * `server/utils/sub-prefix.ts`; if a stored token format ever appears, it
 * belongs here. Today the format is a plain random hex string.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { users, type User } from '../db/schema';
import { generateUserToken } from './admin-validation';

/** Attempts before giving up on the (astronomically unlikely) collision. */
const TOKEN_ATTEMPTS = 3;

/** Maximum length accepted from a URL; longer values are never looked up. */
export const MAX_USER_TOKEN_LENGTH = 128;

export interface UserLookupOptions {
  /** Include disabled users (the token still resolves, the caller decides). */
  includeDisabled?: boolean;
}

/**
 * Resolve a user by token. `null` when the token is empty/over-long or no user
 * has it (a disabled user is only returned with `includeDisabled`, so the
 * export path cannot tell "unknown" from "disabled" unless it asks to).
 */
export function findUserByToken(
  db: SubhubDb,
  token: string | null | undefined,
  options: UserLookupOptions = {},
): User | null {
  if (typeof token !== 'string' || token === '' || token.length > MAX_USER_TOKEN_LENGTH) {
    return null;
  }
  const row = db.select().from(users).where(eq(users.token, token)).get();
  if (!row) return null;
  if (!row.enabled && !options.includeDisabled) return null;
  return row;
}

/**
 * Rotate a user's token and return the updated row. The old token stops working
 * for `/s/<token>` and `/my/<token>` at once. `null` when the user is gone.
 */
export function rotateUserToken(db: SubhubDb, userId: number): User | null {
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) return null;
  for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
    try {
      const row = db
        .update(users)
        .set({ token: generateUserToken() })
        .where(eq(users.id, userId))
        .returning()
        .get();
      if (row) return row;
      return null;
    } catch (error) {
      if (attempt === TOKEN_ATTEMPTS - 1) throw error;
    }
  }
  throw new Error('could not rotate token');
}
