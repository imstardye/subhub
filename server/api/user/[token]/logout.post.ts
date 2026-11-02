// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/logout — local logout of a password session.
 *
 * Clears the signed `subhub_my` cookie (and the XAuth logout cookie, so a
 * later XAuth login never carries a stale ID token). It is idempotent and works
 * without a valid session, like the admin logout: a locked browser must always
 * be able to clean up. XAuth sessions log out through the browser route
 * `/auth/logout` (it also ends the IdP session); this endpoint is the
 * local-only counterpart.
 */
import { handleUserRequest, tokenFromPath, type UserRequestOptions } from '../../../utils/user-routes';
import { clearUserSessionCookieHeader } from '../../../utils/user-session';
import { clearIdTokenCookieHeader } from '../../../utils/oidc';
import { requireUserByToken } from '../../../utils/user-center';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userLogoutHandler(event: AdminApiEvent, options?: UserRequestOptions) {
  return handleUserRequest(
    event,
    (db) => {
      // Resolving the token keeps the 404 contract for an unknown token.
      requireUserByToken(db, tokenFromPath(event));
      event.node.res.setHeader('set-cookie', [
        clearUserSessionCookieHeader(),
        clearIdTokenCookieHeader(),
      ]);
      return sendJson(event, 200, { ok: true });
    },
    { ...options, skipUnlock: true },
  );
}
