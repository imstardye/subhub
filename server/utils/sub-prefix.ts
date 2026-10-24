// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Effective subscription URL prefix — the ONE place that answers
 * "which first path segment do subscription links live under?".
 *
 * The value is the `sub_path` site setting (feat/sub-path,
 * `server/utils/settings.ts` — an in-app setting, deliberately no env
 * override), read through `getSubPath`, so the links the user center builds
 * always match the prefix the sub-path middleware actually serves (and the
 * admin console's `subscriptionUrlWithPrefix`).
 *
 * The pure link-building helpers live in `core/utils/sub-prefix.ts`:
 * page-side code imports them from there, because importing THIS module
 * from the browser bundle would transitively pull `node:crypto` (via
 * settings -> admin-validation) into the client build.
 */
import type { SubhubDb } from '../db';
import { getSubPath } from './settings';
import {
  DEFAULT_SUB_PREFIX,
  normalizeSubPrefix,
} from '../../core/utils/sub-prefix';

export {
  DEFAULT_SUB_PREFIX,
  USER_CENTER_EXPORT_TARGETS,
  normalizeSubPrefix,
  buildSubscriptionUrl,
  type SubscriptionUrlOptions,
} from '../../core/utils/sub-prefix';

/**
 * The prefix subscription links are built with for this database: the stored
 * `sub_path` setting (`getSubPath` validates it and falls back to the
 * default); without a DB handle, or on any read failure, the default.
 */
export function getEffectiveSubPrefix(db?: SubhubDb | null): string {
  if (!db) return DEFAULT_SUB_PREFIX;
  try {
    return getSubPath(db);
  } catch {
    return DEFAULT_SUB_PREFIX;
  }
}

/** Effective prefix for an explicit database handle (null-safe, normalised). */
export function resolveSubPrefix(db?: SubhubDb | null): string {
  try {
    return normalizeSubPrefix(getEffectiveSubPrefix(db));
  } catch {
    return DEFAULT_SUB_PREFIX;
  }
}
