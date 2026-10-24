// SPDX-License-Identifier: AGPL-3.0-only
/** DELETE /api/admin/users/:id — delete a user and its source links (admin). */
import { deleteUser } from '../../../utils/admin-users';
import { handleAdminRequest, idFromPath, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminUserDeleteHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, deleteUser(db, idFromPath(event, 'users'))),
    options,
  );
}
