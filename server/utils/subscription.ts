// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription export logic, kept free of Nuxt/crypto globals so the route is a
 * thin wrapper and the behaviour is unit-testable.
 *
 * P2 scope: user lookup, per-token rate limiting, cache-backed source
 * aggregation (the refresh task fills `cache_blob`) and access logging.
 * `singbox` and `uri` have real producers; shadowrocket/surge/loon still fall
 * back to the mihomo YAML (see P4 note below and `targets.ts`).
 *
 * The user's rule profile (`users.profileId`) is applied on top of the nodes:
 * its proxy groups, rules and rule-providers are appended to the rendered YAML.
 * No profile — or a broken/unreachable one — keeps the plain nodes-only body.
 */
import { and, eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { accessLogs, users } from '../db/schema';
import {
  buildTargetProxies,
  collectUserNodes,
  collectUserUserInfo,
  loadUserProfile,
  renderTargetBody,
  type ProfileIniResolver,
} from './export-nodes';
import { formatUserInfo, type SubscriptionUserInfo } from './userinfo';
import {
  contentTypeForTarget,
  fileNameExtensionFor,
  isExportTarget,
  type ExportTarget,
} from './targets';
import {
  createRateLimiter,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_KEYS,
  RATE_LIMIT_WINDOW_MS,
} from './rate-limit';

// Re-exported for the existing route/tests; the definitions live in targets.ts.
export { EXPORT_TARGETS, isExportTarget } from './targets';
export type { ExportTarget, FallbackTarget } from './targets';

/**
 * Pick a target from the User-Agent when the path does not specify one.
 * Deliberately coarse: only the obvious clients are matched, everything else
 * gets mihomo.
 */
export function detectTargetFromUserAgent(ua: string | null | undefined): ExportTarget {
  const value = (ua ?? '').toLowerCase();
  if (!value) return 'mihomo';
  if (value.includes('shadowrocket')) return 'shadowrocket';
  if (value.includes('sing-box') || value.includes('singbox')) return 'singbox';
  if (value.includes('surge')) return 'surge';
  if (value.includes('loon')) return 'loon';
  if (value.includes('clash')) return 'clash';
  return 'mihomo';
}

/** Access-log/IP column cap; the exported handler already normalises the value. */
const MAX_IP_LENGTH = 64;

/** Guard against abuse of the unauthenticated path before the token is checked. */
const MAX_TOKEN_LENGTH = 128;

const rateLimiter = createRateLimiter({
  max: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxKeys: RATE_LIMIT_MAX_KEYS,
});

/**
 * Bucket for requests whose token is unknown/disabled. Keyed by IP instead of
 * the raw token so made-up tokens cannot create one map entry each.
 */
const unknownTokenLimiter = createRateLimiter({
  max: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxKeys: RATE_LIMIT_MAX_KEYS,
});

/** Fallback bucket key when the socket address is unavailable. */
const UNKNOWN_IP_KEY = 'ip:unknown';

/** Replace the in-process limiters with fresh ones (tests only). */
export function resetExportRateLimiter(): void {
  rateLimiter.reset();
  unknownTokenLimiter.reset();
}

/** Total tracked keys across both limiters (tests/diagnostics). */
export function exportRateLimiterSize(): number {
  return rateLimiter.size() + unknownTokenLimiter.size();
}

export interface ExportRequest {
  token: string;
  /** Raw `:target` path segment; empty when the client omitted it. */
  target?: string | null;
  userAgent?: string | null;
  ip?: string | null;
}

export interface ExportResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const TEXT_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function textResponse(status: number, body: string, headers: Record<string, string> = {}): ExportResult {
  return {
    status,
    headers: {
      ...TEXT_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      ...headers,
    },
    body,
  };
}

/**
 * Resolve the export target. An explicit but unknown target is a client error
 * (400) rather than a silent mihomo fallback, so typos in client configs are
 * visible.
 */
export function resolveTarget(
  target: string | null | undefined,
  userAgent: string | null | undefined,
): ExportTarget | null {
  const explicit = (target ?? '').trim().toLowerCase();
  if (!explicit) return detectTargetFromUserAgent(userAgent);
  return isExportTarget(explicit) ? explicit : null;
}

function fileNameFor(target: ExportTarget, user: { id: number }): string {
  return `subhub-${user.id}-${target}.${fileNameExtensionFor(target)}`;
}

function logAccess(
  db: SubhubDb,
  entry: {
    userId: number | null;
    target: string | null;
    userAgent: string | null | undefined;
    ip: string | null | undefined;
    status: number;
    startedAt: number;
  },
): void {
  try {
    db.insert(accessLogs)
      .values({
        userId: entry.userId,
        target: entry.target,
        // Keep the UA column bounded; it is client-controlled.
        ua: entry.userAgent ? entry.userAgent.slice(0, 512) : null,
        ip: entry.ip ? entry.ip.slice(0, MAX_IP_LENGTH) : null,
        status: entry.status,
        ms: Math.max(0, Date.now() - entry.startedAt),
      })
      .run();
  } catch {
    // Access logging must never break the export.
  }
}

export interface ExportDeps {
  /**
   * Database handle. Required on purpose: `server/db`'s `openDb()` is not
   * memoised, so a per-request default would leak SQLite handles. The Nitro
   * handler passes the process-wide handle from `server/utils/db.ts`; tests
   * inject their temporary database.
   */
  db?: SubhubDb;
  /** Clock override for tests. */
  now?: () => number;
  /**
   * Override how a profile's INI is resolved (tests never hit the network;
   * the default handles `iniText` and fetches `iniUrl` with a short timeout).
   */
  resolveProfileIni?: ProfileIniResolver;
}

/**
 * Handle GET /s/:token[/:target].
 *
 * Order of checks:
 *  1. empty / over-long token -> 404 (no lookup, no log)
 *  2. user lookup
 *  3. per-token limit for known users, per-IP limit for unknown/disabled
 *     tokens (so fake tokens cannot inflate the limiter map) -> 429
 *  4. missing or disabled user -> 404 (+ access log)
 *  5. build the subscription -> 200
 */
export async function handleSubscriptionExport(
  request: ExportRequest,
  deps: ExportDeps = {},
): Promise<ExportResult> {
  const startedAt = (deps.now ?? Date.now)();
  const token = request.token ?? '';
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return textResponse(404, 'Not Found\n');
  }

  if (!deps.db) throw new Error('subscription export requires a database handle');
  const db = deps.db;
  const user = db
    .select()
    .from(users)
    .where(and(eq(users.token, token), eq(users.enabled, true)))
    .get();

  // Unknown tokens share an IP bucket: one map entry per client, not per
  // attacker-chosen token.
  const limit = user
    ? rateLimiter.consume(token)
    : unknownTokenLimiter.consume(request.ip ? `ip:${request.ip}` : UNKNOWN_IP_KEY);
  if (!limit.allowed) {
    logAccess(db, {
      userId: user?.id ?? null,
      target: request.target ?? null,
      userAgent: request.userAgent,
      ip: request.ip,
      status: 429,
      startedAt,
    });
    return textResponse(429, 'Too Many Requests\n', {
      'retry-after': String(limit.retryAfter ?? Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
      'x-ratelimit-limit': String(RATE_LIMIT_MAX),
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(limit.resetAt / 1000)),
    });
  }

  const rateHeaders: Record<string, string> = {
    'x-ratelimit-limit': String(RATE_LIMIT_MAX),
    'x-ratelimit-remaining': String(limit.remaining),
    'x-ratelimit-reset': String(Math.ceil(limit.resetAt / 1000)),
  };

  if (!user) {
    // Unknown and disabled users are indistinguishable on purpose.
    logAccess(db, {
      userId: null,
      target: request.target ?? null,
      userAgent: request.userAgent,
      ip: request.ip,
      status: 404,
      startedAt,
    });
    return textResponse(404, 'Not Found\n', rateHeaders);
  }

  const target = resolveTarget(request.target, request.userAgent);
  if (!target) {
    logAccess(db, {
      userId: user.id,
      target: request.target ?? null,
      userAgent: request.userAgent,
      ip: request.ip,
      status: 400,
      startedAt,
    });
    return textResponse(400, 'Unknown target\n', rateHeaders);
  }

  let body: string;
  // Aggregated over the same sources the export merges (see export-nodes.ts).
  // `null` -> no `subscription-userinfo` header at all, never a fake 0/0/0.
  let userinfo: SubscriptionUserInfo | null;
  try {
    const nodes = collectUserNodes(db, user.id);
    // Group regexes (`.*`, `((?i)hk)`, ...) are expanded against the names the
    // producer will emit, i.e. after transformation/filtering.
    const nodeNames = buildTargetProxies(target, nodes)
      .map((node) => node.name)
      .filter(Boolean);
    const profile = await loadUserProfile(db, user.id, target, deps.resolveProfileIni, nodeNames);
    body = renderTargetBody(target, nodes, {}, profile);
    userinfo = collectUserUserInfo(db, user.id);
  } catch {
    logAccess(db, {
      userId: user.id,
      target,
      userAgent: request.userAgent,
      ip: request.ip,
      status: 500,
      startedAt,
    });
    return textResponse(500, 'Internal Server Error\n', rateHeaders);
  }

  logAccess(db, {
    userId: user.id,
    target,
    userAgent: request.userAgent,
    ip: request.ip,
    status: 200,
    startedAt,
  });

  return {
    status: 200,
    headers: {
      // Same hardening as the text error paths (notably `cache-control: no-store`).
      ...TEXT_HEADERS,
      'content-type': contentTypeForTarget(target),
      'content-disposition': `attachment; filename="${fileNameFor(target, user)}"`,
      'profile-update-interval': '24',
      'profile-web-page-url': 'https://github.com/imstardye/subhub',
      // Only the parts some source actually reported (`upload=…; download=…;
      // total=…; expire=…`); omitted entirely when no source has any.
      ...(userinfo ? { 'subscription-userinfo': formatUserInfo(userinfo) } : {}),
      ...rateHeaders,
    },
    body,
  };
}
