// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Small helpers shared by the admin JSON routes (/api/admin/users, /sources).
 *
 * The handlers are plain modules taking a minimal event shape (like
 * `login.post.ts`) rather than relying on h3 auto-imports, so they type-check
 * without the generated `.nuxt` types and can be called from tests with fake
 * node events.
 */
import type { UnauthorizedError } from './admin-auth';
import { isAdmin } from './admin-auth';

/** Nesting-safe subset of a Nitro event used by the admin routes. */
export interface AdminApiEvent {
  node: {
    req: {
      method?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      [symbol: symbol]: unknown;
    };
    res: {
      statusCode: number;
      setHeader(name: string, value: string | number | string[]): unknown;
    };
  };
  context?: { params?: Record<string, string | undefined> };
  _requestBody?: unknown;
  _path?: string;
  web?: { request?: { body?: unknown } };
}

/** JSON response helper; always disables caching. */
export function sendJson(event: AdminApiEvent, status: number, body: unknown): unknown {
  event.node.res.statusCode = status;
  event.node.res.setHeader('content-type', 'application/json; charset=utf-8');
  event.node.res.setHeader('cache-control', 'no-store');
  return body;
}

/** Uniform error body used by the admin CRUD routes. */
export function sendError(event: AdminApiEvent, status: number, error: string): unknown {
  return sendJson(event, status, { error });
}

/** Throw a 401 (h3 error shape) unless the request carries an admin session. */
export function assertAdmin(event: AdminApiEvent): void {
  if (isAdmin(event)) return;
  const error = new Error('Unauthorized') as UnauthorizedError;
  error.statusCode = 401;
  error.statusMessage = 'Unauthorized';
  throw error;
}

/** Request path without the query string. */
export function requestPath(event: AdminApiEvent): string {
  const path = event._path ?? event.node.req.url ?? '/';
  return path.split('?')[0] ?? '/';
}

/**
 * Read a JSON body. Accepts a pre-parsed object (Nitro adapters / tests) or a
 * JSON string; returns `undefined` for anything else. The cap keeps a hostile
 * payload from being processed (the API bodies here are tiny).
 */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

export function readJsonBody(event: AdminApiEvent): unknown {
  const raw =
    event.node.req.body ??
    event._requestBody ??
    event.node.req[Symbol.for('h3RawBody')] ??
    event.web?.request?.body;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BODY_BYTES) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
