// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/logs — paged subscription access log (admin).
 *
 * Query: `limit` (default 50, max 200), `offset` (default 0), optional
 * `userId` and `status`. Responses are newest first and include the user name
 * (null once the user has been deleted).
 */
import { listAccessLogs } from '../../../utils/admin-logs';
import { handleAdminRequest, type AdminRequestOptions } from '../../../utils/admin-routes';
import { requestQuery, sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminLogsListHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => {
      const { limit, offset, userId, status } = requestQuery(event);
      return sendJson(event, 200, listAccessLogs(db, { limit, offset, userId, status }));
    },
    options,
  );
}
