// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/settings — current site settings (admin).
 *
 * `{ subPath, defaultSubPath, reservedRoots, adminPath }`; `subPath` is the
 * effective subscription URL prefix every share/copy link must use.
 */
import { getAdminSettings } from '../../../utils/settings';
import { handleAdminRequest, type AdminRequestOptions } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminSettingsHandler(event: AdminApiEvent, options?: AdminRequestOptions) {
  return handleAdminRequest(event, (db) => sendJson(event, 200, getAdminSettings(db)), options);
}
