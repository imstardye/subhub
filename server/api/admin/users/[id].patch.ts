// SPDX-License-Identifier: AGPL-3.0-only
/** PATCH /api/admin/users/:id — update name/enabled/note/profileId (admin). */
import { updateUser } from '../../../utils/admin-users';
import {
  handleAdminRequest,
  idFromPath,
  parseBody,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminUserUpdateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) =>
      sendJson(event, 200, { item: updateUser(db, idFromPath(event, 'users'), await parseBody(event)) }),
    options,
  );
}
