// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/sources/:id/refresh — refresh one source's cache right now.
 *
 * Uses the exact same fetch/parse/cache path as the scheduled task
 * (`refreshSource` in server/tasks/refresh-sources.ts); no fetching logic is
 * duplicated here.
 *
 * Responses:
 * - 200 `{ item, outcome }`: `outcome` is `refreshed` (cache replaced) or
 *   `skipped` (a `local` source, or the refresh failed — then `item.lastError`
 *   carries the reason and the previous cache is kept, as in the task).
 * - 404 for an unknown id (checked before any network access).
 * - 401 without a session (middleware + `handleAdminRequest`).
 */
import { getSource } from '../../../../utils/admin-sources';
import {
  handleAdminRequest,
  idFromPath,
  type AdminRequestOptions,
} from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';
import { refreshSource } from '../../../../tasks/refresh-sources';

export default function adminSourceRefreshHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) => {
      // Unknown id -> 404 before touching the network (getSource throws).
      const id = getSource(db, idFromPath(event, 'sources')).id;
      const result = await refreshSource(db, id);
      return sendJson(event, 200, {
        item: getSource(db, id),
        outcome: result.outcome,
        ...(result.error ? { error: result.error } : {}),
      });
    },
    options,
  );
}
