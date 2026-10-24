// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/stats — dashboard counters (admin).
 *
 * `{ users, sources, profiles, accessLogs24h }`; the last one counts access
 * log rows from the past 24 hours (rolling window).
 *
 * Also carries the runtime site settings the dashboard needs to build
 * subscription links — currently `{ subPath }`, the effective URL prefix
 * (`/dl/<token>`). It rides on this payload because the dashboard already
 * fetches it, so the link builder never shows a stale hard-coded `/s/`.
 */
import { getAdminStats } from '../../../utils/admin-stats';
import { getRuntimeSettings } from '../../../utils/settings';
import { handleAdminRequest, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminStatsHandler(event: AdminApiEvent, options?: AdminRequestOptions) {
  return handleAdminRequest(
    event,
    (db) => sendJson(event, 200, { ...getAdminStats(db), settings: getRuntimeSettings(db) }),
    options,
  );
}
