// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Validation for the admin CRUD API (users and subscription sources).
 *
 * Plain functions with no Nuxt/DB dependency: every rule lives here so the
 * routes stay thin and the limits are unit-tested directly.
 *
 * Source URLs are validated *before* encryption: only absolute http/https URLs
 * without embedded credentials are accepted (the refresh task fetches them).
 */
import { randomBytes } from 'node:crypto';

export const NAME_MAX_LENGTH = 100;
export const NOTE_MAX_LENGTH = 500;
export const UA_MAX_LENGTH = 256;
export const URL_MAX_LENGTH = 2048;

/** Token length in bytes; hex-encoded, so 64 characters (SPEC: 32+ random). */
export const TOKEN_BYTES = 32;

/** Refresh interval bounds in minutes (1 hour default, one week max). */
export const REFRESH_MINUTES_MIN = 5;
export const REFRESH_MINUTES_MAX = 7 * 24 * 60;
export const REFRESH_MINUTES_DEFAULT = 60;

export const SOURCE_TYPES = ['remote', 'local'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Source access model v2. A source is DEDICATED when it has an owner, PUBLIC
 * when it has no owner and `accessMode` 'all', SHARED when it has no owner and
 * `accessMode` 'restricted' (only the allowlist sees it).
 */
export const SOURCE_ACCESS_MODES = ['all', 'restricted'] as const;
export type SourceAccessMode = (typeof SOURCE_ACCESS_MODES)[number];

/** Rule profile output flavour; `mihomo` is the default. */
export const PROFILE_VARIANTS = ['mihomo', 'legacy'] as const;
export type ProfileVariant = (typeof PROFILE_VARIANTS)[number];

/** Inline INI body cap (subconverter profiles are a few KiB at most). */
export const INI_TEXT_MAX_LENGTH = 64 * 1024;
export const DNS_TEMPLATE_MAX_LENGTH = 2048;
/** Serialised `options` JSON cap; keeps a hostile body from bloating the row. */
export const OPTIONS_MAX_LENGTH = 16 * 1024;

/** Validation failure carrying the HTTP status the route should answer. */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Random 32-byte hex subscription token. */
export function generateUserToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Custom token length bounds (a token appears in the URL). */
export const CUSTOM_TOKEN_MIN_LENGTH = 8;
export const CUSTOM_TOKEN_MAX_LENGTH = 64;

/** Custom token alphabet: URL-safe, no dot/slash/space. */
const CUSTOM_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Validate an admin-supplied custom subscription token.
 *
 * 8–64 characters of /^[a-z0-9][a-z0-9_-]*$/i (case-sensitive as typed: it is
 * the URL segment, so `AbC` and `abc` are different tokens). Uniqueness across
 * users is checked by the caller (it owns the database handle).
 */
export function parseCustomToken(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('token is required');
  const token = value.trim();
  if (!token) throw new ValidationError('token is required');
  if (token.length < CUSTOM_TOKEN_MIN_LENGTH || token.length > CUSTOM_TOKEN_MAX_LENGTH) {
    throw new ValidationError(
      `token must be ${CUSTOM_TOKEN_MIN_LENGTH}–${CUSTOM_TOKEN_MAX_LENGTH} characters`,
    );
  }
  if (!CUSTOM_TOKEN_PATTERN.test(token)) {
    throw new ValidationError(
      'token may only contain letters, digits, - and _, and must start with a letter or digit',
    );
  }
  return token;
}

/** Normalise a name: trimmed, non-empty, bounded. */
export function parseName(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('name is required');
  const name = value.trim();
  if (!name) throw new ValidationError('name is required');
  if (name.length > NAME_MAX_LENGTH) {
    throw new ValidationError(`name must be at most ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

/** Optional free-form text (note, ua, ...). Empty string becomes null. */
export function parseOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new ValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

/** Boolean flag; strings from form-ish callers are accepted. */
export function parseEnabled(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new ValidationError('enabled must be a boolean');
}

/**
 * Validate and canonicalise a subscription URL: absolute, http(s) only, no
 * credentials, within `URL_MAX_LENGTH`. Returns `url.toString()` so the stored
 * form is normalised (never shown back to the client — the API only returns a
 * masked host).
 */
export function parseSourceUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('url is required');
  }
  const raw = value.trim();
  if (raw.length > URL_MAX_LENGTH) {
    throw new ValidationError(`url must be at most ${URL_MAX_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('url must use http or https');
  }
  if (url.username || url.password) {
    throw new ValidationError('url must not contain credentials');
  }
  if (!url.hostname) throw new ValidationError('url must contain a host');
  return url.toString();
}

/**
 * Mask a URL for list responses: scheme + host + path only, never the query
 * string (subscription tokens usually live there). The plaintext URL is never
 * returned by the API; this helper is fed the decrypted URL on the server and
 * only its masked form is serialised.
 */
export function maskUrl(plainUrl: string): string {
  try {
    const url = new URL(plainUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '(invalid)';
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${path}?***`;
  } catch {
    return '(invalid)';
  }
}

/** Source type (`remote` fetches periodically, `local` is cache-only). */
export function parseSourceType(value: unknown): SourceType {
  if (value === undefined || value === null || value === '') return 'remote';
  if (typeof value === 'string' && (SOURCE_TYPES as readonly string[]).includes(value)) {
    return value as SourceType;
  }
  throw new ValidationError(`type must be one of: ${SOURCE_TYPES.join(', ')}`);
}

/** Source access mode (`all` by default, i.e. public). */
export function parseSourceAccessMode(value: unknown): SourceAccessMode {
  if (value === undefined || value === null || value === '') return 'all';
  if (typeof value === 'string' && (SOURCE_ACCESS_MODES as readonly string[]).includes(value)) {
    return value as SourceAccessMode;
  }
  throw new ValidationError(`accessMode must be one of: ${SOURCE_ACCESS_MODES.join(', ')}`);
}

/**
 * An allowlist id list: positive integers only, duplicates removed and the
 * result sorted ascending (stable responses). Accepts numeric strings from
 * form payloads. Existence is checked against the users table by the caller
 * (`admin-sources.ts`), which owns the database handle. Absent/null means
 * "no ids".
 */
export function parseIdList(value: unknown, field = 'allowedUserIds'): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`invalid ${field}`);
  const ids: number[] = [];
  for (const raw of value) {
    const id =
      typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new ValidationError(`invalid ${field}`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.sort((a, b) => a - b);
}

/** Refresh interval in whole minutes within [5, 10080]; default 60. */
export function parseRefreshMinutes(value: unknown): number {
  if (value === undefined || value === null || value === '') return REFRESH_MINUTES_DEFAULT;
  const minutes = typeof value === 'string' ? Number(value) : value;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
    throw new ValidationError('refreshMinutes must be an integer');
  }
  if (minutes < REFRESH_MINUTES_MIN || minutes > REFRESH_MINUTES_MAX) {
    throw new ValidationError(
      `refreshMinutes must be between ${REFRESH_MINUTES_MIN} and ${REFRESH_MINUTES_MAX}`,
    );
  }
  return minutes;
}

/**
 * Validate an optional http(s) URL (same rules as source URLs). `null`/absent/
 * empty means "not set". Returns the canonical `url.toString()` form.
 */
export function parseOptionalHttpUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  const raw = value.trim();
  if (raw.length > URL_MAX_LENGTH) {
    throw new ValidationError(`${field} must be at most ${URL_MAX_LENGTH} characters`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`${field} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`${field} must use http or https`);
  }
  if (url.username || url.password) {
    throw new ValidationError(`${field} must not contain credentials`);
  }
  if (!url.hostname) throw new ValidationError(`${field} must contain a host`);
  return url.toString();
}

/** Rule profile variant (`mihomo` by default). */
export function parseProfileVariant(value: unknown): ProfileVariant {
  if (value === undefined || value === null || value === '') return 'mihomo';
  if (typeof value === 'string' && (PROFILE_VARIANTS as readonly string[]).includes(value)) {
    return value as ProfileVariant;
  }
  throw new ValidationError(`variant must be one of: ${PROFILE_VARIANTS.join(', ')}`);
}

/** Optional inline INI text; stored verbatim (trimmed), empty becomes null. */
export function parseOptionalIniText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('iniText must be a string');
  const text = value.trim();
  if (!text) return null;
  if (text.length > INI_TEXT_MAX_LENGTH) {
    throw new ValidationError(`iniText must be at most ${INI_TEXT_MAX_LENGTH} characters`);
  }
  return text;
}

/**
 * Optional free-form JSON object for producer options. Accepts an object or a
 * JSON string that decodes to one; arrays and scalars are rejected.
 */
export function parseProfileOptions(
  value: unknown,
): Record<string, unknown> | null {
  if (value === undefined || value === null || value === '') return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.length > OPTIONS_MAX_LENGTH) {
      throw new ValidationError(`options must be at most ${OPTIONS_MAX_LENGTH} characters`);
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ValidationError('options must be valid JSON');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('options must be a JSON object');
  }
  if (JSON.stringify(parsed).length > OPTIONS_MAX_LENGTH) {
    throw new ValidationError(`options must be at most ${OPTIONS_MAX_LENGTH} characters`);
  }
  return parsed as Record<string, unknown>;
}

/** Positive integer id from a path segment or body field. */
export function parseId(value: unknown): number {
  const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new ValidationError('invalid id', 404);
  }
  return id;
}

/** Body must at least be an object (empty body -> 400). */
export function requireObjectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('invalid JSON body');
  }
  return body as Record<string, unknown>;
}
