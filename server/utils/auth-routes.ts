// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared plumbing for the browser-facing XAuth (OIDC) routes (`/auth/*`).
 *
 * These are plain **server routes** (redirects + cookies), not JSON APIs, so
 * they extend the minimal node event shape used by the admin/user API with a
 * real response `end()`. They are exempt from the admin entrance gate exactly
 * like `/login` (`gateScope` → `public`), so a user with only their `/my` link
 * can start the flow.
 *
 * The event is read the same way the export handler does it
 * (`export-handler.ts` → `requestFromEvent`): use `event.path` when Nitro set
 * it, otherwise fall back to the raw request URL.
 */
import type { SubhubDb } from '../db';
import { getServerDb } from './db';
import { ValidationError } from './admin-validation';
import { sendJson, type AdminApiEvent } from './admin-api';

/**
 * IMPORTANT: this module must not import `server/utils/oidc.ts`.
 *
 * Nitro auto-imports every export of `server/utils/*`, and a name exported by
 * two modules produces a build warning (the repo keeps its count from growing).
 * `oidcInactive` / `logAuthFailure` / `authDb` etc. live here precisely so the
 * `oidc.ts` names stay unique.
 */

/** Response view the `/auth/*` routes need (status, headers, body, end). */
export interface AuthResponse {
  statusCode: number;
  setHeader(name: string, value: string | number | string[]): unknown;
  end(body?: string): unknown;
  writableEnded?: boolean;
  finished?: boolean;
}

/** Minimal event accepted by the `/auth/*` handlers (Nitro event or a test double). */
export interface AuthEvent extends Omit<AdminApiEvent, 'node'> {
  node: {
    req: AdminApiEvent['node']['req'] & {
      method?: string;
      originalUrl?: string;
    };
    res: AuthResponse;
  };
  /** h3 pre-parsed request path (no query string) when Nitro set it. */
  path?: string;
}

/**
 * Request URL INCLUDING the query string — what openid-client validates the
 * authorization response against (code, state, iss).
 *
 * The raw node request URL is authoritative: Nitro/h3 rewrite `event._path` for
 * each routed layer (the handler sees the path *relative* to its route) and some
 * layers drop the query string from `req.url`, so the router layer is the only
 * place that still holds the full `/auth/callback?code=…&state=…`. Only when the
 * raw URL carries no query at all (a pre-parsed test event) is the query taken
 * from `event._path` upstream.
 */
export function authRequestUrl(event: AuthEvent): string {
  const raw = event.node.req.originalUrl ?? event.node.req.url ?? '/';
  // Tests and some adapters park an absolute URL here; the downstream code only
  // needs the path + query.
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : null;
  if (absolute) return `${absolute.pathname}${absolute.search}`;
  if (raw.includes('?')) return raw.startsWith('/') ? raw : `/${raw}`;
  const upstream = event.path ?? event._path ?? '';
  const queryIndex = upstream.indexOf('?');
  const query = queryIndex >= 0 ? upstream.slice(queryIndex) : '';
  return `${raw.split('?')[0] || '/'}${query}`;
}

/** Header value helper (case-insensitive, first value). */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Site origin of this request (`proto://host`), for `redirect_uri` and the
 * post-logout URL. `x-forwarded-*` wins so a reverse-proxied deployment builds
 * the public URL (same convention as `originFromEvent` in the user API).
 */
export function authOrigin(event: AuthEvent): string {
  const headers = event.node.req.headers;
  const proto = headerValue(headers, 'x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
  const host =
    headerValue(headers, 'x-forwarded-host')?.split(',')[0]?.trim() ||
    headerValue(headers, 'host') ||
    '';
  return host ? `${proto}://${host}` : '';
}

/** Append `Set-Cookie` values (multiple cookies in one response). */
export function setCookies(res: AuthResponse, cookies: ReadonlyArray<string>): void {
  const kept = cookies.filter((cookie) => cookie.length > 0);
  if (kept.length === 0) return;
  res.setHeader('set-cookie', kept);
}

/** 302 to `location`, never cached, with the given cookies set/cleared. */
export function redirectTo(res: AuthResponse, location: string, cookies: ReadonlyArray<string> = []): void {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.setHeader('cache-control', 'no-store');
  setCookies(res, cookies);
  res.end('');
}

/**
 * A tiny standalone HTML page (no Nuxt renderer, no layout), in the same visual
 * language as the login card. Every text it shows comes from a whitelist — raw
 * provider errors / claims are never rendered.
 */
export function sendStandaloneHtml(
  event: AuthEvent,
  status: number,
  title: string,
  body: string,
  head = '',
): void {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F8FAFC">
<title>${escapeHtml(title)} · subhub</title>
${head}
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: radial-gradient(1200px 600px at 50% -10%, #DBE7FD 0%, #F8FAFC 55%, #F8FAFC 100%);
    color: #0F172A; font-family: "IBM Plex Sans", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: min(420px, 100%); background: #fff; border: 1px solid #E2E8F0; border-radius: 20px;
    padding: 32px 28px; box-shadow: 0 18px 40px rgba(15, 23, 42, 0.08); text-align: center; }
  .mark { width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 14px; display: grid; place-items: center;
    background: linear-gradient(135deg, #2563EB, #38BDF8); color: #fff; font-weight: 700; font-size: 20px; }
  .mark.muted { background: #E2E8F0; color: #475569; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 8px; color: #475569; line-height: 1.6; font-size: 14px; }
  .contact { margin-top: 16px; color: #2563EB; font-weight: 600; font-size: 14px; }
  a.btn { display: inline-block; margin-top: 20px; padding: 10px 20px; border-radius: 10px; background: #2563EB;
    color: #fff; text-decoration: none; font-size: 14px; font-weight: 600; }
</style>
</head>
<body>
<main class="card">${body}</main>
</body>
</html>`;
  event.node.res.statusCode = status;
  event.node.res.setHeader('content-type', 'text/html; charset=utf-8');
  event.node.res.setHeader('cache-control', 'no-store');
  event.node.res.setHeader('x-content-type-options', 'nosniff');
  event.node.res.setHeader('referrer-policy', 'no-referrer');
  event.node.res.end(html);
}

/** HTML-escape interpolated text (pages are built from constants, but never trust order). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Options every `/auth/*` handler accepts (tests inject a database). */
export interface AuthRouteOptions {
  db?: SubhubDb;
}

/** Run `work` with the shared database and JSON error handling (unused = no DB). */
export function authDb(options: AuthRouteOptions = {}): SubhubDb {
  return options.db ?? getServerDb();
}

/** Uniform 404 for every `/auth/*` route while XAuth is off. */
export function oidcInactive(event: AuthEvent): void {
  event.node.res.statusCode = 404;
  event.node.res.setHeader('content-type', 'text/plain; charset=utf-8');
  event.node.res.setHeader('cache-control', 'no-store');
  event.node.res.end('');
}

/** Log a provider/server failure without leaking it to the browser. */
export function logAuthFailure(route: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[auth/${route}] ${message}`);
}

/** JSON error for an unexpected failure (never reached by a browser flow). */
export function authInternalError(event: AuthEvent, error: unknown): unknown {
  if (error instanceof ValidationError) {
    return sendJson(event as AdminApiEvent, error.statusCode, { error: error.message });
  }
  logAuthFailure('internal', error);
  return sendJson(event as AdminApiEvent, 500, { error: 'internal error' });
}
