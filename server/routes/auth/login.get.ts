// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /auth/login — start the XAuth (OIDC) authorization code flow.
 *
 * Browser route (302), not JSON. OIDC inactive → 404 (the site behaves exactly
 * as if XAuth did not exist). Otherwise:
 * 1. discover the issuer (cached per settings fingerprint);
 * 2. mint fresh `state`, `nonce` and a PKCE verifier per attempt;
 * 3. put `{state, nonce, verifier, createdAt}` into the encrypted, signed,
 *    HttpOnly, SameSite=Lax `subhub_oidc` cookie (10 minutes);
 * 4. 302 to the authorization URL — `response_type=code`, the configured
 *    scope (default `openid profile email`, never `offline_access`), the S256
 *    `code_challenge`, and `redirect_uri = <request origin>/auth/callback`.
 *
 * `/auth/*` is gate-exempt (core/utils/admin-entrance.ts `gateScope`), so no
 * admin knock cookie is needed.
 */
import { activeOidcConfig, beginOidcLogin } from '../../utils/oidc';
import { oidcRedirectUri } from '../../../core/oidc';
import {
  authDb,
  authOrigin,
  logAuthFailure,
  oidcInactive,
  redirectTo,
  type AuthEvent,
  type AuthRouteOptions,
} from '../../utils/auth-routes';
import type { ActiveOidcConfig } from '../../utils/oidc';

/** `/auth/error?code=provider` for a discovery/URL-building failure. */
const PROVIDER_ERROR = '/auth/error?code=provider';

/**
 * Build the authorization redirect for an already-resolved client config (the
 * default export resolves it). Exported so the route can be driven directly.
 */
export async function handleAuthLogin(
  event: AuthEvent,
  config: ActiveOidcConfig,
): Promise<void> {
  try {
    const origin = authOrigin(event);
    const { url, cookie } = await beginOidcLogin(config, oidcRedirectUri(origin));
    redirectTo(event.node.res, url.toString(), [cookie]);
  } catch (error) {
    logAuthFailure('login', error);
    redirectTo(event.node.res, PROVIDER_ERROR);
  }
}

export default async function authLoginHandler(
  event: AuthEvent,
  options: AuthRouteOptions = {},
) {
  const config = activeOidcConfig(authDb(options));
  if (!config) {
    oidcInactive(event);
    return;
  }
  await handleAuthLogin(event, config);
}
