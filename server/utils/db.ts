// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Nitro-side database access.
 *
 * `openDb()` from `server/db` is not memoised, so opening it per request would
 * leak a better-sqlite3 handle every time. Keep one handle per process here.
 * Tests bypass Nuxt and inject their own instance via `__setServerDbForTest`.
 */
import { openDb, type SubhubDb } from '../db';

let instance: SubhubDb | null = null;

/** Shared database handle (opens SUBHUB_DB_PATH on first use). */
export function getServerDb(): SubhubDb {
  if (!instance) instance = openDb();
  return instance;
}

/** Replace the shared handle (tests only; pass `null` to forget it). */
export function __setServerDbForTest(db: SubhubDb | null): void {
  instance = db;
}
