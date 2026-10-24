// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Secret entrance + page gate (runs before `admin-auth.ts`).
 *
 * The public root shows nothing: the management UI is only reachable after
 * visiting the configured entrance path (`SUBHUB_ADMIN_PATH`, default
 * `/admin`). The entrance sets the signed `subhub_gate` cookie and redirects to
 * `/login`; the existing admin session middleware then enforces login as usual.
 *
 * Admin surface without that cookie (admin pages, `/api/admin/*`) is answered
 * with a blank 200 HTML page — never a redirect, never an error body — so an
 * uninvited visitor cannot even tell an entrance exists. `/s/*` subscription
 * exports and every other public route are never touched.
 *
 * Like the other server middleware here this is a plain h3 event handler, not
 * connect middleware: return to continue, respond directly to stop. The
 * decision ("knock" / blank / allow) lives in `core/utils/admin-entrance.ts`
 * and the cookie in `server/utils/admin-gate.ts`; both are unit-tested.
 */
import {
  GATE_BLANK_BODY,
  GATE_BLANK_CONTENT_TYPE,
  decideGate,
  parseAdminPath,
} from '../../core/utils/admin-entrance';
import {
  gateCookieHeader,
  hasValidGateCookie,
  issueGateToken,
  isGateSigningUnavailable,
} from '../utils/admin-gate';
import { currentSubPathPrefix } from './sub-path';

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  originalUrl?: string;
}

interface MinimalResponse {
  statusCode: number;
  setHeader(name: string, value: string | number): unknown;
  end(body?: string): unknown;
}

export interface GateEvent {
  node: { req: MinimalRequest; res: MinimalResponse };
  /** h3 pre-parsed path (authoritative when present). */
  path?: string;
  _path?: string;
}

/** Raw request path, query included (h3 path first, then the URL). */
export function gateRequestPath(event: GateEvent): string {
  const primary = event.path ?? event._path;
  if (primary) return primary;
  return event.node.req.originalUrl ?? event.node.req.url ?? '/';
}

/** Entrance path for this process; warns (once per request) when invalid. */
export function currentEntrance(): string {
  return `/${parseAdminPath({ warn: (message) => console.warn(message) }).path}`;
}

/** Answer an admin-surface request with an empty 200 page. */
function blank(event: GateEvent): void {
  const { res } = event.node;
  res.statusCode = 200;
  res.setHeader('content-type', GATE_BLANK_CONTENT_TYPE);
  // Never let a shared cache serve this in place of the real page.
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(GATE_BLANK_BODY);
}

/** Answer an asset request without the gate cookie (nothing to serve). */
function notFound(event: GateEvent): void {
  const { res } = event.node;
  res.statusCode = 404;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end('');
}

/**
 * Gate decision for an event, used by the Nitro handler. Returns `true` when
 * the request must be stopped (the response has already been written).
 */
export function handleAdminGate(event: GateEvent): boolean {
  const path = gateRequestPath(event);
  const entrance = currentEntrance();

  // A knock always (re)issues the cookie — even when the browser already has
  // one, so the 30 days restart on every visit and a rotated secret recovers.
  // The gate runs BEFORE the sub-path rewrite, so it must recognise the
  // effective subscription prefix itself — otherwise exports under a custom
  // prefix would be blanked as an "unknown top-level path".
  const subFirstSegment = currentSubPathPrefix().split('/')[0] ?? 's';
  const decision = decideGate(
    { path, entrance, hasGateCookie: hasValidGateCookie(event.node.req.headers), subFirstSegment },
    '',
  );
  if (decision.action === 'knock') {
    const token = issueGateToken();
    if (token === null) {
      // Production without SUBHUB_SECRET: fail closed. The entrance is blank
      // like everything else instead of handing out a public-key cookie.
      if (isGateSigningUnavailable()) {
        console.error('[admin-gate] SUBHUB_SECRET is required in production; refusing to issue the gate cookie');
      }
      blank(event);
      return true;
    }
    const { res } = event.node;
    res.statusCode = 302;
    res.setHeader('location', decision.redirect);
    res.setHeader('set-cookie', gateCookieHeader(token));
    res.setHeader('cache-control', 'no-store');
    res.end('');
    return true;
  }

  if (decision.action === 'allow') return false;
  if (decision.action === 'not-found') {
    notFound(event);
    return true;
  }
  blank(event);
  return true;
}

/**
 * Nitro server middleware. An event handler (not connect middleware): return
 * to continue, respond to stop. Deliberately a plain function — Nitro treats
 * any default export here as `(event) => ...`.
 */
export default function adminGateMiddleware(event: GateEvent): void {
  handleAdminGate(event);
}
