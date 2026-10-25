// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DELETE /api/user/:token/sources/:id — delete one of the token owner's own
 * DEDICATED sources.
 *
 * Same ownership rule as the PATCH: the id is resolved *with the owner* (and
 * must be a dedicated row), so a public/shared source, another user's source
 * and an unknown id all answer the same 404 — ids cannot be probed.
 *
 * Deletion reuses the admin cascade (`deleteSource`): the source row, its
 * allowlist entries and any `user_source_choices` rows on it go together, so no
 * orphan rows survive. Nothing here reads or echoes the source URL (write-only
 * rule): the answer is just the id/name that was removed.
 */
import { deleteOwnSource, requireEnabledUserByToken } from '../../../../utils/user-center';
import {
  handleUserRequest,
  sourceIdFromPath,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../../utils/user-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function userSourceDeleteHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const result = deleteOwnSource(db, user.id, sourceIdFromPath(event));
      return sendJson(event, 200, result);
    },
    options,
  );
}
