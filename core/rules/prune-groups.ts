// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Empty proxy-group pruning for profile exports.
 *
 * A subconverter INI emits every `custom_proxy_group` verbatim, and its member
 * regexes are written for a particular provider's node names. A user with
 * another provider can end up with a group whose regexes match nothing:
 * `proxies: []`. mihomo/Clash then reject the *whole* config
 * (`proxy group[N]: <name>: 'use' or 'proxies' missing`), so one stale group
 * makes the export unusable.
 *
 * One definition drives everything, a reachability flood:
 *
 *   A group is LIVE when it can reach a *real outbound* (an emitted node or a
 *   built-in outbound such as DIRECT/REJECT) by following its members through
 *   other live groups. A group is DEAD when it cannot — it is empty, it only
 *   references dead groups or names that do not exist, or it only references
 *   other groups that are just as dead (a pure group cycle).
 *
 * On top of that a group needs enought members to make sense: `relay` needs at
 * least two live hops (a 1-hop relay is not a chain).
 *
 * Consequences, all intended:
 *  - a member reference to a group that is not live is dropped from the
 *    groups that survive (no dangling reference is ever emitted);
 *  - a pure cycle A<->B never reaches an outbound, so the flood never enters
 *    it and both die — and because the flood is a bounded traversal, a cycle
 *    can never make the prune loop forever;
 *  - a cycle that does reach a node (A -> B -> node) survives as a whole.
 *
 * Rule phase (after the groups settle): a rule whose policy names something
 * the document no longer defines is removed; rules pointing at a built-in, a
 * surviving group or a node are kept, in their original order.
 *
 * The loop recomputes the flood from the declared member lists every round
 * until the live set is *equal* to the previous one, so the members that
 * survive were computed against the final live set. It terminates because the
 * live set only ever shrinks (a group's ability to reach an outbound cannot
 * improve when another live group goes away): at most one round per group.
 */
import type { ClashProxyGroup } from '../types';

/** Outbounds every Clash-family client defines on its own. */
export const BUILTIN_GROUP_MEMBERS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']);

/** Group types that must keep more than one member to be meaningful. */
const MIN_MEMBERS_BY_TYPE: Record<string, number> = { relay: 2 };

/** Minimum number of live members for a group type (1 unless it needs more). */
export function minGroupMembers(type: string | null | undefined): number {
  return MIN_MEMBERS_BY_TYPE[String(type ?? '').trim().toLowerCase()] ?? 1;
}

/** Rule options that may trail a classical Clash rule line. */
const RULE_TRAILING_OPTIONS = new Set([
  'no-resolve',
  'src',
  'dport',
  'src-port',
  'dst-port',
  'extended-matching',
]);

/**
 * The policy of a classical Clash rule line, or `null` when the line has none
 * (empty, comment, bare `MATCH`). Trailing options are skipped.
 */
export function rulePolicy(rule: string): string | null {
  const line = rule.trim();
  if (!line || line.startsWith('#') || line.startsWith(';')) return null;
  const parts = line.split(',');
  if (parts.length < 2) return null;
  let index = parts.length - 1;
  while (index >= 1 && RULE_TRAILING_OPTIONS.has(parts[index].trim().toLowerCase())) {
    index -= 1;
  }
  const policy = parts[index].trim();
  return policy ? policy : null;
}

export interface PruneGroupsOptions {
  /**
   * Group names the producing document (whole) defines. A repeated name is
   * emitted once, at its last declaration, so only that declaration is live;
   * without this list every declaration is treated as its own group.
   */
  groupNames?: Iterable<string>;
  /**
   * Names a producer will emit. A name that is not a group, not a built-in and
   * not one of these is not a real outbound, so a group listing only such
   * names is dead. Omit when `proxyGroups` already holds produced member
   * lists: no name can then be proven to be a node, so only built-ins keep a
   * group alive.
   */
  nodeNames?: Iterable<string>;
}

export interface PrunedProfileTree {
  proxyGroups: ClashProxyGroup[];
  rules: string[];
}

/** Prefix subconverter writes in front of a group reference (`[]<group>`). */
const REF_PREFIX = '[]';

