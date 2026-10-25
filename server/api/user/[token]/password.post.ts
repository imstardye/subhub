// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/password — first-time password setup.
 *
 * The only write endpoint (besides unlock) reachable before the /my session
 * exists. It is only valid while the user has no password yet: once one is
 * set, a second call is a 409 and the page shows the 输入密码 form. On success
 * the server sets the signed `subhub_my` cookie, so the page can enter the
 * dashboard without another round trip.
 *
 * Body: `{ password }` (6–64 chars). No password hash is ever serialised.
 */
import { setupUserPassword, userCenterSessionFor } from '../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { isUserSessionSigningUnavailable } from '../../../utils/user-session';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userPasswordSetupHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      // Fail before writing anything: a production without SUBHUB_SECRET can
      // never issue the cookie, and a password set here would lock the user out.
      if (isUserSessionSigningUnavailable(options?.session)) {
        throw new Error('SUBHUB_SECRET is required in production');
      }
      const body = await parseBody(event);
      const user = setupUserPassword(db, tokenFromPath(event), body.password);
      const session = userCenterSessionFor(user, options?.session);
      event.node.res.setHeader('set-cookie', session.cookie);
      return sendJson(event, 200, { ok: true });
    },
    { ...options, skipUnlock: true },
  );
}
