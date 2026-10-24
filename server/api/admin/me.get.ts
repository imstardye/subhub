// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/me — whether the request carries a valid admin session.
 *
 * Always 200 with `{ authenticated: boolean }`; the route middleware redirects
 * to /login when false, and the login page uses it to skip an already
 * authenticated visitor.
 *
 * Authenticated answers also carry `{ subPath }`, the effective subscription
 * URL prefix. The layout's runtime-config channel exposes it to every page
 * (`useState('admin-sub-path')` in `layouts/admin.vue`), so link builders use
 * the live prefix instead of hard-coding `/s/`.
 */
import { me, type AdminEvent } from '../../utils/admin-auth';
import { getRuntimeSettings } from '../../utils/settings';
import { getServerDb } from '../../utils/db';

export default function adminMeHandler(event: AdminEvent) {
  event.node.res.setHeader('cache-control', 'no-store');
  const result = me(event);
  if (!result.authenticated) return result;
  try {
    return { ...result, ...getRuntimeSettings(getServerDb()) };
  } catch {
    // The session answer must never fail because the settings row is unreadable.
    return result;
  }
}
