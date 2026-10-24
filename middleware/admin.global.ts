// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Global admin gate for the management UI (P3).
 *
 * Runs on every page navigation instead of being opted into per page, so a new
 * business page is protected by default and cannot be left unguarded by a
 * forgotten `definePageMeta`. `/login` is the only public page and is let
 * through immediately; everything else requires a session.
 *
 * The session cookie is httpOnly, so it cannot be inspected from the browser.
 * The middleware asks `/api/admin/me` on the server (SSR, forwarded cookies) or
 * client-side navigation, then redirects to /login when the visitor is not
 * authenticated. An already-authenticated visitor reaching /login is sent on
 * by login.vue itself, which keeps the `redirect` query handling there.
 *
 * The decision itself lives in `core/utils/admin-gate.ts` (`resolveAdminGate`)
 * so it can be tested without a Nuxt runtime; this file only wires it up.
 */
import { ADMIN_LOGIN_PATH, resolveAdminGate } from '../core/utils/admin-gate';

export default defineNuxtRouteMiddleware(async (to) => {
  // Public page first: never even ask the server about /login.
  if (to.path === ADMIN_LOGIN_PATH) return;

  const requestFetch = useRequestFetch();
  const state = await requestFetch<{ authenticated: boolean }>('/api/admin/me').catch(
    () => ({ authenticated: false }),
  );

  const decision = resolveAdminGate(to, state);
  if (decision.action === 'navigate') return navigateTo(decision.to);
});
