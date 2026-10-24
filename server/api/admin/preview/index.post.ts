// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/preview — render a user's subscription without touching the
 * public path.
 *
 * Body: `{ userId, target? }`; `target` must be one of `EXPORT_TARGETS`
 * (default `mihomo`). Missing user -> 404, unknown target -> 400. Disabled users
 * are still previewable (admin debugging) and the response carries `enabled`.
 * No rate limit, no access log, body capped at ~200 KiB (`truncated: true`).
 */
import { previewSubscription } from '../../../utils/admin-preview';
import {
  handleAdminRequest,
  parseBody,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminPreviewHandler(event: AdminApiEvent, options?: AdminRequestOptions) {
  return handleAdminRequest(
    event,
    async (db) => sendJson(event, 200, previewSubscription(db, await parseBody(event))),
    options,
  );
}
