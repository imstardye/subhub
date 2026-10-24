// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Effective subscription URL prefix — the ONE place that answers
 * "which first path segment do subscription links live under?".
 *
 * Default is `s` (`/s/<token>/...`), which is what every existing link and
 * route uses. This module is the seam for the coordination item "feat/sub-path"
 * (a DB-backed, admin-configurable prefix): that branch is expected to add the
 * storage + `/api/admin/*` token endpoints and to make `getEffectiveSubPrefix`
 * read the stored value. Until it lands, nothing here touches the database and
 * the default is returned — links built here are identical to the ones
 * `subscriptionUrl()` in `core/utils/admin-ui.ts` builds for the admin console.
 *
 * The public *export routes* (`server/routes/s/*`) are Nitro file routes and are
 * deliberately not rewritten by this module: a stored prefix only changes the
 * links the UI shows once the sub-path branch (or a rewrite middleware) lands.
 */
import type { SubhubDb } from '../db';
import { EXPORT_TARGETS, type ExportTarget } from './targets';

/** First path segment of subscription links when nothing is configured. */
export const DEFAULT_SUB_PREFIX = 's';

/**
 * Export targets in display order — the same list as `targets.ts`, re-exported
 * under this module's own name so the user-center surface does not shadow the
 * Nitro auto-import of `EXPORT_TARGETS` (that produced a build warning).
 */
export const USER_CENTER_EXPORT_TARGETS = EXPORT_TARGETS;

/** A usable prefix: one or more non-empty, slash-free URL segments. */
const PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*(\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;

/**
 * The prefix subscription links are built with for this database.
 *
 * Seam: feat/sub-path replaces the body with a lookup of the stored effective
 * prefix (falling back to `DEFAULT_SUB_PREFIX`). The `db` argument is already in
 * the signature so that change stays local to this file.
 */
export function getEffectiveSubPrefix(_db?: SubhubDb | null): string {
  return DEFAULT_SUB_PREFIX;
}

/** Normalise a candidate prefix; anything unusable becomes the default. */
export function normalizeSubPrefix(value: string | null | undefined): string {
  const text = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!text || !PREFIX_PATTERN.test(text)) return DEFAULT_SUB_PREFIX;
  return text;
}

/** Effective prefix for an explicit database handle (null-safe, normalised). */
export function resolveSubPrefix(db?: SubhubDb | null): string {
  try {
    return normalizeSubPrefix(getEffectiveSubPrefix(db));
  } catch {
    return DEFAULT_SUB_PREFIX;
  }
}

export interface SubscriptionUrlOptions {
  /** Absolute origin (`https://hub.example.com`); may carry a base path. */
  origin: string;
  token: string;
  /** Export target; omitted means the User-Agent default (`/s/<token>`). */
  target?: ExportTarget | string | null;
  /**
   * Rule-profile name for the per-request override (feat/profile-suffix):
   * `/s/<token>/<target>/<profile>`, or `/s/<token>/<profile>` without a target.
   */
  profile?: string | null;
  /** Subscription prefix; defaults to `s` (see `resolveSubPrefix`). */
  prefix?: string | null;
}

/**
 * Build a subscription link: `<origin>/<prefix>/<token>[/<target>[/<profile>]]`.
 *
 * With the default prefix and no profile this is byte-for-byte what
 * `subscriptionUrl()` (admin console) produces. A profile name alone (no
 * target) keeps the 2nd-segment form the export handler supports; choosing the
 * user's assigned profile means "no suffix", and that decision is made by the
 * caller (the user center never writes `users.profileId`).
 */
export function buildSubscriptionUrl(options: SubscriptionUrlOptions): string {
  const base = (options.origin ?? '').replace(/\/+$/, '');
  const prefix = normalizeSubPrefix(options.prefix ?? DEFAULT_SUB_PREFIX);
  const target = typeof options.target === 'string' ? options.target.trim() : '';
  const profile = typeof options.profile === 'string' ? options.profile.trim() : '';
  const segments = [base, prefix, options.token];
  if (target) segments.push(target);
  if (profile) segments.push(profile);
  return segments.join('/');
}
