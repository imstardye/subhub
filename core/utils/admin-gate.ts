// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Decision logic for the global admin gate (`middleware/admin.global.ts`).
 *
 * The middleware itself is a thin wrapper around Nuxt's router, `useRequestFetch`
 * and `navigateTo`; the decision is kept here as a pure function so it can be
 * unit-tested without a Nuxt runtime.
 *
 * `/login` is the only admin page and is let through immediately (the server is
 * not even asked). The self-service user center (`/my/<token>`, see
 * `USER_CENTER_PAGES`) is public by design — the token in the URL is the
 * credential — so it must not be redirected to the login page either.
 * Everything else requires a session: an anonymous visitor is sent to
 * `/login?redirect=<full path>`.
 */
import { USER_CENTER_PAGES } from './admin-entrance';

/** The only admin page reachable without a session. */
export const ADMIN_LOGIN_PATH = '/login';

/** True for `/login` and for every public user-center page (`/my/*`). */
export function isPublicPage(path: string): boolean {
  if (path === ADMIN_LOGIN_PATH) return true;
  const first = path.split('/').filter((segment) => segment.length > 0)[0] ?? '';
  return (USER_CENTER_PAGES as readonly string[]).includes(`/${first}`);
}

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
  if (isPublicPage(to.path)) return { action: 'allow' };
  if (state?.authenticated) return { action: 'allow' };
  return {
    action: 'navigate',
    to: { path: ADMIN_LOGIN_PATH, query: { redirect: to.fullPath } },
  };
}
