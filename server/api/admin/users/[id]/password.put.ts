// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/admin/users/:id/password — set a /my password for a user (admin).
 *
 * Body: `{ password }` (6–64 chars, same policy as the user center). Stored as
 * a salted scrypt hash; the response's `AdminUser` only carries
 * `passwordSet: true`, never the hash or the plaintext. The password version is
 * bumped, so all of that user's existing /my sessions are invalidated.
 */
import { setUserPassword } from '../../../../utils/admin-users';
import {
  handleAdminRequest,
  idFromPath,
  parseBody,
  type AdminRequestOptions,
} from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function adminUserPasswordSetHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) =>
      sendJson(event, 200, {
        item: setUserPassword(db, idFromPath(event, 'users'), (await parseBody(event)).password),
      }),
    options,
  );
}
