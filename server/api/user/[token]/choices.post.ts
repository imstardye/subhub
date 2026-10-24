// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/choices — include/exclude a PUBLIC or SHARED source.
 *
 * Body: `{ sourceId, included }`. The id must be in the user's available set
 * (every public source + every shared source they are allowlisted for); a
 * dedicated source, another user's source or an unknown id is a 404.
 *
 * The choice (`user_source_choices`) only affects this user's exports and
 * previews; without a row the source is included, so users who never choose see
 * exactly what they saw before.
 */
import {
  requireEnabledUserByToken,
  setSourceInclusion,
} from '../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userChoiceHandler(event: AdminApiEvent, options?: UserRequestOptions) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      const item = setSourceInclusion(db, user.id, body.sourceId, body.included);
      return sendJson(event, 200, { item });
    },
    options,
  );
}
