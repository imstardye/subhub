// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Response recorder for the browser-facing `/auth/*` routes.
 *
 * Those handlers write real node responses (`statusCode`, `setHeader`,
 * `end(body)`), unlike the JSON API handlers whose return value is the body, so
 * a test needs something that behaves like `ServerResponse`. Not a test file
 * itself (no `.test.ts`), so vitest does not collect it.
 */
import { handleAdminGate, type GateEvent } from '../../server/middleware/00-admin-gate';
import {
  handleAdminAuth,
  type AdminAuthEvent,
} from '../../server/middleware/01-admin-auth';

export interface RecordedResponse {
  /** Minimal event handed to the handler. */
  event: never;
  /** Headers set by the handler (lower-cased names; `set-cookie` = raw values). */
  headers: Record<string, string | string[]>;
  /** Response body written with `end()`. */
  body: string;
  status: number;
}

export function routeEvent(
  url: string,
  options: {
    method?: string;
    cookie?: string | null;
    host?: string;
    headers?: Record<string, string>;
    /** Pre-parsed JSON body (handlers read it off `req.body`). */
    body?: unknown;
  } = {},
): RecordedResponse {
  const headers: Record<string, string> = { host: options.host ?? 'subhub.test', ...(options.headers ?? {}) };
  if (options.cookie) headers.cookie = options.cookie;
  const out = { event: null as never, headers: {}, body: '' } as RecordedResponse & {
    event: never;
    headers: Record<string, string | string[]>;
    body: string;
    status: number;
  };
  // `req.body` mirrors what a Nitro/node adapter parks on the request, so the
  // JSON API handlers (`parseBody` → `readJsonBody`) can read it.
  const req: Record<string, unknown> = { method: options.method ?? 'GET', url, headers };
  if (options.body !== undefined) {
    req.body = options.body;
    headers['content-type'] = 'application/json';
  }
  const event = {
    node: {
      req,
      res: {
        statusCode: 200,
        setHeader(name: string, value: string | number | string[]) {
          out.headers[name.toLowerCase()] = Array.isArray(value) ? value.map(String) : String(value);
        },
        end(value?: string) {
          out.body = value ?? '';
          // Keep the last payload on the response too (helpers read it back).
          (event.node.res as { body?: string }).body = out.body;
        },
      },
    },
    _path: url.split('?')[0],
    // Nitro's app handler reads the FULL `event._path` (query included) as the
    // routing request URL; `path` is what h3 route handlers see. Both are set so
    // browser routes can rebuild the absolute callback URL.
    path: url,
  };
  // `status` is a getter over the live response, so it stays correct for the
  // JSON API handlers too (they set `statusCode` but never call `end()`).
  Object.defineProperty(out, 'status', {
    enumerable: true,
    get: () => event.node.res.statusCode,
  });
  out.event = event as never;
  return out;
}

/** `Set-Cookie` values of a recorded response (always an array). */
export function setCookiesOf(response: RecordedResponse): string[] {
  const value = response.headers['set-cookie'];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Single header value (first one when repeated). */
export function headerOf(response: RecordedResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Run the real server middleware (`00-admin-gate.ts`) for a path WITHOUT any
 * gate cookie. Returns the recorded response when the middleware answered
 * (gated/blank), or `null` when it let the request through.
 *
 * The middleware may answer (knock) or return normally; a normal return means
 * the request continues to the route, which is what the caller asserts.
 */
export function runGate(path: string, cookie?: string | null): RecordedResponse | null {
  const recorded = routeEvent(path, { cookie });
  const stopped = handleAdminGate(recorded.event as unknown as GateEvent);
  return stopped ? recorded : null;
}

/**
 * Let the request go through BOTH server middlewares (Nitro order: 00 gate,
 * then 01 admin auth) for a path, without any cookie, the way the real stack
 * does. Returns the response when a middleware stopped it, `null` otherwise.
 */
export function runMiddlewares(path: string, cookie?: string | null): RecordedResponse | null {
  const gate = runGate(path, cookie);
  if (gate) return gate;
  const recorded = routeEvent(path, { cookie });
  const stopped = handleAdminAuth(recorded.event as unknown as AdminAuthEvent);
  return stopped ? recorded : null;
}
