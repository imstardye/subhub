// SPDX-License-Identifier: AGPL-3.0-only
/** POST /api/admin/logout — clear the admin session cookie. Idempotent. */
import { logoutCookieHeader, type AdminEvent } from '../../utils/admin-auth';

export default function adminLogoutHandler(event: AdminEvent) {
  event.node.res.setHeader('set-cookie', logoutCookieHeader());
  event.node.res.setHeader('cache-control', 'no-store');
  return { ok: true };
}
