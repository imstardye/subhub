// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin session gate for `/api/admin/**` (P3).
 *
 * Every admin API route except the public login is protected here instead of
 * repeating `requireAdmin` in each handler. Logout stays reachable without a
 * session (it is idempotent and only clears the cookie), so a stale tab can
 * always clean up.
 *
 * Runs on Nitro's raw node request/response (a connect-style middleware
 * function, which Nitro accepts directly), so it needs no auto-imports and is
 * unit-testable with fake events. The check itself is `isAdmin` from
 * server/utils/admin-auth.ts (signature + expiry + revocation).
 */
import { isAdmin } from '../utils/admin-auth';

/** Login is the only anonymous admin API; logout is safe to call anonymously. */
export const PUBLIC_ADMIN_PATHS = ['/api/admin/login', '/api/admin/logout'] as const;

/** True for paths this middleware treats as public (login/logout). */
export function isPublicAdminApiPath(path: string): boolean {
  const clean = (path.split('?')[0] ?? '').toLowerCase();
  const withoutSlash = clean.endsWith('/') ? clean.slice(0, -1) : clean;
  return (PUBLIC_ADMIN_PATHS as readonly string[]).includes(withoutSlash);
}

/** Minimal node middleware signature (compatible with connect/Nitro). */
export type NodeMiddleware = (
  req: { headers: Record<string, string | string[] | undefined> },
  res: {
    statusCode: number;
    setHeader(name: string, value: string): unknown;
    end(body?: string): unknown;
  },
  next: (error?: unknown) => void,
) => void;

/**
 * Reject anonymous admin API requests with a JSON 401; pass everything else
 * (and the two public paths) through to the route handler.
 */
export function adminApiAuth(req: Parameters<NodeMiddleware>[0], res: Parameters<NodeMiddleware>[1]): boolean {
  if (isAdmin({ node: { req, res } })) return true;
  res.statusCode = 401;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

const middleware: NodeMiddleware = (req, res, next) => {
  const url = (req as { originalUrl?: string; url?: string }).originalUrl
    ?? (req as { url?: string }).url
    ?? '';
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith('/api/admin')) {
    next();
    return;
  }
  if (isPublicAdminApiPath(path) || adminApiAuth(req, res)) {
    next();
  }
};

/** Nitro server middleware; Nuxt mounts it for every request. */
export default middleware;
