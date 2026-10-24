// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription export handler shared by every `/s/...` route:
 *
 * - GET /s/:token                        (index.get.ts)
 * - GET /s/:token/:target                ([target].get.ts)
 * - GET /s/:token/:target/:profile       ([target]/[profile].get.ts)
 * - GET /s/:token/:profile               (index.get.ts, form 2 below)
 *
 * Kept as a plain module (not a `.get.ts` route file) so all of them can point
 * at the same handler.
 *
 * Resolution order for the 2nd path segment: it is a **target** when it names
 * one (targets win, even when a profile has the same name); otherwise it is
 * tried as a **profile override** with the User-Agent default target. A 2nd
 * segment that is neither a target nor a profile is a 404. A 3rd segment is
 * always the profile override and must name a profile (404 otherwise).
 */
import { getClientIpOrNull } from './client-ip';
import { getServerDb } from './db';
import { isExportTarget } from './targets';
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

/**
 * Build the export request from an H3 event.
 *
 * `event.context.params` is filled by Nitro per route file, so it differs by
 * route the handler serves; the raw path is the fallback and the only source
 * the segment-shape logic needs. Returning early on empty segments (trailing
 * slash, `//`) keeps `params` from guessing a route with fewer segments.
 *
 * Profile overrides (2nd/3rd segment): only the *shape* is decided here. A
 * non-target 2nd segment is reported in both `target` and `profile` so that
 * the export can try it as a profile name and otherwise reject it; the name is
 * always resolved against the database by the export itself (`null` when no
 * profile has it).
 *
 * The profile *name* is recorded on the request (not the id) so access logs and
 * error paths see exactly what the client asked for.
 */
export function requestFromEvent(event: ExportEvent): ExportRequest {
  const params = event.context.params ?? {};
  const path = (event.path ?? '').split('?')[0] ?? '';
  // `segments`: ['s', token, 2nd?, 3rd?]. The *shape* comes from the raw path
  // only: `context.params` varies per route file and would misread which
  // segment is which, so it is never consulted for this.
  const segments = path.split('/').filter(Boolean);
  const token = params.token ?? segments[1] ?? '';
  const second = segments[2] ?? null;
  const third = segments[3] ?? null;

  const secondIsTarget = !!second && isExportTarget(second);
  // Resolution order (a target wins in position 2):
  // - `/s/:token/:target` keeps its meaning when the 2nd segment is a target;
  // - without a target there, the 2nd segment may be the profile override
  //   (form 2) with the User-Agent default target, or just an unknown target —
  //   only the database can tell, so it is reported in `profile` as well and
  //   `handleSubscriptionExport` decides (unknown name -> today's 400);
  // - with a 3rd segment that is the profile override, so a profile named like
  //   a target stays addressable as `/clash/<name>`. A non-target 2nd segment
  //   stays the raw target there, keeping today's "unknown target" 400.
  const target = second;
  const profile = third ?? (secondIsTarget ? null : second);

  const userAgent = event.node.req.headers['user-agent'];
  return {
    token,
    target,
    profile,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent ?? null,
    // Same rule as the login throttle: socket by default, trusted header only
    // when SUBHUB_TRUSTED_IP_HEADER is set (see client-ip.ts).
    ip: getClientIpOrNull(event),
  };
}

/** GET /s/:token, /s/:token/:target, /s/:token/:target/:profile, /s/:token/:profile. */
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
