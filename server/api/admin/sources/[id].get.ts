// SPDX-License-Identifier: AGPL-3.0-only
/** GET /api/admin/sources/:id — one source, URL masked (admin). */
import { getSource } from '../../../utils/admin-sources';
import { handleAdminRequest, idFromPath, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminSourceGetHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, { item: getSource(db, idFromPath(event, 'sources')) }),
    options,
  );
}
