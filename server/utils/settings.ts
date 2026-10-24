// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Site settings (in-app, stored in the database — deliberately *not* env vars).
 *
 * The first setting is `sub_path`: the URL prefix every subscription link is
 * served under. `/s/<token>` looks like every airport's subscription URL and
 * gets blocked/targeted by DPI, so the owner can make it look like anything
 * else (`dl`, `sub/x`, …) from the admin UI — a saved change takes effect
 * immediately, no restart and no deploy.
 *
 * Storage: the tiny `settings` key/value table (see `server/db/index.ts`). One
 * row per key, `value` is the plain-text value; unknown keys are ignored.
 *
 * Validation/normalisation lives here as pure functions
 * (`normalizeSubPath` / `validateSubPath`) so both the API and the tests use
 * exactly the same rules:
 * - trimmed, leading/trailing slashes stripped, empty segments collapsed;
 * - every segment matches /^[a-z0-9][a-z0-9_-]*$/ (ASCII lower-case);
 * - multi-segment allowed (`x/y`);
 * - must not collide with the admin entrance path or a reserved route root.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { settings } from '../db/schema';
import { ValidationError } from './admin-validation';

/** Setting key holding the subscription URL prefix. */
export const SUB_PATH_KEY = 'sub_path';

/** Built-in default; keeps existing `/s/<token>` links working out of the box. */
export const DEFAULT_SUB_PATH = 's';

/**
 * Path roots the app owns (page routes, Nitro internals, auth). A prefix may
 * not shadow any of them — otherwise `/login` or `/api/...` would be rewritten
 * into a subscription URL and the admin UI could break.
 */
export const RESERVED_SUB_PATH_ROOTS = [
  'api',
  '_nuxt',
  'login',
  'users',
  'sources',
  'profiles',
  'preview',
  'logs',
  'my',
] as const;

/**
 * Admin entrance default when `SUBHUB_ADMIN_PATH` is unset — must match the
 * admin gate's default (`/admin`, feat/admin-path) so a subscription prefix
 * can never shadow the entrance.
 */
export const DEFAULT_ADMIN_PATH = 'admin';

/** Maximum number of segments in the prefix. */
export const SUB_PATH_MAX_SEGMENTS = 4;
/** Maximum overall length of the normalised prefix. */
export const SUB_PATH_MAX_LENGTH = 64;

const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Effective admin entrance path (no slashes). Was an env var in an abandoned
 * branch; kept as a function so the settings validation and the UI agree.
 */
export function adminEntrancePath(): string {
  const raw = (process.env.SUBHUB_ADMIN_PATH ?? '').trim().replace(/^\/+|\/+$/g, '');
  return raw || DEFAULT_ADMIN_PATH;
}

/**
 * Normalise a candidate prefix: trim, strip surrounding slashes, drop empty
 * segments (`/dl//a/` -> `dl/a`). Does **not** validate the segment alphabet.
 */
export function normalizeSubPath(raw: string): string {
  return raw
    .trim()
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/')
    .toLowerCase();
}

export type SubPathResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Validate + normalise a prefix. Returns the canonical form on success and a
 * human-readable (Chinese, shown in the admin UI) error otherwise.
 */
export function validateSubPath(raw: unknown): SubPathResult {
  if (typeof raw !== 'string') return { ok: false, error: '订阅链接前缀必须是字符串' };
  const value = normalizeSubPath(raw);
  if (!value) return { ok: false, error: '订阅链接前缀不能为空' };
  if (value.length > SUB_PATH_MAX_LENGTH) {
    return { ok: false, error: `订阅链接前缀最长 ${SUB_PATH_MAX_LENGTH} 个字符` };
  }
  const segments = value.split('/');
  if (segments.length > SUB_PATH_MAX_SEGMENTS) {
    return { ok: false, error: `订阅链接前缀最多 ${SUB_PATH_MAX_SEGMENTS} 段` };
  }
  for (const segment of segments) {
    if (!SEGMENT_PATTERN.test(segment)) {
      return {
        ok: false,
        error: `路径段「${segment}」不合法：只能使用字母、数字、- 和 _，且不能以 - 或 _ 开头`,
      };
    }
  }
  const first = segments[0]!;
  const admin = normalizeSubPath(adminEntrancePath());
  if (value === admin || first === admin) {
    return { ok: false, error: `订阅链接前缀不能与后台入口路径「${admin}」相同` };
  }
  if ((RESERVED_SUB_PATH_ROOTS as readonly string[]).includes(first)) {
    return { ok: false, error: `订阅链接前缀不能使用系统保留路径「${first}」` };
  }
  return { ok: true, value };
}

