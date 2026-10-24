// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dashboard counters for /api/admin/stats.
 *
 * Plain functions over the injected database handle (like the other
 * `admin-*.ts` modules) so the route stays a thin wrapper and the tests run
 * against a temporary SQLite database.
 */
import { count, gte, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { SubhubDb } from '../db';
import { accessLogs, profiles, sources, users } from '../db/schema';

/** Rolling window used for the "24h access" card. */
export const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AdminStats {
  users: number;
  sources: number;
  profiles: number;
  /** Access log rows with `created_at >= now - 24h`. */
  accessLogs24h: number;
}

/** `SELECT count(*)` for a table, optionally filtered. */
function countRows(db: SubhubDb, table: SQLiteTable, where?: SQL): number {
  const row = db.select({ value: count() }).from(table).where(where).get();
  return Number(row?.value ?? 0);
}

/** Totals for the dashboard cards. `now` is injectable for deterministic tests. */
export function getAdminStats(db: SubhubDb, now: Date = new Date()): AdminStats {
  const since = new Date(now.getTime() - STATS_WINDOW_MS);
  return {
    users: countRows(db, users),
    sources: countRows(db, sources),
    profiles: countRows(db, profiles),
    accessLogs24h: countRows(db, accessLogs, gte(accessLogs.createdAt, since)),
  };
}
