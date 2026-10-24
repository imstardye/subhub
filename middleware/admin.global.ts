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
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return;

  const requestFetch = useRequestFetch();
  const state = await requestFetch<{ authenticated: boolean }>('/api/admin/me').catch(
    () => ({ authenticated: false }),
  );

  if (!state.authenticated) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } });
  }
});
