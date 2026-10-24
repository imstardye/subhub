// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin gate for the management UI (P3 skeleton).
 *
 * The session cookie is httpOnly, so it cannot be inspected from the browser.
 * The middleware asks `/api/admin/me` on the server (SSR, forwarded cookies) or
 * client-side navigation, then redirects to /login when the visitor is not
 * authenticated. /login itself stays public.
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
