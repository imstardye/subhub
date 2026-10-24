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
 * Inclusion override (user center, `user_source_choices`): a public/shared
 * source is included unless this user explicitly set `included = false` for it.
 * Dedicated sources are never choosable and never filtered. With no rows the
 * result is exactly the pre-override set.
 *
 * Profiles: when the user has a rule profile (`users.profileId`), the rendered
 * body also carries the profile's proxy groups, rules and rule-providers, so a
 * client gets a complete config instead of a bare `proxies` list.
 */
import { and, eq, exists, isNull, or } from 'drizzle-orm';
import {
  buildLoonProxies,
  buildMihomoProxies,
  buildRules,
  buildShadowrocketSubscription,
  buildSurgeProxies,
  excludeRemarkNodes,
  parseIni,
  parseSubscription,
  produceLoon,
  produceMihomo,
  produceMihomoProxiesOnly,
  produceShadowrocket,
  produceSingbox,
  produceSurge,
  produceUri,
  prepareNode,
  stringifyMihomoConfig,
  type ClashProxyGroup,
  type ProxyNode,
  type ProduceOptions,
  type ProxyGroupEntry,
} from '../../core';
import { stringify as stringifyYaml } from 'yaml';
import type { SubhubDb } from '../db';
import { profiles, sourceAllowedUsers, sources, userSourceChoices, users } from '../db/schema';
import { isFallbackTarget, type ExportTarget } from './targets';
import { aggregateUserInfo, type SubscriptionUserInfo } from './userinfo';

interface CachedSource {
  id: number;
  cacheBlob: string | null;
  /** Stored `subscription-userinfo` parts (see `userinfo.ts`). */
  userinfo?: SubscriptionUserInfo | null;
}

/**
 * True when a source was paused (`sources.enabled` 0/false). NULL, 1 and `true`
 * are enabled — the column was added after the fact and must not hide rows.
 */
