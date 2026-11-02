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
import { decrypt, encrypt, isEncrypted } from '../db/crypto';
import { ValidationError } from './admin-validation';
import {
  OIDC_DEFAULT_SCOPES,
  OIDC_SETTING_KEYS,
  effectiveOidcConfig,
  normalizeOidcIssuer,
  parseOidcScopes,
  type OidcEffectiveConfig,
  type OidcRawSettings,
} from '../../core/oidc';

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
  'auth',
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
 * a hot, unauthenticated path). Two mechanisms keep it fresh, either suffices:
 * - explicit invalidation: `PUT /api/admin/settings` drops the cache after a
 *   save (same process, instant effect);
 * - a TTL bound: an entry older than `SUB_PATH_CACHE_TTL_MS` is re-read from
 *   the DB. This is the safety net the first design lacked — if an
 *   invalidation ever misses the copy a given middleware instance holds
 *   (another worker, a direct DB write, a missed call site), the stale value
 *   heals within the TTL instead of sticking forever. (Live incident
 *   2026-10-25: prefix changed to `img` in the UI, the gate kept blanking
 *   `/img/*` with the pre-change value until the process restarted.)
 * The clock is injectable (`now`), so the TTL is testable without sleeping.
 */
export const SUB_PATH_CACHE_TTL_MS = 5_000;

interface SubPathCacheEntry {
  value: string;
  at: number;
}

let cache: SubPathCacheEntry | null = null;

