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
 * Source sharing model (v2): a source is exactly one of
 * - DEDICATED (专属): `ownerUserId` set; included for that owner only;
 * - PUBLIC (公共): `ownerUserId` null + `accessMode` 'all'; included for every
 *   user;
 * - SHARED (共享): `ownerUserId` null + `accessMode` 'restricted'; included only
 *   for the users listed in `source_allowed_users` (an empty allowlist reaches
 *   nobody).
 *
 * A user's export is therefore dedicated(owner=self) + public + shared(self in
 * allowlist), ordered dedicated-first, then shared/public by source id. The
 * legacy `user_sources` join table is unrelated and never read here.
 *
 * Profiles: when the user has a rule profile (`users.profileId`), the rendered
 * body also carries the profile's proxy groups, rules and rule-providers, so a
 * client gets a complete config instead of a bare `proxies` list.
 */
import { and, eq, exists, isNull, or } from 'drizzle-orm';
import {
  buildLegacyProxies,
  buildLoonProxies,
  buildMihomoProxies,
  buildRules,
  buildShadowrocketSubscription,
  buildSurgeProxies,
  parseIni,
  parseSubscription,
  produceLegacy,
  produceLoon,
  produceMihomo,
  produceMihomoProxiesOnly,
  produceShadowrocket,
  produceSurge,
  prepareNode,
  stringifyMihomoConfig,
  type ClashProxyGroup,
  type ProxyNode,
  type ProduceOptions,
  type ProxyGroupEntry,
} from '../../core';
import { stringify as stringifyYaml } from 'yaml';
import type { SubhubDb } from '../db';
import { profiles, sourceAllowedUsers, sources, users } from '../db/schema';
import type { ExportTarget } from './targets';

interface CachedSource {
  id: number;
  cacheBlob: string | null;
}

/**
 * Sources visible to a user: their dedicated sources first, then the shared
 * ones whose allowlist contains them, then the public ones; within each bucket
 * by source id.
 *
 * The predicate mirrors the access model exactly:
 *   owner_user_id = :user
 *   OR (owner_user_id IS NULL AND access_mode = 'all')
 *   OR (owner_user_id IS NULL AND access_mode = 'restricted' AND user is
 *       listed in source_allowed_users for this source)
 */
export function loadUserSourceCaches(db: SubhubDb, userId: number): CachedSource[] {
  const sharedWithUser = exists(
    db
      .select({ one: sourceAllowedUsers.sourceId })
      .from(sourceAllowedUsers)
      .where(
        and(
          eq(sourceAllowedUsers.sourceId, sources.id),
          eq(sourceAllowedUsers.userId, userId),
        ),
      ),
  );
  const rows = db
    .select({
      id: sources.id,
      cacheBlob: sources.cacheBlob,
      ownerUserId: sources.ownerUserId,
      accessMode: sources.accessMode,
    })
    .from(sources)
    .where(
      or(
        eq(sources.ownerUserId, userId),
        and(isNull(sources.ownerUserId), eq(sources.accessMode, 'all')),
        and(
          isNull(sources.ownerUserId),
          eq(sources.accessMode, 'restricted'),
          sharedWithUser,
        ),
      ),
    )
    .all();

  // Ordered here, not in SQL: SQLite sorts NULL before integers, so an
  // `ORDER BY owner_user_id` would put the public/shared rows first. Buckets:
  // dedicated (0) < shared (1) < public (2), each by source id.
  const bucket = (row: (typeof rows)[number]) =>
    row.ownerUserId === null && row.accessMode === 'restricted' ? 1 : row.ownerUserId === null ? 2 : 0;
  return rows
    .sort((a, b) => bucket(a) - bucket(b) || a.id - b.id)
    .map((row) => ({ id: row.id, cacheBlob: row.cacheBlob }));
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
  /**
   * Proxy groups. For surge/loon these are passed through `buildProxyGroups`
   * and only their members (remapped with loon group types) matter, so they
   * are read as the loose client shape; mihomo/clash serialise them as-is.
   */
  proxyGroups: ClashProxyGroup[];
  /** Group names declared by the profile, in order. */
  groupNames: string[];
  /**
   * The profile's raw `dns:` template, if it has one. Applied by the mihomo
   * renderer only; it replaces the built-in DNS section (invalid YAML falls
   * back to the built-in).
   */
  dnsTemplate?: string | null;
}

