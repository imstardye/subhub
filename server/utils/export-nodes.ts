// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Node aggregation + rendering, shared by the public subscription export
 * (`server/utils/subscription.ts`) and the admin preview
 * (`server/utils/admin-preview.ts`).
 *
 * The cache-backed source aggregation lives here so the preview renders exactly
 * what `/s/:token` would, without going through token lookup, rate limiting or
 * access logging.
 *
 * Source sharing model: a source is either PUBLIC (`ownerUserId` null, included
 * for every user) or DEDICATED to exactly one user. A user's export is
 * dedicated sources of that user + all public sources, ordered dedicated-first
 * and then by source id. The legacy `user_sources` join table is no longer read
 * here.
 *
 * Profiles: when the user has a rule profile (`users.profileId`), the rendered
 * body also carries the profile's proxy groups, rules and rule-providers, so a
 * client gets a complete config instead of a bare `proxies` list.
 */
import { asc, eq, isNull, or } from 'drizzle-orm';
import {
  buildLegacyProxies,
  buildMihomoProxies,
  buildRules,
  parseIni,
  parseSubscription,
  produceLegacy,
  produceMihomo,
  type ProxyNode,
  type ProduceOptions,
  type ProxyGroupEntry,
} from '../../core';
import { stringify as stringifyYaml } from 'yaml';
import type { SubhubDb } from '../db';
import { profiles, sources, users } from '../db/schema';
import type { ExportTarget } from './targets';

interface CachedSource {
  id: number;
  cacheBlob: string | null;
}

/**
 * Sources visible to a user: their dedicated sources first, then every public
 * source; within each bucket by source id.
 */
export function loadUserSourceCaches(db: SubhubDb, userId: number): CachedSource[] {
  return db
    .select({ id: sources.id, cacheBlob: sources.cacheBlob })
    .from(sources)
    .where(or(eq(sources.ownerUserId, userId), isNull(sources.ownerUserId)))
    .orderBy(asc(sources.ownerUserId), asc(sources.id))
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

/** Resolve a profile's INI source. `null` when there is nothing usable. */
export type ProfileIniResolver = (profile: {
  iniText: string | null;
  iniUrl: string | null;
}) => Promise<string | null>;

/** Timeout for fetching `iniUrl`; a slow profile must not stall an export. */
export const PROFILE_FETCH_TIMEOUT_MS = 3_000;

/** Hard cap on a fetched INI (subconverter profiles are a few KiB). */
export const PROFILE_INI_MAX_BYTES = 256 * 1024;

/**
 * Default INI resolver: inline `iniText` wins, otherwise `iniUrl` is fetched
 * with a short timeout. Any failure (network, HTTP status, oversize body)
 * resolves to `null`, which means "no profile" — never an export error.
 */
export const fetchProfileIni: ProfileIniResolver = async (profile) => {
  const inline = profile.iniText?.trim();
  if (inline) return inline;
  const url = profile.iniUrl?.trim();
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROFILE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.trim() || Buffer.byteLength(text, 'utf8') > PROFILE_INI_MAX_BYTES) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Rule/profile data attached to an export (built from the INI). */
export interface ExportProfile {
  ruleProviders: Record<string, unknown>;
  rules: string[];
  proxyGroups: unknown[];
  /** Group names declared by the profile, in order. */
  groupNames: string[];
}

/** Use legacy Clash (not mihomo) semantics for nodes and rules? */
function isLegacyTarget(target: ExportTarget): boolean {
  return target === 'clash';
}

/**
 * Nodes exactly as the target's producer will emit them (transformed and, for
 * legacy Clash, filtered). Profile group members are expanded against *these*
 * names — the raw parsed names differ (e.g. `tls-fingerprint` -> `fingerprint`)
 * and nodes legacy cannot load disappear. Both paths run the same producer
 * code, so the export and the profile groups always agree.
 */
export function buildTargetProxies(
  target: ExportTarget,
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): ProxyNode[] {
  return isLegacyTarget(target)
    ? buildLegacyProxies(nodes, options)
    : buildMihomoProxies(nodes, options);
}

/**
 * Load and parse the rule profile assigned to a user. Missing user, missing
 * profileId, missing/removed profile row, unreadable INI or an unexpected
 * error all yield `null` (today's nodes-only behaviour).
 */
export async function loadUserProfile(
  db: SubhubDb,
  userId: number,
  exportTarget: ExportTarget,
  resolveIni: ProfileIniResolver = fetchProfileIni,
  nodeNames: string[] = [],
): Promise<ExportProfile | null> {
  try {
    // users.profileId -> profiles.id; a disabled export path only reaches an
    // enabled user, but the lookup works for any existing user id.
    const link = db
      .select({ profileId: users.profileId })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!link?.profileId) return null;

    const row = db.select().from(profiles).where(eq(profiles.id, link.profileId)).get();
    if (!row) return null;

    const iniText = await resolveIni({ iniText: row.iniText ?? null, iniUrl: row.iniUrl ?? null });
    if (!iniText) return null;

    const ini = parseIni(iniText);
    // The profile variant decides which Clash dialect the rules target; the
    // export target only picks the node producer (see `withProfile`).
    const ruleTarget = (row.variant ?? 'mihomo') === 'legacy' ? 'legacy' : 'mihomo';
    // Regex group members are expanded against the exported node names (the
    // producer output, see `buildTargetProxies`), exactly like the rules tests.
    const built = buildRules(ini, { target: ruleTarget, nodeNames });
    // An empty profile (no groups, no rules) must not turn the export into an
    // empty-rule config; keep today's nodes-only output instead.
    if (built.proxyGroups.length === 0 && built.rules.length === 0) return null;

    return {
      ruleProviders: built.ruleProviders,
      rules: built.rules,
      proxyGroups: built.proxyGroups,
      groupNames: ini.groups.map((group: ProxyGroupEntry) => group.name),
    };
  } catch {
    return null;
  }
}

/**
 * Render nodes for an export target. Targets without a dedicated producer yet
 * (P4) fall back to the mihomo YAML.
 *
 * `profile` (from `loadUserProfile`) is optional: with it the body also carries
 * the profile's proxy groups, rules and mihomo rule-providers. Without one the
 * output is exactly the nodes-only body of before.
 */
export function renderTargetBody(
  target: ExportTarget,
  nodes: ProxyNode[],
  options: ProduceOptions = {},
  profile: ExportProfile | null = null,
): string {
  const legacy = isLegacyTarget(target);
  const produce = legacy ? produceLegacy : produceMihomo;
  const body = produce(nodes, options);
  if (!profile) return body;

  const sections: Record<string, unknown> = {};
  // Legacy Clash cannot load rule-providers; mihomo references them by name.
  if (!legacy && Object.keys(profile.ruleProviders).length > 0) {
    sections['rule-providers'] = profile.ruleProviders;
  }
  if (profile.proxyGroups.length > 0) sections['proxy-groups'] = profile.proxyGroups;
  if (profile.rules.length > 0) sections.rules = profile.rules;
  if (Object.keys(sections).length === 0) return body;

  // Reuse the producer for the proxies block (so both variants keep their
  // pretty/compact format) and append the profile sections after it.
  const head = body.endsWith('\n') || body === '' ? body : `${body}\n`;
  const tail = stringifyYaml(sections, { lineWidth: 0, aliasDuplicateObjects: false });
  return `${head}${tail}`;
}
