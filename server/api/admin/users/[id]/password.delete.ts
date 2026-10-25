// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DELETE /api/admin/users/:id/password — reset a user's /my password.
 *
 * Clears `password_hash` and bumps the password version. The next /my visit
 * shows the 设置密码 form again; all existing sessions are invalid. The
 * administrator does not choose a temporary password.
 */
import { resetUserPassword } from '../../../../utils/admin-users';
import {
  handleAdminRequest,
  idFromPath,
  type AdminRequestOptions,
} from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function adminUserPasswordResetHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, { item: resetUserPassword(db, idFromPath(event, 'users')) }),
    options,
  );
}
