// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/user/:token/token — set a custom subscription token (owner).
 *
 * The user-side twin of the admin endpoint: same validation, same
 * uniqueness rule, same immediate effect — it literally calls the admin
 * path's `setUserToken` with the caller's own id, so the two can never
 * drift apart. Reachable only behind the password gate (`handleUserRequest`
 * requires the unlocked session, like every other /api/user write).
 *
 * Body: `{ token: string }` (8–64 chars, /^[a-z0-9][a-z0-9_-]*$/i, unique
 * across users). Invalid → 400, already taken → 409. The old token stops
 * working everywhere at once; the response carries the new token so the
 * page can navigate to `/my/<newToken>` (the session cookie is bound to
 * the user id + password version, not the token, so it stays unlocked).
 */
import { setUserToken } from '../../../utils/admin-users';
import { requireEnabledUserByToken } from '../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userCustomTokenHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const item = setUserToken(db, user.id, (await parseBody(event)).token);
      return sendJson(event, 200, { token: item.token, userId: user.id });
    },
    options,
  );
}
