// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Secret admin entrance ("knock") and page gate — pure logic.
 *
 * The public site root must show nothing. The owner reaches the management UI
 * through a configurable entrance path (`SUBHUB_ADMIN_PATH`, default `admin`),
 * e.g. `GET /admin`. Visiting it sets a long-lived signed cookie and redirects
 * to `/login`; every admin *page* (and `/api/admin/*`) is answered with a blank
 * 200 page until that cookie is present. Gated responses never redirect — a
 * redirect would reveal that an entrance exists.
 *
 * The cookie value is a token signed from the same secret as the admin session
 * (`SUBHUB_SECRET`, with the same development fallback), never the path itself;
 * a client cannot mint it by guessing the entrance.
 *
 * Everything here is a plain function over strings / header maps so the
 * middleware (`server/middleware/admin-gate.ts`) stays a thin wrapper and both
 * can be unit-tested without a Nitro runtime.
 */

/** Env var holding the entrance path. */
export const ADMIN_PATH_ENV = 'SUBHUB_ADMIN_PATH';

/** Entrance used when the variable is unset, empty or invalid. */
export const DEFAULT_ADMIN_PATH = 'admin';

/** Cookie set by the entrance and checked by the gate. */
export const GATE_COOKIE = 'subhub_gate';

/** Gate cookie lifetime: 30 days. */
export const GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * First path segments that would shadow a real route: `/s/*` subscription
 * exports, `/my/*` user center, `/api/*` and the `/_nuxt` asset prefix.
 */
export const RESERVED_ADMIN_PATH_SEGMENTS = ['s', 'my', 'api', '_nuxt'] as const;

/**
 * The self-service user center: `/my/<token>` (page) and `/api/user/*` (its
 * token-scoped JSON API). Both are public by design — the token in the URL is
 * the credential — and must never be blanked by the gate.
 */
export const USER_CENTER_PAGES = ['/my'] as const;
export const USER_API_PREFIX = '/api/user';

/** One entrance segment: lowercase, no dots, starts with a letter or digit. */
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Admin *pages*: the document routes of the management UI. Anything not listed
 * here (subscription exports under `/s`, future public pages) is never gated.
 * All current pages are top-level, so a single leading segment identifies them.
 */
export const GATE_PAGE_PATHS = [
  '/',
  '/login',
  '/users',
  '/sources',
  '/profiles',
  '/logs',
  '/preview',
] as const;

/** Prefix for every admin API route. */
export const GATED_API_PREFIX = '/api/admin';

/**
 * The login/logout endpoints stay reachable without the gate cookie. They are
 * the tail of the entrance flow (a fresh browser that found the entrance is
 * redirected to `/login`, whose form posts here), they are already throttled,
 * and they reveal nothing that is not reachable by standing at `/login` with
 * the cookie. Everything else under `/api/admin` is gated, and login itself is
 * still enforced by `01-admin-auth.ts` / the route handlers.
 */
export const UNGATED_ADMIN_API_PATHS = ['/api/admin/login', '/api/admin/logout'] as const;

/** Prefix of the generated client assets. */
export const NUXT_ASSET_PREFIX = '/_nuxt';

export interface AdminPathOptions {
  /** Raw value (tests); defaults to `process.env[ADMIN_PATH_ENV]`. */
  value?: string | null;
  /** Called for an invalid/normalised-away value (tests capture it). */
  warn?: (message: string) => void;
}

export interface AdminPathResult {
  /** Normalised entrance without slashes, e.g. `admin` or `hx/panel`. */
  path: string;
  /** True when a value was configured but rejected (the default was used). */
  invalid: boolean;
}

/**
 * Normalise `SUBHUB_ADMIN_PATH`.
 *
 * Trim, strip leading/trailing slashes and collapse repeated slashes; every
 * segment must match `[a-z0-9][a-z0-9_-]*` and the first must not shadow a real
 * route (`s`, `api`, `_nuxt`). Unset or blank values silently mean `admin`; a
 * configured but invalid value also falls back to `admin` *and* warns once.
 */
export function parseAdminPath(options: AdminPathOptions = {}): AdminPathResult {
  const raw = options.value !== undefined ? options.value : process.env[ADMIN_PATH_ENV];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return { path: DEFAULT_ADMIN_PATH, invalid: false };

  const segments = trimmed
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  // Nothing but slashes / whitespace: same as unset, not an error.
  if (segments.length === 0) return { path: DEFAULT_ADMIN_PATH, invalid: false };

  const valid =
    segments.every((segment) => SEGMENT_PATTERN.test(segment)) &&
    !(RESERVED_ADMIN_PATH_SEGMENTS as readonly string[]).includes(segments[0]!);

  if (!valid) {
    options.warn?.(
      `[admin-gate] ignoring invalid ${ADMIN_PATH_ENV} (must be lowercase ` +
        `segments matching [a-z0-9][a-z0-9_-]*, first not one of ` +
        `${RESERVED_ADMIN_PATH_SEGMENTS.join('/')}) — using "${DEFAULT_ADMIN_PATH}"`,
    );
    return { path: DEFAULT_ADMIN_PATH, invalid: true };
  }
  return { path: segments.join('/'), invalid: false };
}

/** Normalised entrance path, with the leading slash (`/admin`). */
export function adminEntrancePath(result = parseAdminPath()): string {
  return `/${result.path}`;
}

