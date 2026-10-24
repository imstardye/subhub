// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PATCH /api/user/:token/sources/:id — modify one of the token owner's own
 * DEDICATED sources.
 *
 * Body: `{ name?, enabled?, userAgent?, url? }`. The id is resolved *with the
 * owner* (`sources.owner_user_id = token owner`), so another user's source is a
 * 404 — the same answer as an unknown id.
 *
 * `url` is write-only: it replaces the stored URL only when a non-empty value is
 * submitted; an absent or blank field leaves the saved URL untouched (the value
 * can never be read back, so it cannot be confirmed by re-entering it).
 */
import {
  requireEnabledUserByToken,
  updateOwnSource,
} from '../../../../utils/user-center';
import {
  handleUserRequest,
  sourceIdFromPath,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../../utils/user-routes';
import { parseBody } from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function userSourceUpdateHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const item = updateOwnSource(db, user.id, sourceIdFromPath(event), await parseBody(event));
      return sendJson(event, 200, { item });
    },
    options,
  );
}
