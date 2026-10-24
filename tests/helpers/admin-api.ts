// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared test doubles for the admin API routes.
 *
 * `makeApiEvent` mimics the Nitro event shape the routes rely on: method, url,
 * headers (cookie), a pre-parsed JSON body and a status-code/header recorder.
 * Not a test file itself (no `.test.ts`), so vitest does not collect it.
 */
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
