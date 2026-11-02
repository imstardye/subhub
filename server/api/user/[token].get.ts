// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/user/:token — the token owner's own data (user center).
 *
 * The token *is* the credential: unknown/empty token -> 404 with no detail, a
 * disabled user -> the minimal `{ user: { enabled: false } }` payload. Nothing
 * here is gated by the admin entrance (`gateScope` keeps `/api/user/*` public).
 *
 * `user.sessionOidc` says whether this session came from XAuth (the encrypted
 * `subhub_oidc_idt` cookie matches the signed session), so the logout button
 * can end the SSO session; the token/sub themselves are never serialised.
 *
 * The payload never contains a source URL (write-only rule), only the names of
 * public/shared sources (`availableSources`), and traffic for the user's own
 * DEDICATED sources. `origin` is the request origin, used for link building.
 */
import { loadUserCenterData } from '../../utils/user-center';
import { isOidcSession } from '../../utils/oidc';
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
      const data = loadUserCenterData(db, tokenFromPath(event), {
        origin: originFromEvent(event),
        // Lets the page label the logout button 退出 XAuth 登录 vs 退出登录.
        sessionOidc: isOidcSession(event.node.req.headers, { session: options?.session }),
      });
      // A disabled user gets 200 with the minimal `{ user: { enabled: false } }`
      // payload (the page explains it); nothing else is serialised.
      return sendJson(event, 200, data);
    },
    options,
  );
}