/**
 * Request path as compared by the gate: no query string, decoded, lowercased,
 * without trailing slashes (`/` stays `/`). Multiple slashes are collapsed,
 * mirroring the entrance normalisation.
 */
export function normalizeRequestPath(path: string): string {
  let value = (path.split('?')[0] ?? '').split('#')[0] ?? '';
  try {
    value = decodeURIComponent(value);
  } catch {
    // Malformed escape: compare the raw form rather than throwing.
  }
  value = value.toLowerCase().replace(/\/{2,}/g, '/');
  if (value !== '/' && value.endsWith('/')) value = value.slice(0, -1);
  return value === '' ? '/' : value;
}

export type GateScope =
  | { kind: 'knock' }
  | { kind: 'public' }
  | { kind: 'assets' }
  | { kind: 'admin-page' }
  | { kind: 'admin-api' };

/**
 * Classify a request path for the gate.
 *
 * Order matters: the entrance is checked before everything, so an entrance that
 * (unvalidated) collides with a page still knocks; `/s/*` and `/api/*` (other
 * than the admin API) stay public; `/_nuxt/*` is asset traffic; admin pages and
 * `/api/admin/*` are gated — except the login/logout endpoints, which must be
 * reachable for a browser that just knocked (see UNGATED_ADMIN_API_PATHS).
 */
export function gateScope(
  path: string,
  entrance: string = adminEntrancePath(),
  subFirstSegment: string = 's',
): GateScope {
  const clean = normalizeRequestPath(path);
  if (clean === normalizeRequestPath(entrance)) return { kind: 'knock' };
  const segments = clean.split('/').filter((segment) => segment.length > 0);
  const first = segments[0] ?? '';

  // Subscription exports are public under the EFFECTIVE prefix (the in-app
  // `sub_path` setting, first segment — the gate runs before the sub-path
  // rewrite middleware, so it must recognise the prefix itself) and under
  // the implementation root `s` (which the rewrite middleware 404s while a
  // custom prefix is active — passing it through leaks nothing).
  if (first === 's' || first === subFirstSegment) return { kind: 'public' };
  // `/my/<token>`: the token is the credential; never gated (the route itself
  // answers 404 for unknown tokens, exactly like `/s/*`).
  if ((USER_CENTER_PAGES as readonly string[]).includes(`/${first}`)) return { kind: 'public' };
  if (first === '_nuxt') return { kind: 'assets' };
  if (first === 'api') {
    const second = segments[1] ?? '';
    if ((UNGATED_ADMIN_API_PATHS as readonly string[]).includes(clean)) return { kind: 'public' };
    return second === 'admin' ? { kind: 'admin-api' } : { kind: 'public' };
  }
  const page = `/${first}`;
  if (first === '' || (GATE_PAGE_PATHS as readonly string[]).includes(page)) {
    return { kind: 'admin-page' };
  }
  // A public route that exists today would be listed above (`/s/*`, other
  // APIs). Unknown top-level paths are gated: a future page must not leak
  // its existence (and its shell) just because it was not added here.
  return { kind: 'admin-page' };
}

/** How the gate should answer a request. */
export type GateDecision =
  /** Entrance hit: set the gate cookie and redirect to /login. */
  | { action: 'knock'; cookie: string; redirect: string }
  /** Not admin surface, or a valid gate cookie: continue to the route. */
  | { action: 'allow'; reason: 'not-admin-surface' | 'has-gate-cookie' | 'asset' }
  /** Admin surface without a valid gate cookie: blank 200, no redirect. */
  | { action: 'blank' }
  /** Asset request without a valid gate cookie: nothing to serve. */
  | { action: 'not-found' };

/** What the gate learns from the request, independent of headers parsing. */
export interface GateInput {
  path: string;
  /** Entrance path from `adminEntrancePath()`. */
  entrance: string;
  /** True when the request carries a validly signed gate cookie. */
  hasGateCookie: boolean;
  /**
   * First segment of the effective subscription prefix (`sub_path` setting;
   * multi-segment prefixes contribute their first segment). Defaults to the
   * implementation root `s`.
   */
  subFirstSegment?: string;
}

/** Redirect target of a successful knock: the existing login flow. */
export const GATE_REDIRECT_PATH = '/login';

/**
 * Pure decision for the middleware. A knock always wins and (re)issues the
 * cookie; assets are served only to a browser that already has it; admin
 * surface without a cookie is blanked; everything else continues.
 */
export function decideGate(input: GateInput, cookie = ''): GateDecision {
  const scope = gateScope(input.path, input.entrance, input.subFirstSegment ?? 's');
  if (scope.kind === 'knock') {
    return { action: 'knock', cookie, redirect: GATE_REDIRECT_PATH };
  }
  if (scope.kind === 'public') return { action: 'allow', reason: 'not-admin-surface' };
  if (input.hasGateCookie) {
    return { action: 'allow', reason: scope.kind === 'assets' ? 'asset' : 'has-gate-cookie' };
  }
  if (scope.kind === 'assets') return { action: 'not-found' };
  return { action: 'blank' };
}

/** Body and headers of the blank page; deliberately empty and uncacheable. */
export const GATE_BLANK_BODY = '';
export const GATE_BLANK_CONTENT_TYPE = 'text/html; charset=utf-8';
