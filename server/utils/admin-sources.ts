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
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { encrypt, decrypt } from '../db/crypto';
import { sources, type Source } from '../db/schema';
import {
  maskUrl,
  parseId,
  parseName,
  parseOptionalText,
  parseRefreshMinutes,
  parseSourceType,
  parseSourceUrl,
  UA_MAX_LENGTH,
  ValidationError,
  type SourceType,
} from './admin-validation';

/** Source as exposed by the API: ciphertext and plaintext URL are both absent. */
export interface AdminSource {
  id: number;
  name: string;
  /** Masked URL, e.g. `https://example.com/sub?***`. */
  urlMasked: string;
  type: SourceType;
  ua: string | null;
  refreshMinutes: number;
  lastOkAt: string | null;
  lastError: string | null;
  hasCache: boolean;
}

/** Decrypt for masking only; a bad ciphertext must not break the list. */
function maskedUrl(ciphertext: string): string {
  try {
    return maskUrl(decrypt(ciphertext));
  } catch {
    return '(unreadable)';
  }
}

export function toAdminSource(row: Source): AdminSource {
  return {
    id: row.id,
    name: row.name,
    urlMasked: maskedUrl(row.url),
    type: row.type,
    ua: row.ua ?? null,
    refreshMinutes: row.refreshMinutes,
    lastOkAt: row.lastOkAt ? row.lastOkAt.toISOString() : null,
    lastError: row.lastError ?? null,
    hasCache: Boolean(row.cacheBlob),
  };
}

export function listSources(db: SubhubDb): AdminSource[] {
  return db.select().from(sources).orderBy(sources.id).all().map(toAdminSource);
}

export function getSource(db: SubhubDb, rawId: unknown): AdminSource {
  const id = parseId(rawId);
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new ValidationError('source not found', 404);
  return toAdminSource(row);
}

export function createSource(db: SubhubDb, body: Record<string, unknown>): AdminSource {
  if (!('url' in body)) throw new ValidationError('url is required');
  // Validated (http/https, etc.) *before* encryption.
  const url = parseSourceUrl(body.url);
  const name = parseName(body.name);
  const type = parseSourceType(body.type);
  const ua = parseOptionalText(body.ua, 'ua', UA_MAX_LENGTH);
  const refreshMinutes = parseRefreshMinutes(body.refreshMinutes);

  const row = db
    .insert(sources)
    // Ciphertext only; the plaintext never reaches the database.
    .values({ name, url: encrypt(url), type, ua, refreshMinutes })
    .returning()
    .get();
  if (!row) throw new Error('could not create source');
  return toAdminSource(row);
}

export function updateSource(
  db: SubhubDb,
  rawId: unknown,
  body: Record<string, unknown>,
): AdminSource {
  const id = parseId(rawId);
  const existing = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!existing) throw new ValidationError('source not found', 404);

  const patch: Partial<Pick<Source, 'name' | 'url' | 'type' | 'ua' | 'refreshMinutes'>> = {};
  if ('name' in body) patch.name = parseName(body.name);
  if ('url' in body) patch.url = encrypt(parseSourceUrl(body.url));
  if ('type' in body) patch.type = parseSourceType(body.type);
  if ('ua' in body) patch.ua = parseOptionalText(body.ua, 'ua', UA_MAX_LENGTH);
  if ('refreshMinutes' in body) patch.refreshMinutes = parseRefreshMinutes(body.refreshMinutes);

  if (Object.keys(patch).length === 0) return toAdminSource(existing);

  const row = db.update(sources).set(patch).where(eq(sources.id, id)).returning().get();
  if (!row) throw new ValidationError('source not found', 404);
  return toAdminSource(row);
}

export function deleteSource(db: SubhubDb, rawId: unknown): { ok: true; id: number } {
  const id = parseId(rawId);
  const existing = db.select({ id: sources.id }).from(sources).where(eq(sources.id, id)).get();
  if (!existing) throw new ValidationError('source not found', 404);
  db.delete(sources).where(eq(sources.id, id)).run();
  return { ok: true, id };
}
