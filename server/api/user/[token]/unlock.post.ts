// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/unlock — verify the user-center password.
 *
 * Body: `{ password }`. Failures are throttled per user+client IP through
 * `login-throttle` (over-limit attempts wait longer, never hard-lock). A
 * correct password refunds the counted attempt and sets the signed
 * `subhub_my` cookie (30 days, HttpOnly).
 *
 * No password set yet -> 401 `{ status: 'needs-setup' }` (the page then shows
 * the setup form). Wrong password -> 401 `{ status: 'wrong-password' }`.
 */
import { unlockUserPassword, userCenterSessionFor } from '../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { getClientIp } from '../../../utils/client-ip';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userUnlockHandler(event: AdminApiEvent, options?: UserRequestOptions) {
  return handleUserRequest(
    event,
    async (db) => {
      const body = await parseBody(event);
      const ip = options?.password?.ip ?? getClientIp(event as never);
      const user = await unlockUserPassword(db, tokenFromPath(event), body.password, {
        ...options?.password,
        ip,
      });
      const session = userCenterSessionFor(user, options?.session);
      event.node.res.setHeader('set-cookie', session.cookie);
      return sendJson(event, 200, { ok: true });
    },
    { ...options, skipUnlock: true },
  );
}
