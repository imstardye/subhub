// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription source management for /api/admin/sources (P3).
 *
 * URLs are secrets: they are encrypted with `server/db/crypto.ts` before they
 * touch the database and are **never** returned by the API. List/read responses
 * only carry `urlMasked` (scheme + host + path, query replaced by `***`), built
 * on the server from the decrypted value. A plaintext URL only ever leaves the
 * server encrypted (at rest) or masked (over the wire).
 *
 * Updates that do not include `url` keep the stored ciphertext untouched, so
 * editing a name does not require re-entering the URL.
 *
 * Access model v2 — a source is exactly one of:
 * - DEDICATED (专属): `ownerUserId` set. Only that user's export carries it; a
 *   dedicated source has no allowlist (accessMode stays 'all', allowlist empty).
 * - PUBLIC (公共): `ownerUserId` null + `accessMode` 'all'. Every user gets it.
 *   This is the default for existing rows and for bodies without `accessMode`.
 * - SHARED (共享): `ownerUserId` null + `accessMode` 'restricted'. Only the
 *   users in `source_allowed_users` get it.
 *
 * Consistency rules enforced here (not left to the caller):
 * - an owner clears `accessMode`/allowlist (dedicated);
 * - `accessMode` 'all' clears the allowlist;
 * - `accessMode` 'restricted' without `allowedUserIds` keeps the stored
 *   allowlist (an edit that only changes the name must not empty it), a
 *   provided list replaces it.
 *
 * Every id (owner as well as allowlist entries) is validated against the users
 * table so a source can never point at a missing user.
 */
import { eq, inArray } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { encrypt, decrypt } from '../db/crypto';
import { sourceAllowedUsers, sources, userSourceChoices, users, type Source } from '../db/schema';
import { isSourceDisabled } from './export-nodes';
import { hasUserInfo } from './userinfo';
import {
  maskUrl,
  parseId,
  parseIdList,
  parseName,
  parseOptionalText,
  parseEnabled,
  parseRefreshMinutes,
  parseSourceAccessMode,
  parseSourceType,
  parseSourceUrl,
  UA_MAX_LENGTH,
  ValidationError,
  type SourceAccessMode,
  type SourceType,
} from './admin-validation';

/** Source as exposed by the API: ciphertext and plaintext URL are both absent. */
export interface AdminSource {
  id: number;
  name: string;
  /** Owning user for a dedicated source; null = public or shared. */
  ownerUserId: number | null;
  /** 'all' (public) or 'restricted' (shared). Always 'all' for a dedicated source. */
  accessMode: SourceAccessMode;
  /** Allowlist user ids of a shared source, ascending; empty otherwise. */
  allowedUserIds: number[];
  /** Masked URL, e.g. `https://example.com/sub?***`. */
  urlMasked: string;
  type: SourceType;
  ua: string | null;
  refreshMinutes: number;
  /** Paused by its owner (user center toggle) or the admin. */
  enabled: boolean;
  lastOkAt: string | null;
  lastError: string | null;
  hasCache: boolean;
  /**
   * Parsed `subscription-userinfo` of the last refresh that carried one
   * (additive, read-only). `null` when the provider never sent a parseable
   * header; each part may still be null on its own.
   */
  userinfo: AdminSourceUserInfo | null;
}

/** Source `subscription-userinfo` as exposed by the API (bytes, epoch seconds). */
export interface AdminSourceUserInfo {
  upload: number | null;
  download: number | null;
  total: number | null;
  /** Unix epoch **seconds**, as the upstream header spells it. */
  expire: number | null;
  /** ISO timestamp of the refresh that captured these values. */
  refreshedAt: string | null;
}

/** Decrypt for masking only; a bad ciphertext must not break the list. */
function maskedUrl(ciphertext: string): string {
  try {
    return maskUrl(decrypt(ciphertext));
  } catch {
    return '(unreadable)';
  }
}

/** Access mode of a row, with pre-migration NULLs read as public. */
function accessModeOf(row: Source): SourceAccessMode {
  return row.accessMode === 'restricted' ? 'restricted' : 'all';
}

/** Allowlists of the given source ids, grouped and ascending. */
function allowedUsersBySource(db: SubhubDb, sourceIds: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (sourceIds.length === 0) return out;
  const rows = db
    .select({ sourceId: sourceAllowedUsers.sourceId, userId: sourceAllowedUsers.userId })
    .from(sourceAllowedUsers)
    .orderBy(sourceAllowedUsers.sourceId, sourceAllowedUsers.userId)
    .all();
  const wanted = new Set(sourceIds);
  for (const row of rows) {
    if (!wanted.has(row.sourceId)) continue;
    const list = out.get(row.sourceId) ?? [];
    list.push(row.userId);
    out.set(row.sourceId, list);
  }
  return out;
}