/**
 * The names a member entry can stand for: a group reference resolves to the
 * bare name, while a bare name can also *be* a group reference.
 *
 * `resolveGroupMembers` emits a reference to a group the INI mentions but no
 * group of the document defines (`[]NULL`, a typo) as the bare name, so both
 * spellings have to be tried; a bare name that matches a surviving group is
 * written back as that group's name, without the prefix.
 */
function memberCandidates(raw: string): string[] {
  const name = raw.trim();
  if (!name) return [];
  return name.startsWith(REF_PREFIX) ? [name.slice(2).trim()] : [name, REF_PREFIX + name];
}

/**
 * The names a member entry can resolve to: a built-in outbound (client
 * spelling), an emitted node, or a group of the document. A node keeps the
 * profile's spelling, with `[]` stripped, because that spelling is what the
 * member list is resolved against — `[]DIRECT` is leftover INI noise on a
 * built-in, while `[]n1` still names the node `n1`; if the node is not there
 * it is a group reference to nothing and drops out.
 */
function resolveMember(
  raw: string,
  candidates: Set<string>,
  isNode: (name: string) => boolean,
): { outbound?: string; hop?: string } {
  for (const name of memberCandidates(raw)) {
    if (!name) continue;
    if (BUILTIN_GROUP_MEMBERS.has(name.toUpperCase())) return { outbound: name.toUpperCase() };
    if (isNode(name)) return { outbound: name };
    if (candidates.has(name)) return { hop: name };
  }
  return {};
}

/**
 * One round: the groups that are live, plus each survivor's member list.
 *
 * Every group is resolved against `candidates` (the groups that may still be
 * live) and the document's nodes/built-ins:
 *
 *   members(g) = the resolvable members of g, in declared order;
 *   hop(g, x)  = true when a member of g references the group x;
 *   root(g)    = true when a member of g is a real outbound (node/built-in).
 *
 * A group is live when it is *reachable* — an outbound is reachable, and a
 * group is reachable when at least one of its members is (a real outbound,
 * which makes it a root, or a reference to a reachable group) — and then
 * still has enough members once the references to dead groups are dropped.
 * Reachability is a least fixpoint over a finite set: every round admits at
 * least one new group or stops, so it terminates, and a pure cycle (which
 * never reaches an outbound) is never admitted.
 */
function liveGroups(
  groups: ClashProxyGroup[],
  candidates: Set<string>,
  definedGroups: (group: ClashProxyGroup) => boolean,
  isNode: (name: string) => boolean,
): { live: Set<string>; members: Map<string, string[]> } {
  const types = new Map<string, string>();
  const members = new Map<string, string[]>();
  const references = new Map<string, string[]>();
  const roots = new Set<string>();

  for (const group of groups) {
    if (!candidates.has(group.name) || !definedGroups(group)) continue;
    types.set(group.name, group.type);
    const kept: string[] = [];
    const referenced: string[] = [];
    const seen = new Set<string>();
    let outbound = false;
    for (const raw of Array.isArray(group.proxies) ? group.proxies : []) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) continue;
      const member = resolveMember(value, candidates, isNode);
      const name = member.outbound ?? member.hop;
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      kept.push(name);
      if (member.outbound !== undefined) outbound = true;
      else referenced.push(name);
    }
    members.set(group.name, kept);
    references.set(group.name, referenced);
    if (outbound) roots.add(group.name);
  }

  // Reachability: start at the outbounds, then admit a group that can reach
  // one through ANY of its references — a single dead reference must not
  // condemn a group whose other members are live (the dead reference is
  // dropped in the settle phase below). A cycle with no outbound is never
  // admitted: no member of it ever becomes reachable.
  const reachable = new Set<string>(roots);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, kept] of members) {
      if (reachable.has(name)) continue;
      if (kept.length < minGroupMembers(types.get(name))) continue;
      const referenced = references.get(name) ?? [];
      if (!referenced.some((hop) => reachable.has(hop))) continue;
      reachable.add(name);
      changed = true;
    }
  }

  // A reachable group still has to survive its own references being pruned to
  // the live set: a relay whose second hop is dead is dead too.
  const live = new Set<string>();
  const settled = new Map<string, string[]>();
  for (const [name, kept] of members) {
    if (!reachable.has(name)) continue;
    const pruned = kept.filter((member) => !candidates.has(member) || reachable.has(member));
    if (pruned.length < minGroupMembers(types.get(name))) continue;
    live.add(name);
    settled.set(name, pruned);
  }

  return { live, members: settled };
}

