// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/user/:token/source-order — save the owner's subscription source
 * order.
 *
 * Body: `{ sourceIds: number[] }`. Every id must be visible to the user (own
 * dedicated, public, or shared with an allowlist), regardless of whether it is
 * paused or currently excluded; otherwise 400. Dedupe keeps the first
 * occurrence and an empty array clears the preference (default order). Behind
 * the /my password gate like every other user-side write.
 */
import { requireEnabledUserByToken } from '../../../utils/user-center';
import { saveUserSourceOrder } from '../../../utils/source-order';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userSourceOrderHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      const sourceIds = saveUserSourceOrder(db, user.id, body.sourceIds);
      return sendJson(event, 200, { sourceIds });
    },
    options,
  );
}
