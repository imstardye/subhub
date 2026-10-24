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

/**
 * Minimal shape of the node request stream (`IncomingMessage`). Only the
 * members the body reader touches are typed, so tests can pass a `Readable`.
 */
export interface AdminApiRequestStream {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  destroy?: () => void;
  readableEnded?: boolean;
  complete?: boolean;
}

/** Nesting-safe subset of a Nitro event used by the admin routes. */
export interface AdminApiEvent {
  node: {
    req: {
      method?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      on?: AdminApiRequestStream['on'];
      destroy?: () => void;
      readableEnded?: boolean;
      complete?: boolean;
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

/** Request query string as a plain map (last value wins). */
export function requestQuery(event: AdminApiEvent): Record<string, string> {
  const raw = event.node.req.url ?? '';
  const index = raw.indexOf('?');
  if (index < 0) return {};
  const params = new URLSearchParams(raw.slice(index + 1));
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

/**
 * Read a JSON body. Accepts a pre-parsed object (Nitro adapters / tests) or a
 * JSON string; returns `undefined` for anything else. The cap keeps a hostile
 * payload from being processed (the API bodies here are tiny).
 *
 * `undefined` from any step means "no usable body": the caller answers the
 * usual 'invalid JSON body'.
 */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

/** A body buffered by an adapter (or a test) before the handler ran. */
function bufferedJsonBody(event: AdminApiEvent): unknown {
  return (
    event.node.req.body ??
    event._requestBody ??
    event.node.req[Symbol.for('h3RawBody')] ??
    event.web?.request?.body
  );
}

/** Parse a buffered body value; over-cap strings are rejected unparsed. */
function parseBufferedBody(raw: unknown): unknown {
  if (typeof raw !== 'object') {
    if (typeof raw !== 'string') return undefined;
    if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BODY_BYTES) return undefined;
  }
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
}

/**
 * Read a body off the node request stream.
 *
 * The node runtime does not populate any of the buffered sources above: h3's
 * `readBody` is not involved and `req.body` only exists on other adapters. So
 * when nothing is buffered the raw bytes have to be consumed here. The stream
 * may already be spent (another handler read it) or absent in tests, in which
 * case this resolves `undefined` instead of throwing or hanging.
 */
async function streamJsonBody(event: AdminApiEvent): Promise<unknown> {
  const req = event.node.req;
  if (typeof req.on !== 'function') return undefined;
  // Already drained by someone else: a fresh listener would never fire.
  if (req.readableEnded === true || req.complete === true) return undefined;

  const raw = await new Promise<string | undefined>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const on = req.on!;
    try {
      on.call(req, 'data', (...args: unknown[]) => {
        if (settled) return;
        const chunk = args[0];
        if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') return;
        size += Buffer.byteLength(chunk);
        if (size > MAX_JSON_BODY_BYTES) {
          // Over the cap: stop reading and treat the body as invalid.
          req.destroy?.();
          finish(undefined);
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      on.call(req, 'end', () => finish(Buffer.concat(chunks).toString('utf8')));
      on.call(req, 'error', () => finish(undefined));
      on.call(req, 'aborted', () => finish(undefined));
    } catch {
      finish(undefined);
    }
  });

  if (typeof raw !== 'string' || raw === '') return undefined;
  return parseBufferedBody(raw);
}

/** Resolve the JSON body, preferring a buffered copy over the raw stream. */
export async function readJsonBody(event: AdminApiEvent): Promise<unknown> {
  const buffered = bufferedJsonBody(event);
  // An empty buffered string means "fall through to the stream" (some
  // adapters park an empty placeholder there).
  if (buffered !== undefined && buffered !== null && buffered !== '') {
    return parseBufferedBody(buffered);
  }
  return streamJsonBody(event);
}
