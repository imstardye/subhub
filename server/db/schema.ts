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
 * Sharing model (v2): every source is exactly one of
 * - DEDICATED (专属): `ownerUserId` set — only that user's export carries it.
 * - PUBLIC (公共): `ownerUserId` null + `accessMode` 'all' — every user gets it.
 * - SHARED (共享): `ownerUserId` null + `accessMode` 'restricted' — only the
 *   users listed in `source_allowed_users` get it.
 *
 * A user's export is the union of their dedicated sources, every public source
 * and the shared sources whose allowlist contains them. Dedicated sources are
 * deleted together with their owner (see `deleteUser` in
 * `server/utils/admin-users.ts`); a dedicated source has no allowlist, and
 * deleting a source removes its allowlist rows.
 */
export const sources = sqliteTable('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** Owning user for a dedicated source; null = public or shared. */
  ownerUserId: integer('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
  /**
   * 'all' = public (ignored for a dedicated source); 'restricted' = shared with
   * the `sourceAllowedUsers` allowlist. Existing rows default to 'all'.
   */
  accessMode: text('access_mode', { enum: ['all', 'restricted'] })
    .notNull()
    .default('all'),
  /** Encrypted URL, see crypto.ts. */
  url: text('url').notNull(),
  type: text('type', { enum: ['remote', 'local'] }).notNull().default('remote'),
  ua: text('ua'),
  refreshMinutes: integer('refresh_minutes').notNull().default(60),
  /**
   * `0` = paused by its owner (or the admin): the cache stays, the refresh task
   * skips it. NULL/1 = enabled, which is what every pre-existing row reads as
   * (`hasOwn` in subscription/export-nodes treat "not disabled" as enabled).
   */
  enabled: integer('enabled', { mode: 'boolean' }),
  lastOkAt: integer('last_ok_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  cacheBlob: text('cache_blob'),
  /**
   * Parsed `subscription-userinfo` of the last successful refresh (bytes,
   * `expire` in Unix epoch seconds). Each part is nullable on its own: the
   * header may carry any subset, and providers without it leave everything
   * NULL. See `server/utils/userinfo.ts`.
   */
  userinfoUpload: integer('userinfo_upload'),
  userinfoDownload: integer('userinfo_download'),
  userinfoTotal: integer('userinfo_total'),
  userinfoExpire: integer('userinfo_expire'),
  /** When the stored userinfo was captured (`last_ok_at` of that refresh). */
  userinfoRefreshedAt: integer('userinfo_refreshed_at', { mode: 'timestamp_ms' }),
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

/**
 * Allowlist of a SHARED source (`accessMode` 'restricted'): the users whose
 * export includes it. Legacy `user_sources` is unrelated and no longer read;
 * this table is the source of truth for shared access.
 */
export const sourceAllowedUsers = sqliteTable(
  'source_allowed_users',
  {
    sourceId: integer('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.userId] }),
    index('source_allowed_users_user_idx').on(t.userId, t.sourceId),
  ],
);

/**
 * Per-user inclusion override for a PUBLIC or SHARED source (user center).
 *
 * A user's export includes every public source and every shared source they are
 * allowlisted for **by default**; a row with `included = false` excludes that
 * source from *this* user's exports (and admin previews). No row = included, so
 * a user who never made a choice sees exactly what they saw before the table
 * existed. Dedicated sources are never choosable and never have rows here.
 */
export const userSourceChoices = sqliteTable(
  'user_source_choices',
  {
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sourceId: integer('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
    included: integer('included', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sourceId] })],
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

/**
 * Site settings (key/value). In-app configuration that must be changeable
 * without a redeploy — currently `sub_path`, the subscription URL prefix (see
 * `server/utils/settings.ts`). Deliberately not an env var: the owner changes
 * it from the admin UI and expects it to take effect immediately.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().defaultNow(),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type UserSource = typeof userSources.$inferSelect;
export type SourceAllowedUser = typeof sourceAllowedUsers.$inferSelect;
export type NewSourceAllowedUser = typeof sourceAllowedUsers.$inferInsert;
export type UserSourceChoice = typeof userSourceChoices.$inferSelect;
export type NewUserSourceChoice = typeof userSourceChoices.$inferInsert;
export type SourceAccessMode = NonNullable<Source['accessMode']>;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type AccessLog = typeof accessLogs.$inferSelect;
export type NewAccessLog = typeof accessLogs.$inferInsert;
