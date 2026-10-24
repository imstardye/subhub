// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Decision logic for the global admin gate (`middleware/admin.global.ts`).
 *
 * The middleware itself is a thin wrapper around Nuxt's router, `useRequestFetch`
 * and `navigateTo`; the decision is kept here as a pure function so it can be
 * unit-tested without a Nuxt runtime.
 *
 * `/login` is the only public page and is let through immediately (the server
 * is not even asked). Everything else requires a session: an anonymous visitor
 * is sent to `/login?redirect=<full path>`.
 */

/** The only page reachable without a session. */
export const ADMIN_LOGIN_PATH = '/login';

/** The bits of the router's `to` the gate actually uses. */
export interface AdminGateRoute {
  path: string;
  fullPath: string;
}

/** What the gate wants the router to do. */
export type AdminGateResult =
  | { action: 'allow' }
  | { action: 'navigate'; to: { path: string; query: { redirect: string } } };

/**
 * Decide whether `to` may render. `state` is the answer of `/api/admin/me`;
 * `null`/`undefined` (e.g. the request failed) counts as unauthenticated.
 */
export function resolveAdminGate(
  to: AdminGateRoute,
  state: { authenticated: boolean } | null | undefined,
): AdminGateResult {
  if (to.path === ADMIN_LOGIN_PATH) return { action: 'allow' };
  if (state?.authenticated) return { action: 'allow' };
  return {
    action: 'navigate',
    to: { path: ADMIN_LOGIN_PATH, query: { redirect: to.fullPath } },
  };
}