/** Read one raw setting; `null` when unset. */
export function readSetting(db: SubhubDb, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value ?? null;
}

/** Upsert one setting. */
export function writeSetting(db: SubhubDb, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

/** Current subscription prefix, validated on read; a broken row falls back. */
export function getSubPath(db: SubhubDb): string {
  const stored = readSetting(db, SUB_PATH_KEY);
  if (!stored) return DEFAULT_SUB_PATH;
  const result = validateSubPath(stored);
  return result.ok ? result.value : DEFAULT_SUB_PATH;
}

/**
 * Validate and persist a new prefix. Invalid input throws `ValidationError`
 * (400) and leaves the stored value untouched. Returns the canonical prefix
 * (the settings cache is bypassed here — callers should also invalidate it).
 */
export function setSubPath(db: SubhubDb, raw: unknown): string {
  const result = validateSubPath(raw);
  if (!result.ok) throw new ValidationError(result.error);
  writeSetting(db, SUB_PATH_KEY, result.value);
  return result.value;
}

/**
 * Short cache for the middleware (one DB read per request would be wasteful on
 * a hot, unauthenticated path). **No TTL on purpose**: a wall-clock TTL would
 * make a saved change take up to five seconds to apply and — worse — is not
 * testable without sleeping. Instead the cache is invalidated explicitly:
 * - `PUT /api/admin/settings` after a save (same process, instant effect),
 * - `readSetting`/`getSubPath` called directly (so a direct DB write by tests
 *   or a script is seen immediately),
 * - a stored value that no longer validates.
 * The TTL constant is kept as documentation of the previous design's bound.
 */
export const SUB_PATH_CACHE_TTL_MS = 5_000;

interface SubPathCacheEntry {
  value: string;
  at: number;
}

let cache: SubPathCacheEntry | null = null;

/** Cached effective prefix. */
export function cachedSubPath(db: SubhubDb, now: number = Date.now()): string {
  if (cache) return cache.value;
  const value = getSubPath(db);
  cache = { value, at: now };
  return value;
}

/** Drop the cached prefix (after a save; tests). */
export function invalidateSubPathCache(): void {
  cache = null;
}

/** Prime the cache (tests / diagnostics). */
export function primeSubPathCache(value: string, now: number = Date.now()): void {
  cache = { value, at: now };
}

/* ------------------------------------------------------------------- DTO -- */

/** Settings as exposed by GET /api/admin/settings. */
export interface AdminSettings {
  /** Effective subscription prefix (no slashes), e.g. `s` or `dl`. */
  subPath: string;
  /** Built-in default, for the 恢复默认 hint in the UI. */
  defaultSubPath: string;
  /** Roots a prefix may not shadow (shown in the form hint). */
  reservedRoots: string[];
  /** Effective admin entrance path (validated against the prefix). */
  adminPath: string;
}

export function getAdminSettings(db: SubhubDb): AdminSettings {
  return {
    subPath: getSubPath(db),
    defaultSubPath: DEFAULT_SUB_PATH,
    reservedRoots: [...RESERVED_SUB_PATH_ROOTS],
    adminPath: adminEntrancePath(),
  };
}

/** Settings embedded in the dashboard stats payload (the UI's runtime info). */
export interface RuntimeSettings {
  subPath: string;
}

export function getRuntimeSettings(db: SubhubDb): RuntimeSettings {
  return { subPath: getSubPath(db) };
}
