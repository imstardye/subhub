// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/sources — create a source (admin).
 *
 * Body: `{ name, url, type?, ua?, refreshMinutes? }`. `url` must be an absolute
 * http/https URL; it is encrypted before storage and only its masked form is
 * returned.
 */
import { createSource } from '../../../utils/admin-sources';
import {
  handleAdminRequest,
  parseBody,
  sendCreated,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import type { AdminApiEvent } from '../../../utils/admin-api';

export default function adminSourcesCreateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    async (db) => sendCreated(event, createSource(db, await parseBody(event))),
    options,
  );
}
