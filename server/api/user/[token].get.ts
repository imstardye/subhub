// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/user/:token — the token owner's own data (user center).
 *
 * The token *is* the credential: unknown/empty token -> 404 with no detail, a
 * disabled user -> the minimal `{ user: { enabled: false } }` payload. Nothing
 * here is gated by the admin entrance (`gateScope` keeps `/api/user/*` public).
 *
 * The payload never contains a source URL (write-only rule), only the names of
 * public/shared sources (`availableSources`), and traffic for the user's own
 * DEDICATED sources. `origin` is the request origin, used for link building.
 */
import { loadUserCenterData } from '../../utils/user-center';
import { handleUserRequest, tokenFromPath, type UserRequestOptions } from '../../utils/user-routes';
import { sendJson, type AdminApiEvent } from '../../utils/admin-api';

/** Origin (`https://host[:port]`) from the request headers; '' when unknown. */
export function originFromEvent(event: AdminApiEvent): string {
  const headers = event.node.req.headers;
  const proto = (headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http';
  const host = (headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim()
    || (headers.host as string | undefined)
    || '';
  return host ? `${proto}://${host}` : '';
}

export default function userCenterReadHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    (db) => {
      const data = loadUserCenterData(db, tokenFromPath(event), { origin: originFromEvent(event) });
      // A disabled user gets 200 with the minimal `{ user: { enabled: false } }`
      // payload (the page explains it); nothing else is serialised.
      return sendJson(event, 200, data);
    },
    options,
  );
}