/**
 * Drop groups that would render empty (or a relay with fewer than two live
 * members), the references to them, and every rule that points at one.
 *
 * An unaffected profile is returned unchanged (same object, same group
 * objects), so it renders byte-for-byte as before.
 */
export function pruneEmptyGroups<T extends PrunedProfileTree>(
  profile: T,
  options: PruneGroupsOptions = {},
): T {
  if (profile.proxyGroups.length === 0) return profile;

  const nodes = options.nodeNames ? new Set(options.nodeNames) : null;
  // Without a node list no name can be proven to be an emitted node, so only
  // the built-ins count as real outbounds and every other non-group member is
  // dropped — the safe direction: a group is never kept alive by a name that
  // may not resolve. (`loadUserProfile` always passes the emitted names.)
  const isNode = (name: string): boolean => nodes !== null && nodes.has(name);

  // A repeated name is one group in the output, defined by its *last*
  // declaration (that is the one a YAML list consumer resolves); the others
  // are shadowed and contribute nothing.
  const declaredNames = options.groupNames
    ? new Set(options.groupNames)
    : new Set(profile.proxyGroups.map((group) => group.name));
  const lastIndex = new Map<string, number>();
  profile.proxyGroups.forEach((group, index) => lastIndex.set(group.name, index));
  const isDefined = (group: ClashProxyGroup): boolean =>
    declaredNames.has(group.name) &&
    profile.proxyGroups[lastIndex.get(group.name) ?? -1] === group;

  let candidates = new Set(profile.proxyGroups.filter(isDefined).map((group) => group.name));
  let live: Set<string>;
  let members: Map<string, string[]>;

  for (;;) {
    ({ live, members } = liveGroups(profile.proxyGroups, candidates, isDefined, isNode));
    if (live.size === candidates.size) break;
    candidates = live;
  }

  const nextGroups: ClashProxyGroup[] = [];
  profile.proxyGroups.forEach((group) => {
    if (!live.has(group.name) || !isDefined(group)) return;
    const kept = members.get(group.name) ?? [];
    const current: string[] = Array.isArray(group.proxies) ? group.proxies : [];
    const unchanged =
      kept.length === current.length && kept.every((member, index) => member === current[index]);
    nextGroups.push(unchanged ? group : { ...group, proxies: kept });
  });
  // Unchanged groups are the very same objects; when that is all of them keep
  // the original array too, so the caller can hand back `profile` unchanged.
  const proxyGroups =
    nextGroups.length === profile.proxyGroups.length &&
    nextGroups.every((group, index) => group === profile.proxyGroups[index])
      ? profile.proxyGroups
      : nextGroups;

  // A policy resolves when it names a surviving group, a built-in outbound or
  // an emitted node — exactly what `resolveMember` accepts for a member.
  const policyAlive = (policy: string): boolean =>
    live.has(policy) || BUILTIN_GROUP_MEMBERS.has(policy.toUpperCase()) || isNode(policy);

  // Policies repeat heavily, so the decision is memoised per policy string.
  // Built by hand rather than with `filter()` so a rule list with nothing to
  // drop keeps its identity.
  const decisions = new Map<string, boolean>();
  let dropped = false;
  const keptRules: string[] = [];
  for (const rule of profile.rules ?? []) {
    const policy = rulePolicy(rule);
    if (policy === null) {
      keptRules.push(rule);
      continue;
    }
    let alivePolicy = decisions.get(policy);
    if (alivePolicy === undefined) {
      alivePolicy = policyAlive(policy);
      decisions.set(policy, alivePolicy);
    }
    if (alivePolicy) keptRules.push(rule);
    else dropped = true;
  }
  const rules = dropped ? keptRules : profile.rules;

  if (proxyGroups === profile.proxyGroups && rules === profile.rules) return profile;
  return { ...profile, proxyGroups, rules };
}
