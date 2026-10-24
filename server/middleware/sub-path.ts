// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription prefix rewrite (server middleware, runs before routing).
 *
 * The Nitro file routes under `server/routes/s/` stay the single
 * implementation. Every subscription link lives under the *effective* prefix
 * (`sub_path` site setting, default `s`); this middleware maps
 * `/<prefix>/…` onto the implementation before Nitro resolves the route:
 *
 * - prefix = `s` (default): nothing is rewritten, `/s/…` works exactly as
 *   before — zero behaviour change on a default install;
 * - prefix = `dl`: `/dl/<token>/clash` is handed to the `/s/` routes (path
 *   rewritten in place, query preserved), and `/s/…` itself is answered with
 *   404 — exports are served *only* under the effective prefix, so the
 *   well-known `/s/` path cannot be used to fingerprint the service;
 * - multi-segment prefixes (`x/y`) match on whole segments, never on string
 *   prefixes (`/x/y2/...` is not touched).
 *
 * Non-subscription paths are never touched: `/api/...`, `/login`, static assets
 * and page routes keep working, and the admin-gate middleware
 * (`server/middleware/admin-auth.ts`, a no-op outside `/api/admin`) is
 * unaffected — subscription paths are never gate-blanked. Note that
 * `/api` and `_nuxt` are reserved roots, so a prefix can never shadow them.
 *
 * The decision is a pure function (`decideSubscriptionRewrite`) so the tests
 * exercise exactly the middleware's behaviour; the default export is the thin
 * Nitro event handler.
 */
import { cachedSubPath, DEFAULT_SUB_PATH } from '../utils/settings';
import { getServerDb } from '../utils/db';

/** Root the file routes live under (see `server/routes/s/`). */
export const IMPLEMENTATION_ROOT = 's';

/** Type of a rewrite decision. */
export type SubscriptionRewrite =
  /** Path needs no change; continue to routing. */
  | { action: 'continue' }
  /** Serve the subscription implementation at `implementationPath`. */
  | { action: 'rewrite'; implementationPath: string }
  /** Answer 404 (the old/plain `/s/` path when a custom prefix is active). */
  | { action: 'not-found' };

function isSubscriptionPath(path: string, root: string): boolean {
  return path === `/${root}` || path.startsWith(`/${root}/`);
}

/**
 * Decide what the middleware does for a request path.
 *
 * `path` must already be free of the query string. The prefix is expected in
 * its normalised form (`x/y`, no slashes at either end).
 */
export function decideSubscriptionRewrite(path: string, prefix: string): SubscriptionRewrite {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const effective = prefix || DEFAULT_SUB_PATH;
  if (effective === DEFAULT_SUB_PATH) return { action: 'continue' };
  if (isSubscriptionPath(clean, effective)) {
    return {
      action: 'rewrite',
      implementationPath: `/${IMPLEMENTATION_ROOT}${clean.slice(effective.length + 1)}`,
    };
  }
  if (isSubscriptionPath(clean, IMPLEMENTATION_ROOT)) return { action: 'not-found' };
  return { action: 'continue' };
}

/**
 * Minimal node request as seen by the middleware.
 *
 * Deliberately a structural type, not `IncomingMessage`: tests pass tiny fake
 * requests.
 */
interface MinimalRequest {
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** Minimal Nitro event shape (see `admin-auth.ts` for the same pattern). */
export interface SubscriptionRewriteEvent {
  node: {
    req: MinimalRequest;
    res?: {
      statusCode: number;
      setHeader(name: string, value: string): unknown;
      end(body?: string): unknown;
    };
  };
  /** h3 pre-parsed path (a getter on the real event: never assign it). */
  path?: string;
  /** h3's routing key (the router matches *this*, not `path`). */
  _path?: string;
}

/** Request path without the query string (h3 path first, then the URL). */
export function subscriptionRequestPath(event: SubscriptionRewriteEvent): string {
  const primary = event.path ?? event._path;
  if (primary) return primary.split('?')[0] ?? '/';
  const url = event.node.req.originalUrl ?? event.node.req.url ?? '/';
  return url.split('?')[0] ?? '/';
}

/**
 * The effective prefix: the `sub_path` setting through a small cache. There
 * is deliberately NO env override — the owner decided the prefix is an in-app
 * setting only (tests inject a seeded DB via `__setServerDbForTest`). The
 * hot, unauthenticated subscription path therefore costs at most one SQLite
 * read, and a saved change invalidates the cache (`PUT /api/admin/settings`),
 * so it is effective immediately.
 */
export function currentSubPathPrefix(): string {
  try {
    return cachedSubPath(getServerDb());
  } catch {
    return DEFAULT_SUB_PATH;
  }
}

/**
 * Point h3 at the implementation path.
 *
 * Why an accessor instead of a plain assignment: h3's `createAppEventHandler`
 * writes `event._path = _layerPath` before **every** stack layer (its layers
 * share one `_layerPath`/`_reqPath` decision taken from the original request),
 * so a plain data property written by a middleware is overwritten before the
 * router — and the Nitro router matches `event.path` — ever sees it. In the
 * smoke test that made `/dl/<token>/clash` fall through to the Vue page
 * router (302 to /login) although the middleware had "rewritten" `_path`.
 *
 * Redefining `_path` as an accessor that ignores further writes freezes the
 * rewrite for the rest of the request while keeping the property assignable
 * (`strict mode` writes to a getter-only property throw). Only reached for the
 * effective prefix ≠ `s`, i.e. the custom-prefix case the rewrite exists for.
 * `req.url` is rewritten as well so anything reading the raw URL agrees.
 */
function rewritePath(event: SubscriptionRewriteEvent, path: string): void {
  let current = path;
  try {
    Object.defineProperty(event, '_path', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: () => {
        // Ignore h3's per-layer reset; the rewrite is final for this request.
      },
    });
  } catch {
    // Frozen event (unexpected): fall back to the plain assignment.
    (event as { _path?: string })._path = path;
  }
  event.node.req.url = path;
}

/**
 * Nitro server middleware: an event handler (return to continue, respond to
 * stop), never connect-style — Nitro does not pass `next` (see admin-auth.ts
 * for the regression that taught us this).
 */
export default function subscriptionPathMiddleware(event: SubscriptionRewriteEvent): void {
  const decision = decideSubscriptionRewrite(subscriptionRequestPath(event), currentSubPathPrefix());
  if (decision.action === 'rewrite') {
    rewritePath(event, decision.implementationPath);
    return;
  }
  if (decision.action === 'not-found') {
    const res = event.node.res;
    if (!res) return;
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end('Not Found\n');
  }
}
