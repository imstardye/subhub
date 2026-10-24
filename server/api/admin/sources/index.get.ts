// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/sources — list sources (admin).
 *
 * URLs are masked server-side (`urlMasked`); plaintext is never returned.
 */
import { listSources } from '../../../utils/admin-sources';
import { handleAdminRequest, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminSourcesListHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(event, (db) => sendJson(event, 200, { items: listSources(db) }), options);
}