export function isSourceDisabled(row: { enabled?: boolean | number | null }): boolean {
  return row.enabled === false || row.enabled === 0;
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
  // Explicit "do not include" choices of this user (only public/shared sources
  // can have a row; a dedicated source is always in).
  const excluded = new Set(
    db
      .select({ sourceId: userSourceChoices.sourceId })
      .from(userSourceChoices)
      .where(and(eq(userSourceChoices.userId, userId), eq(userSourceChoices.included, false)))
      .all()
      .map((row) => row.sourceId),
  );


  const rows = db
    .select({
      id: sources.id,
      cacheBlob: sources.cacheBlob,
      ownerUserId: sources.ownerUserId,
      accessMode: sources.accessMode,
      enabled: sources.enabled,
      userinfoUpload: sources.userinfoUpload,
      userinfoDownload: sources.userinfoDownload,
      userinfoTotal: sources.userinfoTotal,
      userinfoExpire: sources.userinfoExpire,
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
  // A source its owner/admin PAUSED (user center toggle) leaves every export;
  // NULL reads as enabled, so rows from before the column behave as before.
  return rows
    .filter((row) => !isSourceDisabled(row))
    .filter((row) => row.ownerUserId !== null || !excluded.has(row.id))
    .sort((a, b) => bucket(a) - bucket(b) || a.id - b.id)
    .map((row) => ({
      id: row.id,
      cacheBlob: row.cacheBlob,
      userinfo: {
        upload: row.userinfoUpload ?? null,
        download: row.userinfoDownload ?? null,
        total: row.userinfoTotal ?? null,
        expire: row.userinfoExpire ?? null,
      },
    }));
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
 * Aggregate `subscription-userinfo` over exactly the sources an export merges
 * (same `loadUserSourceCaches` query), or `null` when none of them has any
 * stored value — then the export emits no header at all.
 */
export function collectUserUserInfo(
  db: SubhubDb,
  userId: number,
): SubscriptionUserInfo | null {
  return aggregateUserInfo(loadUserSourceCaches(db, userId).map((entry) => entry.userinfo));
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
 * Nodes exactly as the target's producer will emit them (transformed; nothing
 * is filtered). Profile group members are expanded against *these* names — the
 * raw parsed names differ (e.g. `tls-fingerprint` -> `fingerprint`) — so the
 * export and the profile groups always agree.
 *
 * `clash` is rendered by the mihomo producer (see `renderTargetBody`): modern
 * Clash clients are mihomo-based, and the legacy filter used to drop every
 * modern protocol (vless/anytls/tuic/hysteria2), leaving such users with an
 * empty `proxies: []`. The target is kept in the signature so callers do not
 * have to special-case the unimplemented P4 fallbacks.
 */
export function buildTargetProxies(
  target: ExportTarget,
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): ProxyNode[] {
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
 * Result of `loadUserProfile`: the profile to render with, plus the node list
 * to render it for. `nodes` is the input minus the nodes matched by the
 * profile's `[common] exclude_remarks` (identical when there is no such
 * pattern), so callers must render with these nodes — never the raw ones.
 */
export interface LoadedUserProfile {
  profile: ExportProfile;
  nodes: ProxyNode[];
}

/**
 * Resolve a profile *name* (the trailing URL segment of
 * `/s/:token/:target/:profile` and the admin preview's `profile` field) to its
 * id. Exact, case-sensitive match on `profiles.name`; `null` when no profile
 * has that name, so callers can answer 404 instead of silently falling back to
 * the user's assigned profile.
 */
export function resolveProfileIdByName(db: SubhubDb, name: string): number | null {
  if (!name) return null;
  const row = db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.name, name))
    .get();
  return row?.id ?? null;
}

/**
 * Load and parse the rule profile assigned to a user, applying its
 * `[common] exclude_remarks` filter to `nodes`. An explicit `profileId`
 * overrides the assignment (the URL's profile-name suffix; see
 * `resolveProfileIdByName`).
 *
 * Missing user, missing profileId, missing/removed profile row, unreadable INI
 * or an unexpected error all yield `null` (today's nodes-only behaviour, no
 * filtering).
 *
 * What the export does with the profile depends on the target
 * (`exportProfileCapability`): shadowrocket ignores profiles' groups/rules
 * (its subscription is nodes-only) but still honours `exclude_remarks`, which
 * is a node filter rather than a Clash feature.
 */
export async function loadUserProfile(
  db: SubhubDb,
  userId: number,
  exportTarget: ExportTarget,
  nodes: ProxyNode[],
  resolveIni: ProfileIniResolver = fetchProfileIni,
  /**
   * Explicit profile override (the URL's trailing profile-name segment, see
   * `subscription.ts`). When given, this profile is loaded instead of
   * `users.profileId`; everything else (INI fetch, `exclude_remarks`, groups,
   * rules, dnsTemplate) is identical. The caller resolves the name first, so
   * an unknown override never reaches this function.
   */
  profileId?: number | null,
): Promise<LoadedUserProfile | null> {
  try {
    let effectiveProfileId = profileId ?? null;
    if (!effectiveProfileId) {
      // users.profileId -> profiles.id; a disabled export path only reaches an
      // enabled user, but the lookup works for any existing user id.
      const link = db
        .select({ profileId: users.profileId })
        .from(users)
        .where(eq(users.id, userId))
        .get();
      effectiveProfileId = link?.profileId ?? null;
    }
    if (!effectiveProfileId) return null;

    const row = db.select().from(profiles).where(eq(profiles.id, effectiveProfileId)).get();
    if (!row) return null;

    const iniText = await resolveIni({ iniText: row.iniText ?? null, iniUrl: row.iniUrl ?? null });
    if (!iniText) return null;

    const ini = parseIni(iniText);
    // `[common] exclude_remarks` is applied here, on the raw parsed nodes,
    // *before* the group regexes are expanded: groups (`.*`, `((?i)hk)`, ...)
    // must only ever see the nodes the export will emit. Doing it here keeps
    // the INI fetch single-pass (the pattern lives in the same profile).
    const visibleNodes = excludeRemarkNodes(nodes, ini);
    const nodeNames = targetProxyNames(exportTarget, visibleNodes);
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
    if (capability === 'none' && built.proxyGroups.length === 0) return null;
    if (capability === 'groups' && built.proxyGroups.length === 0) return null;

    return {
      profile: {
        ruleProviders: built.ruleProviders,
        rules: built.rules,
        proxyGroups: built.proxyGroups,
        groupNames: ini.groups.map((group: ProxyGroupEntry) => group.name),
        // Raw text only: the core parses it at render time and silently falls
        // back to the built-in DNS section when it is not a YAML mapping.
        dnsTemplate: row.dnsTemplate ?? null,
      },
      // Same nodes when there is no usable `exclude_remarks`.
      nodes: visibleNodes,
    };
  } catch {
    return null;
  }
}

/**
 * Render nodes for an export target. `mihomo` and `clash` render identically:
 * Clash subscribers run mihomo-based clients (Clash Verge/Meta, ClashX Meta),
 * so `clash` gets the full node set plus the built-in DNS section and QUIC rule.
 * Every other target has its own real producer too; the mihomo-YAML fallback
 * below only remains for future targets without one.
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
  // Real share-link subscription: base64 of newline-joined links. Proxy groups
  // and rules are a Clash concept, so a rule profile is ignored here.
  if (target === 'uri') return produceUri(nodes);

  // sing-box v1: nodes only (`{ "outbounds": [...] }`). Groups/rules are out of
  // scope, and an empty/missing node list is still a valid document.
  if (target === 'singbox') return produceSingbox(nodes);

  if (target === 'shadowrocket') return produceShadowrocket(nodes);
  if (target === 'surge') return produceSurge(nodes, profile?.proxyGroups ?? []);
  if (target === 'loon') return produceLoon(nodes, profile?.proxyGroups ?? []);

  // A future target without a producer yet falls back to mihomo YAML; it must
  // stay exactly what it produced before the DNS template existed.
  // (`mihomo` and `clash` fall through to the full render below.)
  if (isFallbackTarget(target)) return renderMihomoFallbackBody(nodes, options, profile);

  const dnsOptions: ProduceOptions = {
    ...options,
    ...(profile?.dnsTemplate ? { dnsTemplate: profile.dnsTemplate } : {}),
  };

  if (!profile) {
    // No profile: dns + proxies + the leading (QUIC) rules.
    return produceMihomo(nodes, dnsOptions);
  }

  const sections: Record<string, unknown> = {};
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
