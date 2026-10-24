// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin session gate for `/api/admin/**` (P3).
 *
 * Every admin API route except the public login is protected here instead of
 * repeating `requireAdmin` in each handler. Logout stays reachable without a
 * session (it is idempotent and only clears the cookie), so a stale tab can
 * always clean up.
 *
 * Nitro registers `server/middleware/*` as **event handlers**, not as
 * connect middleware: it calls `handler(event)` and never passes `next`. A
 * `(req, res, next)` connect-style default export therefore threw
 * `TypeError: next is not a function` on every request (500 for the whole
 * site, login included). The default export is now a proper h3 handler:
 * returning normally continues to the route, while answering the request
 * directly (401) stops it — the h3 way of "not calling next()".
 *
 * The check itself is `isAdmin` from server/utils/admin-auth.ts (signature +
 * expiry + revocation).
 *
 * Like the other server modules here, h3/Nitro auto-imports are avoided: the
 * exported handler is a plain `(event) => void` function, which is exactly the
 * event-handler contract Nitro calls. That keeps the module unit-testable with
 * fake events, with no Nitro runtime and no generated types.
 */
import { isAdmin } from '../utils/admin-auth';

/** Minimal view of the raw node objects an h3 event exposes via `node`. */
interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  originalUrl?: string;
}

interface MinimalResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/** Node-side event shape used by the helpers below. */
export interface AdminAuthEvent {
  node: { req: MinimalRequest; res: MinimalResponse };
  /** h3 pre-parsed path (authoritative when present). */
  path?: string;
  _path?: string;
}

/** Login is the only anonymous admin API; logout is safe to call anonymously. */
export const PUBLIC_ADMIN_PATHS = ['/api/admin/login', '/api/admin/logout'] as const;

/** True for paths this middleware treats as public (login/logout). */
export function isPublicAdminApiPath(path: string): boolean {
  const clean = (path.split('?')[0] ?? '').toLowerCase();
  const withoutSlash = clean.endsWith('/') ? clean.slice(0, -1) : clean;
  return (PUBLIC_ADMIN_PATHS as readonly string[]).includes(withoutSlash);
}

/** Request path without the query string (h3 path first, then the URL). */
export function adminAuthRequestPath(event: AdminAuthEvent): string {
  const primary = event.path ?? event._path;
  if (primary) return (primary.split('?')[0] ?? '').toLowerCase();
  const url = event.node.req.originalUrl ?? event.node.req.url ?? '';
  return (url.split('?')[0] ?? '').toLowerCase();
}

/**
 * Reject an anonymous admin API request with a JSON 401. Returns `true` when
 * the request may continue. Also usable from route handlers / tests that hold
 * the raw node request and response.
 */
export function adminApiAuth(req: MinimalRequest, res: MinimalResponse): boolean {
  if (isAdmin({ node: { req, res } })) return true;
  res.statusCode = 401;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

/**
 * Gate decision for an event, used by the Nitro handler. Returns `true` when
 * the request must be stopped (the 401 has already been written).
 */
export function handleAdminAuth(event: AdminAuthEvent): boolean {
  const path = adminAuthRequestPath(event);
  if (!path.startsWith('/api/admin')) return false;
  if (isPublicAdminApiPath(path)) return false;
  return !adminApiAuth(event.node.req, event.node.res);
}

/**
 * Nitro server middleware; Nuxt mounts it for every request. An event handler
 * (not connect middleware): return to continue, respond to stop. Deliberately
 * a plain function — Nitro treats any default export here as `(event) => ...`.
 */
export default function adminAuthMiddleware(event: AdminAuthEvent): void {
  handleAdminAuth(event);
}
