// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node aggregation + rendering, shared by the public subscription export
 * (`server/utils/subscription.ts`) and the admin preview
 * (`server/utils/admin-preview.ts`).
 *
 * The cache-backed source aggregation lives here so the preview renders exactly
 * what `/s/:token` would, without going through token lookup, rate limiting or
 * access logging.
 */
import { asc, eq } from 'drizzle-orm';
import { parseSubscription, produceLegacy, produceMihomo, type ProxyNode } from '../../core';
import type { SubhubDb } from '../db';
import { sources, userSources } from '../db/schema';
import type { ExportTarget } from './targets';

interface CachedSource {
  id: number;
  cacheBlob: string | null;
}

/** Sources attached to a user, in their configured order. */
export function loadUserSourceCaches(db: SubhubDb, userId: number): CachedSource[] {
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
export function collectNodes(caches: CachedSource[]): ProxyNode[] {
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

/** Aggregate the cached sources of a user into proxy nodes. */
export function collectUserNodes(db: SubhubDb, userId: number): ProxyNode[] {
  return collectNodes(loadUserSourceCaches(db, userId));
}

/**
 * Render nodes for an export target. Targets without a dedicated producer yet
 * (P4) fall back to the mihomo YAML.
 */
export function renderTargetBody(target: ExportTarget, nodes: ProxyNode[]): string {
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
