// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/user/:token/password — change the password from the dashboard.
 *
 * Requires an unlocked session (the normal gate runs). Body:
 * `{ currentPassword, newPassword }`. The current password is verified through
 * the same per-user+IP throttle; on success the password version is bumped, so
 * every *other* session dies, and this device receives a fresh cookie for the
 * new version (the current session is kept).
 */
import {
  changeUserPassword,
  requireUnlockedUserByToken,
  userCenterSessionFor,
} from '../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { getClientIp } from '../../../utils/client-ip';
import { isUserSessionSigningUnavailable } from '../../../utils/user-session';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userPasswordChangeHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireUnlockedUserByToken(
        db,
        tokenFromPath(event),
        event,
        options?.session,
      );
      // Check before mutating: no signing key means no new cookie can be issued.
      if (isUserSessionSigningUnavailable(options?.session)) {
        throw new Error('SUBHUB_SECRET is required in production');
      }
      const body = await parseBody(event);
      const ip = options?.password?.ip ?? getClientIp(event as never);
      const updated = await changeUserPassword(
        db,
        user,
        { currentPassword: body.currentPassword, newPassword: body.newPassword },
        { ...options?.password, ip },
      );
      const session = userCenterSessionFor(updated, options?.session);
      event.node.res.setHeader('set-cookie', session.cookie);
      return sendJson(event, 200, { ok: true });
    },
    options,
  );
}
