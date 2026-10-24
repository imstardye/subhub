// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PATCH /api/admin/profiles/:id — update a rule profile (admin).
 *
 * Only the supplied fields change; `null`/`''` clears an optional field. The
 * merged profile must keep at least one of `iniUrl`/`iniText`.
 */
import { updateProfile } from '../../../utils/admin-profiles';
import {
  handleAdminRequest,
  idFromPath,
  parseBody,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminProfileUpdateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) =>
      sendJson(event, 200, {
        item: updateProfile(db, idFromPath(event, 'profiles'), await parseBody(event)),
      }),
    options,
  );
}