/** Use legacy Clash (not mihomo) semantics for nodes and rules? */
function isLegacyTarget(target: ExportTarget): boolean {
  return target === 'clash';
}

/** Which subset of `ExportProfile` a target's producer consumes. */
export type ProfileCapability = 'groups' | 'rules' | 'none';

/**
 * Rules and rule-providers are mihomo/Clash syntax and mean nothing to the
 * line-based clients; they own their rules. Shadowrocket subscriptions carry
 * nodes only. Surge and loon consume the profile's proxy groups.
 */
export function exportProfileCapability(target: ExportTarget): ProfileCapability {
  if (target === 'shadowrocket') return 'none';
  if (target === 'surge' || target === 'loon') return 'groups';
  return 'rules';
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
  if (isLegacyTarget(target)) return buildLegacyProxies(nodes, options);
  if (target === 'shadowrocket' || target === 'surge' || target === 'loon') {
    // These producers drop what the client cannot load; expand the profile
    // group regexes against what actually survives (`targetProxyNames`).
    return nodes.map((node) => prepareNode(node));
  }
  return buildMihomoProxies(nodes, options);
}

/**
 * Names a target's producer will emit, in order. Profile group regexes are
 * expanded against exactly these, so a group never points at a node the
 * output dropped (e.g. a VLESS node in a Surge export).
 */
export function targetProxyNames(target: ExportTarget, nodes: ProxyNode[]): string[] {
  switch (target) {
    case 'shadowrocket':
      return buildShadowrocketSubscription(nodes).names;
    case 'surge':
      return buildSurgeProxies(nodes).names;
    case 'loon':
      return buildLoonProxies(nodes).names;
    default:
      return buildTargetProxies(target, nodes)
        .map((node) => node.name)
        .filter(Boolean);
  }
}

/**
 * Load and parse the rule profile assigned to a user. Missing user, missing
 * profileId, missing/removed profile row, unreadable INI or an unexpected
 * error all yield `null` (today's nodes-only behaviour).
 *
 * What the export does with it depends on the target
 * (`exportProfileCapability`): shadowrocket ignores profiles entirely (its
 * subscription is nodes-only), surge/loon use the proxy groups only, and
 * mihomo/clash use groups + rules + rule-providers.
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

    const capability = exportProfileCapability(exportTarget);
    if (capability === 'none') return null;
    if (capability === 'groups' && built.proxyGroups.length === 0) return null;

    return {
      ruleProviders: built.ruleProviders,
      rules: built.rules,
      proxyGroups: built.proxyGroups,
      groupNames: ini.groups.map((group: ProxyGroupEntry) => group.name),
      // Raw text only: the core parses it at render time and silently falls
      // back to the built-in DNS section when it is not a YAML mapping.
      dnsTemplate: row.dnsTemplate ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Render nodes for an export target.
 *
 * - mihomo / clash: YAML with the anti-leak DNS/QUIC template and the profile's
 *   groups, rules and rule-providers.
 * - shadowrocket: base64 of newline-joined share links (nodes only).
 * - surge / loon: `[Proxy]` + `[Proxy Group]` text; the profile contributes the
 *   groups only (rules belong to the client's own template) and references to
 *   nodes the client cannot load are pruned.
 * - everything else (sing-box, uri) still falls back to the historical mihomo
 *   nodes-only YAML: the DNS/QUIC template is a mihomo (Clash.Meta) feature
 *   those clients cannot load.
 *
 * `profile` (from `loadUserProfile`) is optional; without one the output is the
 * bare nodes document.
 *
 * Emitted section order (mihomo): `dns`, `proxies`, `rule-providers`,
 * `proxy-groups`, `rules`. The QUIC block is always the first entry of `rules`
 * (with or without a profile, and never duplicated when the profile already
 * blocks QUIC); `profile.dnsTemplate` replaces the built-in `dns` section.
 */
