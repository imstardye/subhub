// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription export logic, kept free of Nuxt/crypto globals so the route is a
 * thin wrapper and the behaviour is unit-testable.
 *
 * P2 scope: user lookup, per-token rate limiting, cache-backed source
 * aggregation (the refresh task fills `cache_blob`) and access logging. The
 * remaining targeted producers (shadowrocket/singbox/surge/loon/uri) are still
 * missing; unsupported targets fall back to the mihomo YAML (see P4 note
 * below).
 */
import { and, asc, eq } from 'drizzle-orm';
import { parseSubscription, produceMihomo, produceLegacy, type ProxyNode } from '../../core';
import type { SubhubDb } from '../db';
import { accessLogs, sources, userSources, users } from '../db/schema';
import {
  createRateLimiter,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_KEYS,
  RATE_LIMIT_WINDOW_MS,
} from './rate-limit';

/** Targets accepted by /s/:token/:target (SPEC: 订阅出口). */
export const EXPORT_TARGETS = [
  'mihomo',
  'clash',
  'shadowrocket',
  'singbox',
  'surge',
  'loon',
  'uri',
] as const;

export type ExportTarget = (typeof EXPORT_TARGETS)[number];

/** A target that still falls back to mihomo YAML (P4 TODO). */
export type FallbackTarget = Exclude<ExportTarget, 'mihomo' | 'clash'>;

export function isExportTarget(value: string): value is ExportTarget {
  return (EXPORT_TARGETS as readonly string[]).includes(value);
}

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

/** Placeholder subscription-userinfo until sources are aggregated (P2 cache task). */
export const PLACEHOLDER_USERINFO = 'upload=0; download=0; total=0; expire=0';

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

interface CachedSource {
  id: number;
  cacheBlob: string | null;
}

/** Sources attached to a user, in their configured order. */
function loadUserSourceCaches(db: SubhubDb, userId: number): CachedSource[] {
  return db
    .select({ id: sources.id, cacheBlob: sources.cacheBlob })
    .from(userSources)
    .innerJoin(sources, eq(sources.id, userSources.sourceId))
    .where(eq(userSources.userId, userId))
    .orderBy(asc(userSources.sort), asc(sources.id))
    .all();
}

/**
 * Parse cached payloads into nodes, in the user's source order. Cache blobs are
 * the raw provider response (share links, base64 or Clash YAML), so they go
 * through `parseSubscription`. A broken cache entry only drops that source; the
 * export must still succeed with whatever remains.
 */
function collectNodes(caches: CachedSource[]): ProxyNode[] {
  const nodes: ProxyNode[] = [];
  for (const entry of caches) {
    const blob = entry.cacheBlob?.trim();
    if (!blob) continue;
    try {
      nodes.push(...parseSubscription(blob));
    } catch {
      // Cache is stale/invalid; the refresh task will replace it.
    }
  }
  return nodes;
}

function renderBody(target: ExportTarget, nodes: ProxyNode[]): string {
  switch (target) {
    case 'clash':
      return produceLegacy(nodes);
    case 'shadowrocket':
    case 'singbox':
    case 'surge':
    case 'loon':
    case 'uri':
      // P4: dedicated producers for these targets are not implemented yet, so
      // clients receive the mihomo YAML as a placeholder.
      return produceMihomo(nodes);
    case 'mihomo':
    default:
      return produceMihomo(nodes);
  }
}

function fileNameFor(target: ExportTarget, user: { id: number }): string {
  return `subhub-${user.id}-${target}.yaml`;
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
        ip: entry.ip ? entry.ip.slice(0, 64) : null,
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
export function handleSubscriptionExport(
  request: ExportRequest,
  deps: ExportDeps = {},
): ExportResult {
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
  try {
    body = renderBody(target, collectNodes(loadUserSourceCaches(db, user.id)));
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
      'content-type': 'text/yaml; charset=utf-8',
      'content-disposition': `attachment; filename="${fileNameFor(target, user)}"`,
      'profile-update-interval': '24',
      'profile-web-page-url': 'https://github.com/imstardye/subhub',
      'subscription-userinfo': PLACEHOLDER_USERINFO,
      ...rateHeaders,
    },
    body,
  };
}
