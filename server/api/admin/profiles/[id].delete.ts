// SPDX-License-Identifier: AGPL-3.0-only
/** DELETE /api/admin/profiles/:id — delete a rule profile (admin). */
import { deleteProfile } from '../../../utils/admin-profiles';
import { handleAdminRequest, idFromPath, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminProfileDeleteHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, deleteProfile(db, idFromPath(event, 'profiles'))),
    options,
  );
}
