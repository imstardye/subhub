// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Access log reading for /api/admin/logs (P3).
 *
 * Plain functions over the injected database handle, mirroring the other
 * `admin-*.ts` modules so the route stays thin and the tests can run against a
 * temporary SQLite database.
 *
 * The list is newest-first (`created_at DESC`, `id DESC` as a stable
 * tie-breaker) and can be narrowed by `userId` / `status`. The user name comes
 * from a left join, so rows whose user has since been deleted still show up
 * with `userName: null` (the log itself is not cascaded away).
 */
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { accessLogs, users } from '../db/schema';
import { ValidationError } from './admin-validation';

export const LOGS_DEFAULT_LIMIT = 50;
export const LOGS_MAX_LIMIT = 200;

export interface AdminAccessLog {
  id: number;
  userId: number | null;
  userName: string | null;
  target: string | null;
  ua: string | null;
  ip: string | null;
  status: number | null;
  ms: number | null;
  createdAt: string;
}

export interface AccessLogList {
  items: AdminAccessLog[];
  total: number;
  limit: number;
  offset: number;
}

/** Non-negative integer query param; absent/empty falls back to `fallback`. */
function parseNonNegativeInt(value: string | undefined, field: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`);
  }
  return parsed;
}

/** Optional positive integer filter (userId / status). */
function parseOptionalFilter(value: string | undefined, field: string): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ValidationError(`${field} must be an integer`);
  }
  return parsed;
}

export interface ListAccessLogsOptions {
  limit?: string | number;
  offset?: string | number;
  userId?: string | number;
  status?: string | number;
}

/**
 * Page through access logs. `limit` is clamped to [1, 200] (default 50);
 * `offset` defaults to 0.
 */
export function listAccessLogs(db: SubhubDb, options: ListAccessLogsOptions = {}): AccessLogList {
  const asString = (value: string | number | undefined) =>
    value === undefined ? undefined : String(value);

  const rawLimit = parseNonNegativeInt(asString(options.limit), 'limit', LOGS_DEFAULT_LIMIT);
  // 0 is treated as "not given": a page of no rows is never useful.
  const limit = Math.min(Math.max(rawLimit || LOGS_DEFAULT_LIMIT, 1), LOGS_MAX_LIMIT);
  const offset = parseNonNegativeInt(asString(options.offset), 'offset', 0);
  const userId = parseOptionalFilter(asString(options.userId), 'userId');
  const status = parseOptionalFilter(asString(options.status), 'status');

  const filters: SQL[] = [];
  if (userId !== null) filters.push(eq(accessLogs.userId, userId));
  if (status !== null) filters.push(eq(accessLogs.status, status));
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = db
    .select({
      id: accessLogs.id,
      userId: accessLogs.userId,
      userName: users.name,
      target: accessLogs.target,
      ua: accessLogs.ua,
      ip: accessLogs.ip,
      status: accessLogs.status,
      ms: accessLogs.ms,
      createdAt: accessLogs.createdAt,
    })
    .from(accessLogs)
    .leftJoin(users, eq(users.id, accessLogs.userId))
    .where(where)
    .orderBy(desc(accessLogs.createdAt), desc(accessLogs.id))
    .limit(limit)
    .offset(offset)
    .all();

  const totalRow = db.select({ value: count() }).from(accessLogs).where(where).get();

  return {
    items: rows.map((row) => ({
      id: row.id,
      userId: row.userId ?? null,
      // Left join: `undefined` when the user row is gone (deleted user).
      userName: row.userName ?? null,
      target: row.target ?? null,
      ua: row.ua ?? null,
      ip: row.ip ?? null,
      status: row.status ?? null,
      ms: row.ms ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    total: Number(totalRow?.value ?? 0),
    limit,
    offset,
  };
}
