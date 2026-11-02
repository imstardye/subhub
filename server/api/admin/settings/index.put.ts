// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/admin/settings — update site settings (admin).
 *
 * Body: `{ subPath?: string, oidc?: { enabled, issuer, clientId, clientSecret,
 * clearClientSecret, scopes } }`. The prefix is validated/normalised by
 * `setSubPath` (`server/utils/settings.ts`): an invalid value answers 400 with
 * a Chinese message and the stored prefix is left untouched. On success the
 * new prefix is persisted, the middleware cache is invalidated (effective
 * immediately, no restart) and the full settings object is returned.
 *
 * Changing the prefix invalidates every previously shared subscription link —
 * the admin UI warns about that before saving.
 */
import {
  getAdminSettings,
  invalidateSubPathCache,
  setOidcSettings,
  setSubPath,
  type OidcPatch,
} from '../../../utils/settings';
import {
  handleAdminRequest,
  parseBody,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';
import { ValidationError } from '../../../utils/admin-validation';

export default function adminSettingsUpdateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) => {
      const body = await parseBody(event);
      // Both sections are optional (absent = untouched), so 订阅链接 and XAuth
      // can be saved from separate forms.
      if (body.subPath !== undefined) {
        setSubPath(db, body.subPath);
        invalidateSubPathCache();
      }
      // XAuth (OIDC): the five `oidc_*` settings keys; the secret is write-only
      // (blank = keep, `clearClientSecret` removes it) — see setOidcSettings.
      if (body.oidc !== undefined) {
        if (!body.oidc || typeof body.oidc !== 'object' || Array.isArray(body.oidc)) {
          throw new ValidationError('oidc 必须是对象');
        }
        setOidcSettings(db, body.oidc as OidcPatch);
      }
      return sendJson(event, 200, getAdminSettings(db));
    },
    options,
  );
}
