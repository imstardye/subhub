// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription export handler shared by GET /s/:token and
 * GET /s/:token/:target.
 *
 * Kept as a plain module (not a `.get.ts` route file) so both
 * `server/routes/s/[token]/index.get.ts` and
 * `server/routes/s/[token]/[target].get.ts` can point at the same handler.
 */
import { getClientIpOrNull } from './client-ip';
import { getServerDb } from './db';
import { handleSubscriptionExport, type ExportRequest } from './subscription';

/** Minimal H3 event shape we rely on (avoids a direct `h3` dependency). */
interface ExportEvent {
  path?: string;
  context: {
    params?: Record<string, string | undefined>;
    clientAddress?: string;
  };
  node: {
    req: {
      headers: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string | null };
    };
    res: {
      statusCode: number;
      setHeader(name: string, value: string | number | string[]): unknown;
    };
  };
}

/** Build the export request from an H3 event. */
export function requestFromEvent(event: ExportEvent): ExportRequest {
  // `event.context.params` is filled by Nitro for `/s/:token/:target`.
  const params = event.context.params ?? {};
  const path = (event.path ?? '').split('?')[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const token = params.token ?? segments[1] ?? '';
  const target = params.target ?? segments[2] ?? null;

  const userAgent = event.node.req.headers['user-agent'];
  return {
    token,
    target,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent ?? null,
    // Same rule as the login throttle: socket by default, trusted header only
    // when SUBHUB_TRUSTED_IP_HEADER is set (see client-ip.ts).
    ip: getClientIpOrNull(event),
  };
}

/** GET /s/:token and /s/:token/:target. */
export default async function subscriptionExportHandler(event: ExportEvent): Promise<string> {
  const result = await handleSubscriptionExport(requestFromEvent(event), {
    // One better-sqlite3 handle per process; see server/utils/db.ts.
    db: getServerDb(),
  });
  event.node.res.statusCode = result.status;
  for (const [name, value] of Object.entries(result.headers)) {
    event.node.res.setHeader(name, value);
  }
  event.node.res.setHeader('content-length', Buffer.byteLength(result.body, 'utf8'));
  return result.body;
}
