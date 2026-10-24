// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/profiles — create a rule profile (admin).
 *
 * Body: `{ name, iniUrl?, iniText?, variant?, dnsTemplate?, options? }`.
 * At least one of `iniUrl`/`iniText` is required; `iniUrl` must be http(s);
 * `variant` is `mihomo` (default) or `legacy`; `options` is a JSON object.
 */
import { createProfile } from '../../../utils/admin-profiles';
import {
  handleAdminRequest,
  parseBody,
  sendCreated,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import type { AdminApiEvent } from '../../../utils/admin-api';

export default function adminProfilesCreateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendCreated(event, createProfile(db, parseBody(event))),
    options,
  );
}
