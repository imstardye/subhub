// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/sources — add a DEDICATED source for the token owner.
 *
 * Body: `{ name, url, userAgent? }` (legacy spelling `ua` is accepted too).
 * The owner, the ownership mode and the type (`remote`) are forced server-side;
 * a client cannot create a public/shared source through this endpoint.
 *
 * The source's cache is filled by one immediate refresh (same code path as the
 * admin refresh button), so the new card has data right away; if that fetch
 * fails the source still exists and its health reports the failure.
 *
 * The URL is **write-only**: it is validated, stored encrypted, and never
 * serialised back (see `user-center.ts`).
 */
import {
  addOwnSource,
  requireEnabledUserByToken,
} from '../../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../../utils/user-routes';
import { parseBody } from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function userSourceCreateHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      // Only the user-facing fields are forwarded; `addOwnSource` also ignores
      // everything else (owner/mode/allowlist/type are forced server-side).
      const { source, refresh } = await addOwnSource(db, user.id, {
        name: body.name,
        url: body.url,
        userAgent: body.userAgent,
        ua: body.ua,
      });
      return sendJson(event, 201, { item: source, refresh });
    },
    options,
  );
}
