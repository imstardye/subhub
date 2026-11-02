// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /auth/callback — finish the XAuth (OIDC) flow and mint the /my session.
 *
 * Failures never render provider data: every one of them 302s to
 * `/auth/error?code=<whitelisted code>` (unbound, conflict, state, expired,
 * provider, disabled) and the flow cookie is cleared.
 *
 * Success mints the EXISTING `subhub_my` session cookie through
 * `userCenterSessionFor` — the identical payload/version binding a password
 * unlock mints, so `handleUserRequest` accepts it unchanged — plus the
 * encrypted `subhub_oidc_idt` cookie `{userId, idToken}` that `/auth/logout`
 * later sends to the IdP's `end_session`. The browser then lands on
 * `/my/<user.token>`.
 *
 * Resolution is `resolveOidcLogin` (`core/oidc.ts`): match by `sub`; else a
 * VERIFIED, pre-filled email claims the binding; anything else is rejected —
 * identities are never auto-provisioned.
 */
import {
  OIDC_FLOW_COOKIE,
  OIDC_IDT_COOKIE,
  clearFlowCookieHeader,
  completeOidcLogin,
  idTokenCookieHeader,
  readCookieHeader,
  readFlowCookie,
  resolveOidcLogin,
  type OidcErrorCode,
} from '../../utils/oidc';
import { activeOidcConfig } from '../../utils/oidc';
import { userCenterSessionFor } from '../../utils/user-center';
import { xauthReturnPath } from '../../../core/oidc';
import {
  authDb,
  authOrigin,
  authRequestUrl,
  logAuthFailure,
  oidcInactive,
  redirectTo,
  type AuthEvent,
  type AuthRouteOptions,
} from '../../utils/auth-routes';

function errorCode(code: OidcErrorCode): string {
  return `/auth/error?code=${code}`;
}

export default async function authCallbackHandler(
  event: AuthEvent,
  options: AuthRouteOptions = {},
) {
  const db = authDb(options);
  const config = activeOidcConfig(db);
  if (!config) {
    oidcInactive(event);
    return;
  }
  const headers = event.node.req.headers;
  const clearFlow = clearFlowCookieHeader();
  const flow = readFlowCookie(readCookieHeader(headers.cookie ?? headers.Cookie, OIDC_FLOW_COOKIE));
  if (!flow) {
    redirectTo(event.node.res, errorCode('state'), [clearFlow]);
    return;
  }
  let result;
  try {
    // Absolute, because openid-client builds its own URLs from it; the path +
    // query come from the raw request (see `authRequestUrl`).
    result = await completeOidcLogin(config, new URL(authRequestUrl(event), authOrigin(event) || 'http://localhost'), flow);
  } catch (error) {
    // A tampered state, a provider error response (or a failed ID-token /
    // JWKS verification) all end the same way; the raw error never reaches
    // the browser. `expired` is answered by `readFlowCookie` above.
    logAuthFailure('callback', error);
    redirectTo(event.node.res, errorCode('state'), [clearFlow]);
    return;
  }

  const outcome = resolveOidcLogin(db, result.claims);
  if (outcome.resolution.kind === 'error') {
    const code: OidcErrorCode = outcome.disabled ? 'disabled' : outcome.resolution.code;
    redirectTo(event.node.res, errorCode(code), [clearFlow]);
    return;
  }
  const user = outcome.user;
  if (!user) {
    redirectTo(event.node.res, errorCode('unbound'), [clearFlow]);
    return;
  }
  if (!user.enabled) {
    redirectTo(event.node.res, errorCode('disabled'), [clearFlow]);
    return;
  }

  let session;
  try {
    session = userCenterSessionFor(user);
  } catch (error) {
    // Production without SUBHUB_SECRET: nothing can be signed (fail closed).
    logAuthFailure('callback', error);
    redirectTo(event.node.res, errorCode('provider'), [clearFlow]);
    return;
  }
  const idCookie = idTokenCookieHeader({ userId: user.id, idToken: result.idToken });
  redirectTo(event.node.res, xauthReturnPath(user.token), [session.cookie, idCookie, clearFlow]);
}
