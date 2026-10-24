// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/profiles — list rule profiles (admin).
 *
 * INIs are not secrets, so every field is returned in full for the edit form.
 */
import { listProfiles } from '../../../utils/admin-profiles';
import { handleAdminRequest, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminProfilesListHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, { items: listProfiles(db) }),
    options,
  );
}
