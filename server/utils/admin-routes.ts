// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared plumbing for the admin CRUD routes (`/api/admin/users`, `/api/admin/sources`).
 *
 * Every handler is additionally protected by the global Nitro middleware
 * `server/middleware/admin-auth.ts`; `requireAdminOr401` repeats the check
 * inside the handler so a route is still guarded if it is mounted without that
 * middleware (defence in depth, and the unit test calls handlers directly).
 */
import { isAdmin, type AdminEvent } from './admin-auth';
import { getServerDb } from './db';
import type { SubhubDb } from '../db';
import type { SessionRevocationStore } from './session-revocation';
import { ValidationError } from './admin-validation';
import {
  readJsonBody,
  requestPath,
  sendError,
  sendJson,
  type AdminApiEvent,
} from './admin-api';

/** Path segment after the collection, e.g. `/api/admin/users/42` -> `42`. */
export function idFromPath(event: AdminApiEvent, collection: string): string | undefined {
  const prefix = `/api/admin/${collection}`;
  const path = requestPath(event);
  const param = event.context?.params?.id;
  if (typeof param === 'string' && param !== '') return param;
  // The `id` either sits right behind the collection (`/api/admin/users/42`)
  // or after a sub-resource (`/api/admin/users/42/reset-token`).
  if (path === prefix || !path.startsWith(`${prefix}/`)) return undefined;
  const rest = path.slice(prefix.length).replace(/^\/+/, '');
  return rest.split('/')[0] || undefined;
}

/** Keep the session error shape (401) while turning other failures into JSON. */
function errorResponse(event: AdminApiEvent, error: unknown): unknown {
  if (error instanceof ValidationError) {
    return sendError(event, error.statusCode, error.message);
  }
  if ((error as { statusCode?: number }).statusCode === 401) throw error;
  console.error('[admin-api]', error);
  return sendError(event, 500, 'internal error');
}

/**
 * Options accepted by `handleAdminRequest` and forwarded by every route:
 * `db` defaults to the process-wide handle; tests inject a temp database.
 * `revocations` is accepted so a test can make its fake session cookies
 * verifiable by a store it controls (the login route is separate).
 */
export interface AdminRequestOptions {
  db?: SubhubDb;
  revocations?: SessionRevocationStore;
}

/**
 * Run `work` with a guaranteed admin session and JSON error handling.
 */
export async function handleAdminRequest<T>(
  event: AdminApiEvent,
  work: (db: SubhubDb) => T | Promise<T>,
  options: AdminRequestOptions = {},
): Promise<unknown> {
  // Checked inline (not via requireAdmin) so the answer is the same JSON body
  // regardless of how the route was mounted.
  if (!isAdmin(event as unknown as AdminEvent, { revocations: options.revocations })) {
    return sendError(event, 401, 'unauthorized');
  }
  try {
    return await work(options.db ?? getServerDb());
  } catch (error) {
    return errorResponse(event, error);
  }
}

/**
 * Parse the JSON body of a write request, answering 400/415 on failure.
 *
 * Async because the body may only be available on the raw node request stream
 * (see `readJsonBody`): route callbacks are awaited by `handleAdminRequest`.
 */
export async function parseBody(event: AdminApiEvent): Promise<Record<string, unknown>> {
  const body = await readJsonBody(event);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('invalid JSON body');
  }
  return body as Record<string, unknown>;
}

/** 201 helper for create routes. */
export function sendCreated(event: AdminApiEvent, item: unknown): unknown {
  return sendJson(event, 201, { item });
}