/**
 * Map one row to the API shape. `allowedUserIds` is passed in because a list
 * response fetches all allowlists in one query instead of N.
 */
export function toAdminSource(row: Source, allowedUserIds: number[] = []): AdminSource {
  const dedicated = row.ownerUserId !== null && row.ownerUserId !== undefined;
  const accessMode = dedicated ? 'all' : accessModeOf(row);
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId ?? null,
    accessMode,
    // A dedicated or public source never reports an allowlist.
    allowedUserIds: accessMode === 'restricted' ? [...allowedUserIds].sort((a, b) => a - b) : [],
    urlMasked: maskedUrl(row.url),
    type: row.type,
    ua: row.ua ?? null,
    refreshMinutes: row.refreshMinutes,
    enabled: !isSourceDisabled(row),
    lastOkAt: row.lastOkAt ? row.lastOkAt.toISOString() : null,
    lastError: row.lastError ?? null,
    hasCache: Boolean(row.cacheBlob),
    userinfo: toAdminUserInfo(row),
  };
}

/** Stored userinfo, or `null` when the provider never sent a parseable value. */
function toAdminUserInfo(row: Source): AdminSourceUserInfo | null {
  const info: AdminSourceUserInfo = {
    upload: row.userinfoUpload ?? null,
    download: row.userinfoDownload ?? null,
    total: row.userinfoTotal ?? null,
    expire: row.userinfoExpire ?? null,
    refreshedAt: row.userinfoRefreshedAt ? row.userinfoRefreshedAt.toISOString() : null,
  };
  return hasUserInfo(info) ? info : null;
}

/**
 * Parse the optional owner. Absent/null/'' means public (returns null); a
 * positive integer must reference an existing user, otherwise 400
 * 'invalid ownerUserId' (same message for a malformed value and a missing
 * user, so the API does not leak which ids exist).
 */
export function parseOwnerUserId(db: SubhubDb, value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const id = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new ValidationError('invalid ownerUserId');
  }
  const owner = db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
  if (!owner) throw new ValidationError('invalid ownerUserId');
  return id;
}

/**
 * Parse and validate the allowlist. A malformed entry and a missing user share
 * the same 400 'invalid allowedUserIds' (no existence leak); duplicates are
 * deduped, and the result is sorted for a stable response.
 */
export function parseAllowedUserIds(db: SubhubDb, value: unknown): number[] {
  const ids = parseIdList(value, 'allowedUserIds');
  if (ids.length === 0) return [];
  // One query for the whole set; a single missing id rejects the list.
  const found = db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids))
    .all();
  if (found.length !== ids.length) throw new ValidationError('invalid allowedUserIds');
  return ids;
}

function readAllowlist(db: SubhubDb, sourceId: number): number[] {
  return db
    .select({ userId: sourceAllowedUsers.userId })
    .from(sourceAllowedUsers)
    .where(eq(sourceAllowedUsers.sourceId, sourceId))
    .orderBy(sourceAllowedUsers.userId)
    .all()
    .map((row) => row.userId);
}

export function listSources(db: SubhubDb): AdminSource[] {
  const rows = db.select().from(sources).orderBy(sources.id).all();
  const allowlists = allowedUsersBySource(db, rows.map((row) => row.id));
  return rows.map((row) => toAdminSource(row, allowlists.get(row.id) ?? []));
}

export function getSource(db: SubhubDb, rawId: unknown): AdminSource {
  const id = parseId(rawId);
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new ValidationError('source not found', 404);
  return toAdminSource(row, readAllowlist(db, row.id));
}

