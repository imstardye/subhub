// SPDX-License-Identifier: AGPL-3.0-only
/** GET /api/admin/users/:id — one user (admin). */
import { getUser } from '../../../utils/admin-users';
import { handleAdminRequest, idFromPath, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminUserGetHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, { item: getUser(db, idFromPath(event, 'users')) }),
    options,
  );
}
