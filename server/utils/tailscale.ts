// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user Tailscale binding (write-only secret).
 *
 * The stored value is the user's Tailscale auth key (`tskey-auth-…`), encrypted
 * at rest with the source-URL helpers in `server/db/crypto.ts`. It follows the
 * repo's write-only secret discipline exactly like `sources.url`:
 *
 * - the plaintext key is never returned by any DTO or response — the user
 *   center and the admin console only ever expose `tailscaleKeySet`;
 * - the /my form always starts empty; saving an empty string clears the binding
 *   (the page's 清除绑定 button sends the same empty body);
 * - it is only used to render the opt-in `?tailscale=1` mihomo/clash export.
 *
 * One save path (`setUserTailscaleKey` / `clearUserTailscaleKey`) is shared by
 * the user API and the admin clear-only surface, like operators/source-order.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { users, type User } from '../db/schema';
import { decrypt, encrypt } from '../db/crypto';
import { ValidationError } from './admin-validation';

/** Hard cap on the raw key (a real `tskey-auth-…` is ~50 chars). */
export const TAILSCALE_KEY_MAX_LENGTH = 512;

/** The only Tailscale fact any DTO carries. */
export interface TailscaleKeyState {
  tailscaleKeySet: boolean;
}

/** Whether a row has a stored (encrypted) key. */
export function isTailscaleKeySet(user: Pick<User, 'tailscaleAuthKey'>): boolean {
  return Boolean(user.tailscaleAuthKey);
}

/**
 * Decrypt a stored key. A missing value or a decrypt failure (tampering, a
 * rotated `SUBHUB_SECRET`) reads as unbound — an export must never throw
 * because of this column.
 */
export function readUserTailscaleKey(user: Pick<User, 'tailscaleAuthKey'>): string | null {
  const stored = user.tailscaleAuthKey;
  if (!stored) return null;
  try {
    const value = decrypt(stored).trim();
    return value || null;
  } catch {
    return null;
  }
}

/** Trim and validate a raw key; empty = clear, over-long = 400. */
function normalizeTailscaleKey(rawKey: unknown): string | null {
  if (typeof rawKey !== 'string') {
    throw new ValidationError('authKey must be a string');
  }
  const key = rawKey.trim();
  if (!key) return null;
  if (key.length > TAILSCALE_KEY_MAX_LENGTH) {
    throw new ValidationError(`authKey must be at most ${TAILSCALE_KEY_MAX_LENGTH} characters`);
  }
  return key;
}

/**
 * Bind (or clear) a user's Tailscale auth key. A blank string clears the
 * binding (stores NULL). Returns the DTO state only — never the key.
 */
export function setUserTailscaleKey(
  db: SubhubDb,
  userId: number,
  rawKey: unknown,
): TailscaleKeyState {
  const key = normalizeTailscaleKey(rawKey);
  const row = db
    .update(users)
    .set({ tailscaleAuthKey: key ? encrypt(key) : null })
    .where(eq(users.id, userId))
    .returning({ tailscaleAuthKey: users.tailscaleAuthKey })
    .get();
  if (!row) throw new ValidationError('user not found', 404);
  return { tailscaleKeySet: isTailscaleKeySet(row) };
}

/** Remove a user's Tailscale binding (idempotent). Never returns the key. */
export function clearUserTailscaleKey(db: SubhubDb, userId: number): TailscaleKeyState {
  const row = db
    .update(users)
    .set({ tailscaleAuthKey: null })
    .where(eq(users.id, userId))
    .returning({ tailscaleAuthKey: users.tailscaleAuthKey })
    .get();
  if (!row) throw new ValidationError('user not found', 404);
  return { tailscaleKeySet: isTailscaleKeySet(row) };
}
