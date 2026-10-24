// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared plumbing for the token-scoped user center API (`/api/user/:token/*`).
 *
 * Deliberately *not* admin-authenticated: the token in the path is the whole
 * credential. Each handler resolves the owner through `user-token.ts` and
 * validates every id it is given against that owner (see `user-center.ts`), so
 * a token can never reach another user's sources.
 *
 * Errors use the same JSON shape as the admin routes (`ValidationError` ->
 * its status, anything else -> 500 'internal error'); an unknown token is a
 * bare 404, never a hint about which ids exist.
 */
import { getServerDb } from './db';
import type { SubhubDb } from '../db';
import { ValidationError } from './admin-validation';
import { requestPath, sendJson, type AdminApiEvent } from './admin-api';

/** Options forwarded by every user-center route (tests inject a database). */
export interface UserRequestOptions {
  db?: SubhubDb;
}

/** Path segments after `/api/user/`: `[token, resource?, id?]`. */
export function userPathSegments(event: AdminApiEvent): string[] {
  const path = requestPath(event);
  const rest = path.replace(/^\/api\/user\/?/, '');
  return rest
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** The `:token` segment (Nitro param first, raw path as the fallback). */
export function tokenFromPath(event: AdminApiEvent): string {
  const param = event.context?.params?.token;
  if (typeof param === 'string' && param !== '') return param;
  return userPathSegments(event)[0] ?? '';
}

/** The `:id` segment of `/api/user/:token/sources/:id`. */
export function sourceIdFromPath(event: AdminApiEvent): string | undefined {
  const param = event.context?.params?.id;
  if (typeof param === 'string' && param !== '') return param;
  return userPathSegments(event)[2];
}

/** Same shape as the admin routes; no session is involved. */
function errorResponse(event: AdminApiEvent, error: unknown): unknown {
  if (error instanceof ValidationError) {
    return sendJson(event, error.statusCode, { error: error.message });
  }
  console.error('[user-api]', error);
  return sendJson(event, 500, { error: 'internal error' });
}

/** Run `work` with JSON error handling (mirrors `handleAdminRequest`). */
export async function handleUserRequest<T>(
  event: AdminApiEvent,
  work: (db: SubhubDb) => T | Promise<T>,
  options: UserRequestOptions = {},
): Promise<unknown> {
  try {
    return await work(options.db ?? getServerDb());
  } catch (error) {
    return errorResponse(event, error);
  }
}

/** Nitro auto-imports the exports of `server/utils/*`; `sendJson` is the only
 * name this file adds to that global table (re-exporting `sendError` from both
 * here and `admin-api.ts` made the build warn about a duplicate). */

