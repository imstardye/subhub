// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/users/:id/reset-token — rotate the subscription token (admin).
 *
 * The old /s/:token URL stops working immediately; the new token is returned in
 * the response body.
 */
import { resetUserToken } from '../../../../utils/admin-users';
import {
  handleAdminRequest,
  idFromPath,
  type AdminRequestOptions,
} from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function adminUserResetTokenHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, { item: resetUserToken(db, idFromPath(event, 'users')) }),
    options,
  );
}
