// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/stats — dashboard counters (admin).
 *
 * `{ users, sources, profiles, accessLogs24h }`; the last one counts access
 * log rows from the past 24 hours (rolling window).
 */
import { getAdminStats } from '../../../utils/admin-stats';
import { handleAdminRequest, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminStatsHandler(event: AdminApiEvent, options?: AdminRequestOptions) {
  return handleAdminRequest(event, (db) => sendJson(event, 200, getAdminStats(db)), options);
}
