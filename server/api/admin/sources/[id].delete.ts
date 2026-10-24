// SPDX-License-Identifier: AGPL-3.0-only
/** DELETE /api/admin/sources/:id — delete a source and its user links (admin). */
import { deleteSource } from '../../../utils/admin-sources';
import { handleAdminRequest, idFromPath, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminSourceDeleteHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, deleteSource(db, idFromPath(event, 'sources'))),
    options,
  );
}
