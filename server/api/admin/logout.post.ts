// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/logout — end the admin session server-side and clear the cookie.
 *
 * The cookie is cleared unconditionally and the session id carried by it is
 * revoked (session-revocation.ts), so a copied cookie is rejected on the next
 * request instead of staying valid until expiry. Idempotent: without a (valid)
 * cookie this only clears the cookie.
 */
import { logoutCookieHeader, revokeSession, type AdminEvent } from '../../utils/admin-auth';

export default function adminLogoutHandler(event: AdminEvent) {
  revokeSession(event);
  event.node.res.setHeader('set-cookie', logoutCookieHeader());
  event.node.res.setHeader('cache-control', 'no-store');
  return { ok: true };
}
