// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/admin/settings — update site settings (admin).
 *
 * Body: `{ subPath: string }`. The prefix is validated/normalised by
 * `setSubPath` (`server/utils/settings.ts`): an invalid value answers 400 with
 * a Chinese message and the stored prefix is left untouched. On success the
 * new prefix is persisted, the middleware cache is invalidated (effective
 * immediately, no restart) and the full settings object is returned.
 *
 * Changing the prefix invalidates every previously shared subscription link —
 * the admin UI warns about that before saving.
 */
import { getAdminSettings, invalidateSubPathCache, setSubPath } from '../../../utils/settings';
import {
  handleAdminRequest,
  parseBody,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function adminSettingsUpdateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) => {
      const body = await parseBody(event);
      setSubPath(db, body.subPath);
      invalidateSubPathCache();
      return sendJson(event, 200, getAdminSettings(db));
    },
    options,
  );
}
