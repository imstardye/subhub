// SPDX-License-Identifier: AGPL-3.0-only
/** GET /api/admin/profiles/:id — one rule profile with all fields (admin). */
import { getProfile } from '../../../utils/admin-profiles';
import { handleAdminRequest, idFromPath, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminProfileGetHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, { item: getProfile(db, idFromPath(event, 'profiles')) }),
    options,
  );
}
