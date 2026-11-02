// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /auth/logout — end the /my session (used from the dashboard).
 *
 * Always clears the local `subhub_my` session cookie and the `subhub_oidc_idt`
 * logout cookie. When an `idt` cookie existed AND XAuth is active, the browser
 * is sent to the IdP's `end_session` endpoint with the exact
 * `id_token_hint=<idToken>` (plus `post_logout_redirect_uri=<origin>/auth/logged-out`)
 * built by openid-client's `buildEndSessionUrl`; otherwise it lands on
 * `/auth/logged-out` directly (a password session has no IdP session to end).
 *
 * A discovery failure still logs the user out locally and lands on the page —
 * an IdP outage must never trap a user inside a session they asked to end.
 */
import {
  OIDC_IDT_COOKIE,
  activeOidcConfig,
  clearIdTokenCookieHeader,
  oidcEndSessionUrl,
  readCookieHeader,
  readIdTokenCookie,
} from '../../utils/oidc';
import { clearUserSessionCookieHeader } from '../../utils/user-session';
import {
  authDb,
  authOrigin,
  logAuthFailure,
  redirectTo,
  type AuthEvent,
  type AuthRouteOptions,
} from '../../utils/auth-routes';

const LOGGED_OUT = '/auth/logged-out';

export default async function authLogoutHandler(
  event: AuthEvent,
  options: AuthRouteOptions = {},
) {
  const db = authDb(options);
  const headers = event.node.req.headers;
  const idt = readIdTokenCookie(readCookieHeader(headers.cookie, OIDC_IDT_COOKIE));
  const cookies = [clearUserSessionCookieHeader(), clearIdTokenCookieHeader()];
  const config = activeOidcConfig(db);
  if (idt && config) {
    try {
      const url = await oidcEndSessionUrl(config, idt.idToken, authOrigin(event));
      if (url) {
        redirectTo(event.node.res, url.toString(), cookies);
        return;
      }
    } catch (error) {
      logAuthFailure('logout', error);
    }
  }
  redirectTo(event.node.res, LOGGED_OUT, cookies);
}
