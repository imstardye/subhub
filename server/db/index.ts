// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Open the SQLite file at SUBHUB_DB_PATH (default `.data/subhub.sqlite`)
 * with better-sqlite3 and ensure the tables from schema.ts exist.
 *
 * better-sqlite3 11.x is used (Node 20). 13.x requires Node >= 22.
 * pnpm must be allowed to run its install script (`pnpm.onlyBuiltDependencies`).
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export const DEFAULT_DB_PATH = '.data/subhub.sqlite';

export type SubhubDb = BetterSQLite3Database<typeof schema>;

export interface OpenDbOptions {
  /** Override SUBHUB_DB_PATH. `:memory:` is allowed. */
  path?: string;
}

/** Resolve a database path from an explicit option, then SUBHUB_DB_PATH. */
export function resolveDbPath(explicit?: string): string {
  const configured = explicit ?? process.env.SUBHUB_DB_PATH ?? DEFAULT_DB_PATH;
  if (configured === ':memory:') return configured;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * DDL matching schema.ts. `created_at` uses drizzle's integer timestamp_ms
 * defaultNow() expression (milliseconds since epoch).
 */
const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  profile_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  password_hash TEXT,
  password_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_token_unique ON users (token);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'remote',
  ua TEXT,
  refresh_minutes INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER,
  last_ok_at INTEGER,
  last_error TEXT,
  cache_blob TEXT,
  owner_user_id INTEGER,
  access_mode TEXT NOT NULL DEFAULT 'all',
  userinfo_upload INTEGER,
  userinfo_download INTEGER,
  userinfo_total INTEGER,
  userinfo_expire INTEGER,
  userinfo_refreshed_at INTEGER
);

-- SHARED (accessMode 'restricted') source allowlists.
CREATE TABLE IF NOT EXISTS source_allowed_users (
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, user_id)
);
CREATE INDEX IF NOT EXISTS source_allowed_users_user_idx
  ON source_allowed_users (user_id, source_id);

CREATE TABLE IF NOT EXISTS user_sources (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, source_id)
);
CREATE INDEX IF NOT EXISTS user_sources_user_sort_idx ON user_sources (user_id, sort);

-- Per-user inclusion override for public/shared sources (user center).
-- No row means included; 0 excludes the source for that user only.
CREATE TABLE IF NOT EXISTS user_source_choices (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  included INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, source_id)
);
CREATE INDEX IF NOT EXISTS user_source_choices_source_idx
  ON user_source_choices (source_id);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  name TEXT NOT NULL,
  ini_url TEXT,
  ini_text TEXT,
  variant TEXT NOT NULL DEFAULT 'mihomo',
  dns_template TEXT,
  options TEXT
);

CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER,
  target TEXT,
  ua TEXT,
  ip TEXT,
  status INTEGER,
  ms INTEGER,
  created_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
CREATE INDEX IF NOT EXISTS access_logs_user_created_idx ON access_logs (user_id, created_at);
CREATE INDEX IF NOT EXISTS access_logs_created_idx ON access_logs (created_at);

-- In-app site settings (key/value), e.g. the subscription URL prefix.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer))
);
`;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` above is
 * a no-op on an existing database, so every added column needs an idempotent
 * `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info`. Safe to run on
 * every boot, fresh or migrated databases alike.
 *
 * Note: SQLite cannot add a column with a foreign-key constraint via ALTER, so
 * the guarded column is plain INTEGER (the FK lives in schema.ts for fresh
 * databases). Integrity is enforced in code: `admin-sources.ts` only writes an
 * owner that exists, and `deleteUser` removes the user's dedicated sources
 * before deleting the user.
 */
function ensureAddedColumns(sqlite: Database.Database): void {
  // User-center password columns (password gate on /my). Both are additive and
  // idempotent: existing users keep NULL/0, i.e. "no password yet".
  const userColumns = sqlite.pragma('table_info(users)') as Array<{ name: string }>;
  if (!userColumns.some((column) => column.name === 'password_hash')) {
    sqlite.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  if (!userColumns.some((column) => column.name === 'password_version')) {
    sqlite.exec('ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0');
  }

  const columns = sqlite.pragma('table_info(sources)') as Array<{ name: string }>;
  const hasOwner = columns.some((column) => column.name === 'owner_user_id');
  if (!hasOwner) {
    sqlite.exec('ALTER TABLE sources ADD COLUMN owner_user_id INTEGER');
  }
  // v2 access model: 'all' (public, every user) or 'restricted' (shared with an
  // allowlist). Existing rows must keep today's behaviour, hence the 'all'
  // default; SQLite applies it to the existing rows during the ALTER below.
  const hasAccessMode = columns.some((column) => column.name === 'access_mode');
  if (!hasAccessMode) {
    sqlite.exec("ALTER TABLE sources ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'all'");
  }
  // Rows written before the column existed (or by an older binary) may carry
  // NULL/unknown values; normalise them to public.
  sqlite.exec(
    "UPDATE sources SET access_mode = 'all' WHERE access_mode IS NULL OR access_mode NOT IN ('all', 'restricted')",
  );
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS sources_owner_id_idx ON sources (owner_user_id, id)',
  );
  // `subscription-userinfo` passthrough: parsed parts of the last successful
  // refresh. Nullable on purpose — providers that omit the header (or send it
  // in an unparseable form) must not look like "0 bytes / never expires".
  // Owner-pausable sources (user center): NULL = enabled, so every row written
  // before this column existed keeps today's behaviour.
  if (!columns.some((column) => column.name === 'enabled')) {
    sqlite.exec('ALTER TABLE sources ADD COLUMN enabled INTEGER');
  }
  const userinfoColumns: Array<[string, string]> = [
    ['userinfo_upload', 'INTEGER'],
    ['userinfo_download', 'INTEGER'],
    ['userinfo_total', 'INTEGER'],
    ['userinfo_expire', 'INTEGER'],
    ['userinfo_refreshed_at', 'INTEGER'],
  ];
  for (const [name, type] of userinfoColumns) {
    if (!columns.some((column) => column.name === name)) {
      sqlite.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
    }
  }
}

export function ensureSchema(sqlite: Database.Database): void {
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(CREATE_TABLES_SQL);
  ensureAddedColumns(sqlite);
}

export function openDb(options: OpenDbOptions = {}): SubhubDb {
  const path = resolveDbPath(options.path);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  ensureSchema(sqlite);
  return drizzle(sqlite, { schema });
}

export { schema };
