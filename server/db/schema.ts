// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Database schema for subhub.
 *
 * Only the core auth/subscription tables live here. Ciphertext columns store
 * output of `server/db/crypto.ts` (`v1:` prefix + base64 iv/tag/data), never
 * plaintext URLs.
 */
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Subscription users. `token` is the random export token used in /s/:token. */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  token: text('token').notNull().unique(),
  profileId: integer('profile_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().defaultNow(),
});

/**
 * Remote/local subscription sources. `url` is stored encrypted (ciphertext only).
 *
 * Sharing model: every source is either PUBLIC (`ownerUserId` null, shared by
 * every user) or DEDICATED to exactly one user. A user's export is the union of
 * their dedicated sources and all public ones. Dedicated sources are deleted
 * together with their owner (see `deleteUser` in `server/utils/admin-users.ts`).
 */
export const sources = sqliteTable('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** Owning user for a dedicated source; null = public. */
  ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** Encrypted URL, see crypto.ts. */
  url: text('url').notNull(),
  type: text('type', { enum: ['remote', 'local'] }).notNull().default('remote'),
  ua: text('ua'),
  refreshMinutes: integer('refresh_minutes').notNull().default(60),
  lastOkAt: integer('last_ok_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  cacheBlob: text('cache_blob'),
});

/** Ordered many-to-many between users and sources. */
export const userSources = sqliteTable(
  'user_sources',
  {
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sourceId] }), index('user_sources_user_sort_idx').on(t.userId, t.sort)],
);

/** Rule profiles. Exactly one of iniUrl/iniText is expected to be set. */
export const profiles = sqliteTable('profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  iniUrl: text('ini_url'),
  iniText: text('ini_text'),
  variant: text('variant', { enum: ['mihomo', 'legacy'] }).notNull().default('mihomo'),
  dnsTemplate: text('dns_template'),
  options: text('options', { mode: 'json' }).$type<Record<string, unknown>>(),
});

/** Subscription access log (retention handled outside this skeleton). */
export const accessLogs = sqliteTable(
  'access_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id'),
    target: text('target'),
    ua: text('ua'),
    ip: text('ip'),
    status: integer('status'),
    ms: integer('ms'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().defaultNow(),
  },
  (t) => [
    index('access_logs_user_created_idx').on(t.userId, t.createdAt),
    index('access_logs_created_idx').on(t.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type UserSource = typeof userSources.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type AccessLog = typeof accessLogs.$inferSelect;
export type NewAccessLog = typeof accessLogs.$inferInsert;
