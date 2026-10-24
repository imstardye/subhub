// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/admin/users/:id/token — set a custom subscription token (admin).
 *
 * Body: `{ token: string }` (8–64 chars, /^[a-z0-9][a-z0-9_-]*$/i, unique
 * across users). The previous link stops working immediately; the user row with
 * the new token is returned. Invalid → 400, already taken → 409.
 */
import { setUserToken } from '../../../../utils/admin-users';
import {
  handleAdminRequest,
  idFromPath,
  parseBody,
  type AdminRequestOptions,
} from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function adminUserTokenHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) =>
      sendJson(event, 200, {
        item: setUserToken(db, idFromPath(event, 'users'), (await parseBody(event)).token),
      }),
    options,
  );
}
