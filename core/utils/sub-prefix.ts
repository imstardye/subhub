// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure subscription-link building (client-safe: no DB, no node builtins).
 *
 * The effective prefix itself is stored in the `sub_path` site setting and
 * read server-side (`server/utils/sub-prefix.ts` -> `getEffectiveSubPrefix`);
 * this module only knows how to *build* a link from a prefix, a token, an
 * optional target and an optional profile name. Kept under `core/` because
 * the user-center page logic (`core/utils/user-center.ts`) runs in the
 * browser bundle — importing the server module from there transitively
 * pulled `node:crypto` (via settings -> admin-validation) into the client
 * build and broke it.
 */
import { EXPORT_TARGETS, type ExportTarget } from '../../server/utils/targets';

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

/** Normalise a candidate prefix; anything unusable becomes the default. */
export function normalizeSubPrefix(value: string | null | undefined): string {
  const text = typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!text || !PREFIX_PATTERN.test(text)) return DEFAULT_SUB_PREFIX;
  return text;
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
