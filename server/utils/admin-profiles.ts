// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Rule profile management for /api/admin/profiles (P3).
 *
 * Plain functions over the injected database handle, mirroring
 * `admin-users.ts` / `admin-sources.ts` so the routes stay thin and the tests
 * can run against an in-memory SQLite.
 *
 * A profile is a subconverter-style INI (either fetched from `iniUrl` or
 * pasted as `iniText`) plus the output flavour (`mihomo` / `legacy`). Unlike
 * subscription source URLs, rule INIs are not secrets: the list/detail
 * responses carry every field verbatim so the edit form can round-trip them.
 *
 * Validation rules:
 * - `name` is required and trimmed.
 * - `iniUrl` and `iniText` may each be absent, but at least one must be set
 *   (checked on create, and on patch after applying the update).
 * - `iniUrl`, when present, must be an absolute http(s) URL.
 * - `variant` is `mihomo` (default) or `legacy`.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { profiles, users, type Profile } from '../db/schema';
import {
  DNS_TEMPLATE_MAX_LENGTH,
  parseId,
  parseName,
  parseOptionalHttpUrl,
  parseOptionalIniText,
  parseOptionalText,
  parseProfileOptions,
  parseProfileVariant,
  ValidationError,
  type ProfileVariant,
} from './admin-validation';

/** Rule profile as exposed by the API (all fields, nothing masked). */
export interface AdminProfile {
  id: number;
  name: string;
  iniUrl: string | null;
  iniText: string | null;
  variant: ProfileVariant;
  dnsTemplate: string | null;
  options: Record<string, unknown> | null;
}

export function toAdminProfile(row: Profile): AdminProfile {
  const variant = (row.variant ?? 'mihomo') as ProfileVariant;
  return {
    id: row.id,
    name: row.name,
    iniUrl: row.iniUrl ?? null,
    iniText: row.iniText ?? null,
    variant: variant === 'legacy' ? 'legacy' : 'mihomo',
    dnsTemplate: row.dnsTemplate ?? null,
    options: row.options ?? null,
  };
}

/** A profile needs at least one rule source (either an INI URL or inline text). */
function assertHasIniSource(iniUrl: string | null, iniText: string | null): void {
  if (!iniUrl && !iniText) {
    throw new ValidationError('one of iniUrl or iniText is required');
  }
}

export function listProfiles(db: SubhubDb): AdminProfile[] {
  return db.select().from(profiles).orderBy(profiles.id).all().map(toAdminProfile);
}

export function getProfile(db: SubhubDb, rawId: unknown): AdminProfile {
  const id = parseId(rawId);
  const row = db.select().from(profiles).where(eq(profiles.id, id)).get();
  if (!row) throw new ValidationError('profile not found', 404);
  return toAdminProfile(row);
}

export function createProfile(db: SubhubDb, body: Record<string, unknown>): AdminProfile {
  const name = parseName(body.name);
  const iniUrl = parseOptionalHttpUrl(body.iniUrl, 'iniUrl');
  const iniText = parseOptionalIniText(body.iniText);
  assertHasIniSource(iniUrl, iniText);
  const variant = parseProfileVariant(body.variant);
  const dnsTemplate = parseOptionalText(
    body.dnsTemplate,
    'dnsTemplate',
    DNS_TEMPLATE_MAX_LENGTH,
  );
  const options = parseProfileOptions(body.options);

  const row = db
    .insert(profiles)
    .values({ name, iniUrl, iniText, variant, dnsTemplate, options })
    .returning()
    .get();
  if (!row) throw new Error('could not create profile');
  return toAdminProfile(row);
}

/**
 * Patch subset: only provided fields change. `undefined` means "leave as is",
 * `null`/`''` clears the field. The resulting row must still have a rule
 * source, so clearing both `iniUrl` and `iniText` is rejected.
 */
export function updateProfile(
  db: SubhubDb,
  rawId: unknown,
  body: Record<string, unknown>,
): AdminProfile {
  const id = parseId(rawId);
  const existing = db.select().from(profiles).where(eq(profiles.id, id)).get();
  if (!existing) throw new ValidationError('profile not found', 404);

  const patch: Partial<
    Pick<Profile, 'name' | 'iniUrl' | 'iniText' | 'variant' | 'dnsTemplate' | 'options'>
  > = {};
  if ('name' in body) patch.name = parseName(body.name);
  if ('iniUrl' in body) patch.iniUrl = parseOptionalHttpUrl(body.iniUrl, 'iniUrl');
  if ('iniText' in body) patch.iniText = parseOptionalIniText(body.iniText);
  if ('variant' in body) patch.variant = parseProfileVariant(body.variant);
  if ('dnsTemplate' in body) {
    patch.dnsTemplate = parseOptionalText(body.dnsTemplate, 'dnsTemplate', DNS_TEMPLATE_MAX_LENGTH);
  }
  if ('options' in body) patch.options = parseProfileOptions(body.options);

  if (Object.keys(patch).length === 0) return toAdminProfile(existing);

  // Validate the merged result, not just the patch: removing the last source
  // would otherwise leave an unusable profile behind.
  assertHasIniSource(
    'iniUrl' in patch ? patch.iniUrl ?? null : existing.iniUrl ?? null,
    'iniText' in patch ? patch.iniText ?? null : existing.iniText ?? null,
  );

  const row = db.update(profiles).set(patch).where(eq(profiles.id, id)).returning().get();
  if (!row) throw new ValidationError('profile not found', 404);
  return toAdminProfile(row);
}

export function deleteProfile(db: SubhubDb, rawId: unknown): { ok: true; id: number } {
  const id = parseId(rawId);
  const existing = db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).get();
  if (!existing) throw new ValidationError('profile not found', 404);
  // Match the UI copy: users that pointed at this profile fall back to the
  // default (null profileId). Clear the FK before removing the row so we do
  // not leave dangling references.
  db.update(users).set({ profileId: null }).where(eq(users.profileId, id)).run();
  db.delete(profiles).where(eq(profiles.id, id)).run();
  return { ok: true, id };
}
