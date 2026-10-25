// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/tasks/refresh-sources — manual trigger for the cache refresh task.
 *
 * Admin-only: the caller must send `x-admin-password` equal to
 * `SUBHUB_ADMIN_PASSWORD` (explicitly configured; the local development
 * fallback is not accepted). Missing/wrong header, or no configured password,
 * -> 401.
 *
 * The POST body is not used; it is drained with a hard byte cap so an oversized
 * payload is rejected before it is buffered. `Content-Length` over the cap is
 * rejected immediately, otherwise chunks are counted as they arrive and the
 * request is aborted as soon as the cap is crossed.
 *
 * Query: `?sourceId=123` narrows the run, `?force=1` ignores the due check.
 *
 * Uses a minimal local event shape instead of Nuxt auto-import globals so the
 * module type-checks without the generated `.nuxt` types.
 */
import {
  adminPasswordFromHeader,
  verifyAdminPassword,
  type AdminAuthOptions,
} from '../../utils/admin-auth';
import { refreshAllDueSources } from '../../utils/refresh-sources';
import { getServerDb } from '../../utils/db';

/** Max accepted request body (the trigger takes no body). */
export const MAX_TRIGGER_BODY_BYTES = 8 * 1024;

export interface TaskRequest {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on?: (event: 'data' | 'end' | 'aborted' | 'error', listener: (...args: unknown[]) => void) => unknown;
  /** Abort the underlying request (Node `IncomingMessage#destroy`). */
  destroy?: (error?: Error) => void;
}

export interface TaskEvent {
  _path?: string;
  node: {
    req: TaskRequest;
    res: { statusCode: number; setHeader?(name: string, value: string): unknown };
  };
}

function firstQueryValue(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

/**
 * Whether the trigger may run. Requires an explicit SUBHUB_ADMIN_PASSWORD and
 * the matching `x-admin-password` header: the fixed development password used
 * by the browser login is deliberately not accepted here.
 */
export function isAuthorizedTrigger(
  req: Pick<TaskRequest, 'headers'>,
  opts: AdminAuthOptions = {},
): boolean {
  return verifyAdminPassword(adminPasswordFromHeader(req), {
    ...opts,
    allowDevDefault: false,
  });
}

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Drain a request body, aborting as soon as it exceeds `maxBytes`. Rejects with
 * `BodyTooLargeError` once the cap is crossed.
 */
export function readBodyWithLimit(req: TaskRequest, maxBytes = MAX_TRIGGER_BODY_BYTES): Promise<void> {
  const declared = req.headers['content-length'];
  const declaredValue = Array.isArray(declared) ? declared[0] : declared;
  const declaredBytes = declaredValue === undefined ? NaN : Number(declaredValue);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    req.destroy?.();
    return Promise.reject(new BodyTooLargeError(maxBytes));
  }
  if (typeof req.on !== 'function') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let received = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    req.on?.('data', (...args: unknown[]) => {
      const chunk = args[0] as { length?: number } | undefined;
      received += chunk?.length ?? 0;
      if (received > maxBytes) {
        req.destroy?.();
        finish(new BodyTooLargeError(maxBytes));
      }
    });
    req.on?.('end', () => finish());
    req.on?.('aborted', () => finish(new Error('request aborted')));
    req.on?.('error', (...args: unknown[]) => finish(args[0] instanceof Error ? args[0] : new Error('request error')));
  });
}

function respond(event: TaskEvent, status: number, body: unknown): unknown {
  event.node.res.statusCode = status;
  return body;
}

export default async function refreshSourcesHandler(
  event: TaskEvent,
  authOptions: AdminAuthOptions = {},
): Promise<unknown> {
  if (!isAuthorizedTrigger(event.node.req, authOptions)) {
    // One generic answer for "not configured" and "wrong header" so the
    // endpoint does not reveal whether a password exists.
    return respond(event, 401, { error: 'unauthorized' });
  }

  try {
    await readBodyWithLimit(event.node.req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      event.node.res.setHeader?.('connection', 'close');
      return respond(event, 413, { error: 'request body too large' });
    }
    return respond(event, 400, { error: 'cannot read request body' });
  }

  const url = new URL(event.node.req.url ?? '/', 'http://localhost');
  const sourceIdRaw = firstQueryValue(url.searchParams.get('sourceId'));
  const sourceId = sourceIdRaw ? Number(sourceIdRaw) : undefined;
  if (sourceId !== undefined && !Number.isInteger(sourceId)) {
    return respond(event, 400, { error: 'invalid sourceId' });
  }
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
  return respond(event, 200, await refreshAllDueSources(getServerDb(), { sourceId, force }));
}