export function renderTargetBody(
  target: ExportTarget,
  nodes: ProxyNode[],
  options: ProduceOptions = {},
  profile: ExportProfile | null = null,
): string {
  if (isLegacyTarget(target)) return renderLegacyBody(nodes, options, profile);
  if (target === 'shadowrocket') return produceShadowrocket(nodes);
  if (target === 'surge') return produceSurge(nodes, profile?.proxyGroups ?? []);
  if (target === 'loon') return produceLoon(nodes, profile?.proxyGroups ?? []);

  // The remaining targets (P4) still fall back to mihomo YAML; they must stay
  // exactly what they produced before this template existed.
  if (target !== 'mihomo') return renderMihomoFallbackBody(nodes, options, profile);

  const dnsOptions: ProduceOptions = {
    ...options,
    ...(profile?.dnsTemplate ? { dnsTemplate: profile.dnsTemplate } : {}),
  };

  if (!profile) {
    // No profile: dns + proxies + the leading (QUIC) rules.
    return produceMihomo(nodes, dnsOptions);
  }

  const sections: Record<string, unknown> = {};
  // Legacy Clash cannot load rule-providers; mihomo references them by name.
  if (Object.keys(profile.ruleProviders).length > 0) {
    sections['rule-providers'] = profile.ruleProviders;
  }
  if (profile.proxyGroups.length > 0) sections['proxy-groups'] = profile.proxyGroups;

  // The producer owns the `rules` block so the QUIC rule can be prepended in
  // front of every profile rule (and de-duplicated) in one place.
  const head = stringifyMihomoConfig(
    buildMihomoProxies(nodes, dnsOptions),
    dnsOptions,
    profile.rules,
  );
  if (Object.keys(sections).length === 0) return head;

  return `${head}${stringifyYaml(sections, { lineWidth: 0, aliasDuplicateObjects: false })}`;
}

/** Legacy Clash: nodes-only `proxies` (no DNS, no injected rules). */
function renderLegacyBody(
  nodes: ProxyNode[],
  options: ProduceOptions,
  profile: ExportProfile | null,
): string {
  const body = produceLegacy(nodes, options);
  if (!profile) return body;

  const sections: Record<string, unknown> = {};
  if (profile.proxyGroups.length > 0) sections['proxy-groups'] = profile.proxyGroups;
  if (profile.rules.length > 0) sections.rules = profile.rules;
  if (Object.keys(sections).length === 0) return body;

  const head = body.endsWith('\n') || body === '' ? body : `${body}\n`;
  const tail = stringifyYaml(sections, { lineWidth: 0, aliasDuplicateObjects: false });
  return `${head}${tail}`;
}

/** Unimplemented P4 targets: the historical mihomo nodes-only YAML. */
function renderMihomoFallbackBody(
  nodes: ProxyNode[],
  options: ProduceOptions,
  profile: ExportProfile | null,
): string {
  const body = produceMihomoProxiesOnly(nodes, options);
  if (!profile) return body;

  const sections: Record<string, unknown> = {};
  if (Object.keys(profile.ruleProviders).length > 0) {
    sections['rule-providers'] = profile.ruleProviders;
  }
  if (profile.proxyGroups.length > 0) sections['proxy-groups'] = profile.proxyGroups;
  if (profile.rules.length > 0) sections.rules = profile.rules;
  if (Object.keys(sections).length === 0) return body;

  const head = body.endsWith('\n') || body === '' ? body : `${body}\n`;
  const tail = stringifyYaml(sections, { lineWidth: 0, aliasDuplicateObjects: false });
  return `${head}${tail}`;
}
