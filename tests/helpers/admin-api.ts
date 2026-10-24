// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared test doubles for the admin API routes.
 *
 * `makeApiEvent` mimics the Nitro event shape the routes rely on: method, url,
 * headers (cookie), a pre-parsed JSON body and a status-code/header recorder.
 * Not a test file itself (no `.test.ts`), so vitest does not collect it.
 */
import { Readable } from 'node:stream';
import { ADMIN_COOKIE, createSessionToken } from '../../server/utils/admin-auth';
import { createSessionRevocationStore } from '../../server/utils/session-revocation';
import type { AdminApiEvent } from '../../server/utils/admin-api';

export interface ApiEventOptions {
  method?: string;
  /** Path including the query string, e.g. `/api/admin/users?x=1`. */
  url?: string;
  body?: unknown;
  /** Raw session token; omit for an anonymous request. */
  sessionToken?: string | null;
}

export function makeApiEvent(options: ApiEventOptions = {}) {
  const headers: Record<string, string> = { host: 'localhost' };
  const token = options.sessionToken ?? null;
  if (token) headers.cookie = `${ADMIN_COOKIE}=${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const responseHeaders: Record<string, string> = {};
  const event: AdminApiEvent = {
    node: {
      req: {
        method: options.method ?? 'GET',
        url: options.url ?? '/',
        headers,
        body: options.body,
      },
      res: {
        statusCode: 200,
        setHeader(name: string, value: string | number | string[]) {
          responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        },
      },
    },
    _path: (options.url ?? '/').split('?')[0],
  };

  return { event, headers: responseHeaders };
}

export interface StreamApiEventOptions {
  /** Bytes/chunks the node request stream will emit. */
  body: string | Buffer | Array<Buffer | string>;
  method?: string;
  url?: string;
  sessionToken?: string | null;
}

/**
 * An event whose ONLY body source is a readable stream on `node.req`, like the
 * real Nitro node runtime: no `req.body`, no `_requestBody`, no h3 raw-body
 * symbol, no `web.request.body`. Regression harness for the production
 * "invalid JSON body" bug (admin-api.ts readJsonBody must read the stream).
 */
export function streamApiEvent(options: StreamApiEventOptions) {
  const headers: Record<string, string> = { host: 'localhost', 'content-type': 'application/json' };
  const token = options.sessionToken ?? null;
  if (token) headers.cookie = `${ADMIN_COOKIE}=${token}`;

  const chunks = Array.isArray(options.body) ? options.body : [options.body];
  // The underlying readable is returned too, so a test can drain it first
  // (simulating a body another handler already consumed).
  const readable = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
  const stream = readable as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    destroy: () => void;
  };

  const responseHeaders: Record<string, string> = {};
  const req: AdminApiEvent['node']['req'] = {
    method: options.method ?? 'POST',
    url: options.url ?? '/',
    headers,
    // Bound so the reader can call it detached (`on.call(req, ...)`).
    on: stream.on.bind(stream),
    destroy: stream.destroy.bind(stream),
  };
  // A real IncomingMessage exposes these; mirror them live so the reader can
  // detect a stream another handler already drained.
  Object.defineProperties(req, {
    readableEnded: { get: () => readable.readableEnded },
    complete: { get: () => readable.readableEnded },
  });

  const event: AdminApiEvent = {
    node: {
      req,
      res: {
        statusCode: 200,
        setHeader(name: string, value: string | number | string[]) {
          responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        },
      },
    },
    _path: (options.url ?? '/').split('?')[0],
  };

  return { event, headers: responseHeaders, readable };
}

/** Session-authenticated variant of `streamApiEvent`. */
export function authenticatedStreamEvent(
  options: Omit<StreamApiEventOptions, 'sessionToken'>,
  revocations = createSessionRevocationStore(),
) {
  const sessionToken = createSessionToken({ revocations });
  const result = streamApiEvent({ ...options, sessionToken });
  return { ...result, revocations, sessionToken };
}

/**
 * An authenticated event. By default it uses its own fresh revocation store;
 * pass the one a handler will check with so revocations are visible to it.
 */
export function authenticatedEvent(
  options: Omit<ApiEventOptions, 'sessionToken'> = {},
  revocations = createSessionRevocationStore(),
) {
  const sessionToken = createSessionToken({ revocations });
  const result = makeApiEvent({ ...options, sessionToken });
  return { ...result, revocations, sessionToken };
}