export function createSource(db: SubhubDb, body: Record<string, unknown>): AdminSource {
  if (!('url' in body)) throw new ValidationError('url is required');
  // Validated (http/https, etc.) *before* encryption.
  const url = parseSourceUrl(body.url);
  const name = parseName(body.name);
  const type = parseSourceType(body.type);
  const ua = parseOptionalText(body.ua, 'ua', UA_MAX_LENGTH);
  const refreshMinutes = parseRefreshMinutes(body.refreshMinutes);
  const ownerUserId = parseOwnerUserId(db, body.ownerUserId);
  const accessMode = parseSourceAccessMode(body.accessMode);
  // Validated even when ignored, so a malformed list is always a 400.
  const allowedUserIds = parseAllowedUserIds(db, body.allowedUserIds);
  // A dedicated source has no allowlist; 'all' clears it too.
  const effectiveMode: SourceAccessMode =
    ownerUserId !== null || accessMode === 'all' ? 'all' : 'restricted';
  const effectiveList = effectiveMode === 'restricted' ? allowedUserIds : [];

  const row = db.transaction((tx) => {
    const inserted = tx
      .insert(sources)
      // Ciphertext only; the plaintext never reaches the database.
      .values({
        name,
        url: encrypt(url),
        type,
        ua,
        refreshMinutes,
        ownerUserId,
        accessMode: effectiveMode,
      })
      .returning()
      .get();
    if (!inserted) throw new Error('could not create source');
    for (const userId of effectiveList) {
      tx.insert(sourceAllowedUsers).values({ sourceId: inserted.id, userId }).run();
    }
    return inserted;
  });
  return toAdminSource(row, effectiveList);
}

export function updateSource(
  db: SubhubDb,
  rawId: unknown,
  body: Record<string, unknown>,
): AdminSource {
  const id = parseId(rawId);
  const existing = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!existing) throw new ValidationError('source not found', 404);

  const patch: Partial<
    Pick<Source, 'name' | 'url' | 'type' | 'ua' | 'refreshMinutes' | 'ownerUserId' | 'accessMode' | 'enabled'>
  > = {};
  if ('name' in body) patch.name = parseName(body.name);
  if ('url' in body) patch.url = encrypt(parseSourceUrl(body.url));
  if ('type' in body) patch.type = parseSourceType(body.type);
  if ('ua' in body) patch.ua = parseOptionalText(body.ua, 'ua', UA_MAX_LENGTH);
  if ('refreshMinutes' in body) patch.refreshMinutes = parseRefreshMinutes(body.refreshMinutes);
  if ('enabled' in body) patch.enabled = parseEnabled(body.enabled);
  if ('ownerUserId' in body) patch.ownerUserId = parseOwnerUserId(db, body.ownerUserId);
  // Parsed whenever present (not only when they take effect) so a malformed
  // mode or id list is always a 400, even on a dedicated source.
  const requestedMode = 'accessMode' in body ? parseSourceAccessMode(body.accessMode) : null;
  const requestedList =
    'allowedUserIds' in body ? parseAllowedUserIds(db, body.allowedUserIds) : null;

  const owner =
    'ownerUserId' in patch ? patch.ownerUserId ?? null : existing.ownerUserId ?? null;
  const currentMode: SourceAccessMode =
    existing.accessMode === 'restricted' ? 'restricted' : 'all';
  // Dedicated sources ignore accessMode entirely; otherwise an explicit value
  // wins and an omitted one keeps the stored mode.
  const nextMode: SourceAccessMode = owner !== null ? 'all' : requestedMode ?? currentMode;
  // Only a restricted source keeps an allowlist: a provided list replaces the
  // stored one, omitting it keeps the stored allowlist (a rename must not drop
  // it), and a dedicated/public source ends with an empty allowlist.
  const nextList: number[] =
    nextMode === 'restricted' ? requestedList ?? readAllowlist(db, id) : [];
  if (nextMode !== currentMode) patch.accessMode = nextMode;

  const updated = db.transaction((tx) => {
    let row = existing;
    if (Object.keys(patch).length > 0) {
      const updatedRow = tx.update(sources).set(patch).where(eq(sources.id, id)).returning().get();
      if (!updatedRow) throw new ValidationError('source not found', 404);
      row = updatedRow;
    }
    // Idempotent full replace: also drops rows a pre-v2 database may hold.
    tx.delete(sourceAllowedUsers).where(eq(sourceAllowedUsers.sourceId, id)).run();
    for (const userId of nextList) {
      tx.insert(sourceAllowedUsers).values({ sourceId: id, userId }).run();
    }
    return row;
  });
  return toAdminSource(updated, nextList);
}

export function deleteSource(db: SubhubDb, rawId: unknown): { ok: true; id: number } {
  const id = parseId(rawId);
  const existing = db.select({ id: sources.id }).from(sources).where(eq(sources.id, id)).get();
  if (!existing) throw new ValidationError('source not found', 404);
  // Explicit, so it works on migrated databases where the join table has no
  // FK cascade to sources (fresh databases cascade on their own).
  db.delete(sourceAllowedUsers).where(eq(sourceAllowedUsers.sourceId, id)).run();
  // A user-center inclusion choice dies with its source.
  db.delete(userSourceChoices).where(eq(userSourceChoices.sourceId, id)).run();
  db.delete(sources).where(eq(sources.id, id)).run();
  return { ok: true, id };
}
