// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/users — create a user (admin).
 *
 * Body: `{ name, enabled?, note?, profileId? }`. The subscription token is
 * generated server-side and returned once in the 201 body.
 */
import { createUser } from '../../../utils/admin-users';
import {
  handleAdminRequest,
  parseBody,
  sendCreated,
  type AdminRequestOptions,
} from '../../../utils/admin-routes';
import type { AdminApiEvent } from '../../../utils/admin-api';

export default function adminUsersCreateHandler(
  event: AdminApiEvent,
  options?: AdminRequestOptions,
) {
  return handleAdminRequest(
    event,
    (db) => sendCreated(event, createUser(db, parseBody(event))),
    options,
  );
}
