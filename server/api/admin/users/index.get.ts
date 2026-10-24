// SPDX-License-Identifier: AGPL-3.0-only
/** GET /api/admin/users — list users (admin). */
import { listUsers } from '../../../utils/admin-users';
import { handleAdminRequest, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminUsersListHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(event, (db) => sendJson(event, 200, { items: listUsers(db) }), options);
}
