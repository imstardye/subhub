// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/refresh — rotate the owner's subscription token.
 *
 * POST only (a GET link must not rotate a credential; the page confirms first).
 * The old token stops working everywhere immediately — this API *and*
 * `/s/<oldToken>` — so the page navigates to `/my/<newToken>`.
 *
 * The generator is shared with the admin API (`server/utils/user-token.ts`).
 */
import { refreshUserToken, requireEnabledUserByToken } from '../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userTokenRefreshHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    (db) => {
      const token = tokenFromPath(event);
      // Resolve first so a disabled user is a 403, not a 404 from the rotation.
      const user = requireEnabledUserByToken(db, token);
      const rotated = refreshUserToken(db, user.token);
      return sendJson(event, 200, { token: rotated.token, userId: user.id });
    },
    options,
  );
}
