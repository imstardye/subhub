// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PATCH /api/admin/sources/:id — update a source (admin).
 *
 * Omitting `url` keeps the stored (encrypted) URL; sending one replaces it
 * after validation. The response carries the masked URL only.
 */
import { updateSource } from '../../../utils/admin-sources';
import {
  handleAdminRequest,
  idFromPath,
  parseBody,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminSourceUpdateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) =>
      sendJson(event, 200, {
        item: updateSource(db, idFromPath(event, 'sources'), parseBody(event)),
      }),
    options,
  );
}