/** Cached effective prefix; re-read once the cached entry passes the TTL. */
export function cachedSubPath(db: SubhubDb, now: number = Date.now()): string {
  if (cache && now - cache.at < SUB_PATH_CACHE_TTL_MS) return cache.value;
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

/* ------------------------------------------------------------------ OIDC -- */

/**
 * XAuth (OIDC) client settings — the same `settings` table, five keys
 * (`core/oidc.ts` owns the names and the rules):
 *
 * - `oidc_enabled`      '1' / '0' (default '0');
 * - `oidc_issuer`       the issuer identifier (`https://id.example.com`), no
 *                       trailing slash, no query/hash (the callback matches
 *                       `event.path`, which carries no query string);
 * - `oidc_client_id`    the confidential web client's id;
 * - `oidc_client_secret` ENCRYPTED with `server/db/crypto.ts` (same as source
 *                       URLs) — write-only: it is never serialised;
 * - `oidc_scopes`       default `openid profile email` (v1 never asks for
 *                       `offline_access`; the local session is the 30-day
 *                       `subhub_my` cookie).
 *
 * The client is ACTIVE only when enabled AND issuer, client id and secret are
 * all set; an inactive client answers 404 on `/auth/*` and no UI surfaces it.
 * Nothing here is an env var (owner decision: settings UI, like `sub_path`).
 */
export function getOidcRawSettings(db: SubhubDb): OidcRawSettings {
  return {
    enabled: readSetting(db, OIDC_SETTING_KEYS.enabled),
    issuer: readSetting(db, OIDC_SETTING_KEYS.issuer),
    clientId: readSetting(db, OIDC_SETTING_KEYS.clientId),
    clientSecret: readSetting(db, OIDC_SETTING_KEYS.clientSecret),
    scopes: readSetting(db, OIDC_SETTING_KEYS.scopes),
  };
}

/**
 * The stored client secret in plaintext, or `null` when unset/unreadable
 * (a rotated SUBHUB_SECRET makes old ciphertext undecryptable — the client
 * then counts as "secret not configured" instead of breaking every request).
 */
export function readOidcClientSecret(db: SubhubDb): string | null {
  const stored = readSetting(db, OIDC_SETTING_KEYS.clientSecret);
  if (!stored) return null;
  if (!isEncrypted(stored)) return null;
  try {
    const value = decrypt(stored);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Effective, secret-free OIDC configuration (what `isOidcActive` and the admin
 * GET answer use). Decrypting the secret decides "secret configured".
 */
export function getOidcConfig(db: SubhubDb): OidcEffectiveConfig {
  return effectiveOidcConfig(getOidcRawSettings(db), readOidcClientSecret(db) !== null);
}

/** True when XAuth is enabled and fully configured (see `getOidcConfig`). */
export function isOidcActive(db: SubhubDb): boolean {
  return getOidcConfig(db).active;
}

/** Everything `PUT /api/admin/settings` may change about the OIDC client. */
export interface OidcSettingsInput {
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** '' = keep the stored secret (write-only field), like the write-only URLs. */
  clientSecret: string;
  /** Clears the stored secret (the clear affordance next to the field). */
  clearClientSecret: boolean;
  scopes: string;
}

/** OIDC fields of the settings PUT body (`oidc` object; absent = untouched). */
export interface OidcPatch {
  enabled?: boolean;
  issuer?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  clearClientSecret?: boolean;
  scopes?: unknown;
}

function parseMandatoryText(raw: unknown, label: string, max = 512): string {
  if (typeof raw !== 'string') throw new ValidationError(`${label}必须是字符串`);
  const value = raw.trim();
  if (value.length > max) throw new ValidationError(`${label}过长`);
  return value;
}

/**
 * Validate and persist the OIDC settings (one save path for the settings API).
 *
 * Write-only secret, mirroring the source-URL convention: a blank
 * `clientSecret` keeps the stored value; a non-empty value replaces it (and is
 * encrypted); `clearClientSecret: true` removes it. Issuer/client id/scopes
 * are validated here (400 with a Chinese message; nothing is written on error).
 */
export function setOidcSettings(db: SubhubDb, patch: OidcPatch): OidcEffectiveConfig {
  const values: Partial<Record<(typeof OIDC_SETTING_KEYS)[keyof typeof OIDC_SETTING_KEYS], string>> = {};
  const secret = patch.clientSecret === undefined || patch.clientSecret === null
    ? ''
    : parseMandatoryText(patch.clientSecret, 'client_secret', 1024);

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new ValidationError('启用状态必须是布尔值');
    values[OIDC_SETTING_KEYS.enabled] = patch.enabled ? '1' : '0';
  }
  if (patch.issuer !== undefined) {
    const raw = parseMandatoryText(patch.issuer, 'Issuer');
    const issuer = raw ? normalizeOidcIssuer(raw) : '';
    if (raw && issuer === null) {
      throw new ValidationError('Issuer 必须是 http(s) 地址，且不能带查询参数或 # 片段');
    }
    values[OIDC_SETTING_KEYS.issuer] = issuer ?? '';
  }
  if (patch.clientId !== undefined) {
    values[OIDC_SETTING_KEYS.clientId] = parseMandatoryText(patch.clientId, 'client_id', 256);
  }
  if (patch.scopes !== undefined) {
    const scopes = parseOidcScopes(patch.scopes);
    if (scopes === null) throw new ValidationError('Scopes 只能包含以空格分隔的合法 scope 名称');
    values[OIDC_SETTING_KEYS.scopes] = scopes;
  }

  // Secret: explicit clear wins over a (blank) field; a filled field replaces.
  if (patch.clearClientSecret === true) {
    values[OIDC_SETTING_KEYS.clientSecret] = '';
  } else if (secret) {
    values[OIDC_SETTING_KEYS.clientSecret] = encrypt(secret);
  }

  // Nothing to do for an empty patch; a no-op save must not rewrite rows.
  for (const [key, value] of Object.entries(values)) {
    writeSetting(db, key, value ?? '');
  }
  return getOidcConfig(db);
}

/* ------------------------------------------------------------------- DTO -- */

/** OIDC fields of GET /api/admin/settings — never the client secret value. */
export interface AdminOidcSettings {
  /** The `oidc_enabled` switch (true also when the client is not configured). */
  enabled: boolean;
  /** True only when enabled AND issuer + client id + secret are all set. */
  active: boolean;
  issuer: string;
  clientId: string;
  /** True when a client secret is stored. The value itself is never returned. */
  clientSecretSet: boolean;
  scopes: string;
  defaultScopes: string;
}

export function getAdminOidcSettings(db: SubhubDb): AdminOidcSettings {
  const raw = getOidcRawSettings(db);
  const config = getOidcConfig(db);
  return {
    enabled: raw.enabled === '1',
    active: config.active,
    issuer: raw.issuer ?? '',
    clientId: raw.clientId ?? '',
    clientSecretSet: config.clientSecretConfigured,
    scopes: config.scopes,
    defaultScopes: OIDC_DEFAULT_SCOPES,
  };
}

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
  /** XAuth (OIDC) client settings, secret-free. */
  oidc: AdminOidcSettings;
}

export function getAdminSettings(db: SubhubDb): AdminSettings {
  return {
    subPath: getSubPath(db),
    defaultSubPath: DEFAULT_SUB_PATH,
    reservedRoots: [...RESERVED_SUB_PATH_ROOTS],
    adminPath: adminEntrancePath(),
    oidc: getAdminOidcSettings(db),
  };
}

/** Settings embedded in the dashboard stats payload (the UI's runtime info). */
export interface RuntimeSettings {
  subPath: string;
}

export function getRuntimeSettings(db: SubhubDb): RuntimeSettings {
  return { subPath: getSubPath(db) };
}
