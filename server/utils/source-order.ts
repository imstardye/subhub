// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saving per-user subscription source order.
 *
 * One save path for `/my` (`PUT /api/user/:token/source-order`) and the admin
 * user update, exactly like operators/custom rules. The stored list may only
 * contain sources the user can actually see (own dedicated, public, or shared
 * with their allowlist) — paused and currently-excluded sources still count,
 * because ordering must survive toggling them back on. An empty list clears the
 * preference and restores the default bucket order.
 */
import { and, eq, exists, isNull, or } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { sourceAllowedUsers, sources, users, type User } from '../db/schema';
import { parseSourceOrderJson } from '../../core';
import { ValidationError } from './admin-validation';

/** The DTO view of a user row's stored order. */
export function readUserSourceOrder(user: Pick<User, 'sourceOrder'>): number[] {
  return parseSourceOrderJson(user.sourceOrder);
}

/** Source ids this user may reference in an order (visibility, not inclusion). */
export function visibleSourceIds(db: SubhubDb, userId: number): Set<number> {
  const sharedWithUser = exists(
    db
      .select({ one: sourceAllowedUsers.sourceId })
      .from(sourceAllowedUsers)
      .where(
        and(
          eq(sourceAllowedUsers.sourceId, sources.id),
          eq(sourceAllowedUsers.userId, userId),
        ),
      ),
  );
  const rows = db
    .select({ id: sources.id })
    .from(sources)
    .where(
      or(
        eq(sources.ownerUserId, userId),
        and(isNull(sources.ownerUserId), eq(sources.accessMode, 'all')),
        and(
          isNull(sources.ownerUserId),
          eq(sources.accessMode, 'restricted'),
          sharedWithUser,
        ),
      ),
    )
    .all();
  return new Set(rows.map((row) => row.id));
}

function parseOrderInput(input: unknown): number[] {
  if (!Array.isArray(input)) {
    throw new ValidationError('sourceIds must be an array of positive integers');
  }
  const seen = new Set<number>();
  const order: number[] = [];
  for (const value of input) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new ValidationError('sourceIds must be an array of positive integers');
    }
    if (seen.has(value)) continue;
    seen.add(value);
    order.push(value);
  }
  return order;
}

/**
 * Validate and store a user's source order. Every id must be visible to the
 * user; an unknown/foreign id is a 400. An empty array clears the column.
 */
export function saveUserSourceOrder(
  db: SubhubDb,
  userId: number,
  input: unknown,
): number[] {
  const existing = db.select().from(users).where(eq(users.id, userId)).get();
  if (!existing) throw new ValidationError('user not found', 404);

  const order = parseOrderInput(input);
  if (order.length > 0) {
    const visible = visibleSourceIds(db, userId);
    const invalid = order.find((id) => !visible.has(id));
    if (invalid !== undefined) {
      throw new ValidationError(`source ${invalid} is not accessible`);
    }
  }

  const row = db
    .update(users)
    .set({ sourceOrder: order.length > 0 ? JSON.stringify(order) : null })
    .where(eq(users.id, userId))
    .returning()
    .get();
  if (!row) throw new ValidationError('user not found', 404);
  return readUserSourceOrder(row);
}
