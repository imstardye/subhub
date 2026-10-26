// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Proxy groups for the line-based clients (Surge, Loon).
 *
 * The profile groups arrive as mihomo-shaped `ClashProxyGroup` objects (see
 * `buildProxyGroups` in `core/rules`): `proxies` is a list of names, of which
 * some are emitted nodes, some are other groups of the profile and some are
 * built-in outbounds. A line-based client only accepts output names that are
 * *defined* in its own document, so every other member must be dropped, and a
 * group left without members disappears entirely.
 *
 * Group types without an equivalent in those clients (`relay`,
 * `load-balance` on Loon, ...) are dropped with their members.
 */

import type { ClashProxyGroup, ProxyNode } from '../types';
import { withSkipReason } from './common';

/** A group line for a client config: name, client keyword and members. */
export interface LineGroup {
  name: string;
  /** Keyword as written after `=` (e.g. `select`, `url-test`, `fall-back`). */
  type: string;
  members: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
  /** Surge/Loon `,no-alert=0` (mihomo `lazy: true`). */
  noAlert?: boolean;
}

export interface BuildLineGroupOptions {
  /** Profile group type -> client keyword; the client's supported subset. */
  typeMap: Record<string, string>;
  /** Built-in outbounds the client can reference. */
  builtins: readonly string[];
}

/**
 * Members are pruned to `nodeNames + built-in outbounds + emitted groups`; a
 * group whose type has no mapping, or whose members all got pruned, is
 * omitted. A member that is a *profile group* the client cannot express is
 * dropped too (it would reference an undefined group name). Pruning is a
 * fixpoint: dropping a group also drops every reference to it from the groups
 * that remain, which can in turn empty them.
 *
 * Clients match policy names case-insensitively, so a member that only differs
 * in case from one already listed is dropped as a duplicate (a group must not
 * list `hk-01` and `HK-01`). Group *names* are kept unique the same way: a
 * repeated group name would be loaded twice (or override itself).
 */
export function buildLineGroups(
  groups: ClashProxyGroup[],
  nodeNames: Iterable<string>,
  options: BuildLineGroupOptions,
): LineGroup[] {
  const nodes = new Set(nodeNames);
  const builtins = new Map(options.builtins.map((name) => [name.toUpperCase(), name]));

  // Groups the client can express at all, in profile order.
  const candidates: LineGroup[] = [];
  const seenNames = new Set<string>();
  for (const group of groups) {
    const type = options.typeMap[(group.type ?? '').toLowerCase()];
    if (!type || !group.name) continue;
    // A newline or `=` cannot be written in a `name = TYPE, ...` document.
    if (!isWritableName(group.name)) continue;
    if (seenNames.has(group.name.toUpperCase())) continue;
    seenNames.add(group.name.toUpperCase());
    candidates.push({
      name: group.name,
      type,
      members: Array.isArray(group.proxies) ? [...group.proxies] : [],
      ...(group.url ? { url: group.url } : {}),
      ...(group.interval !== undefined ? { interval: group.interval } : {}),
      ...(group.tolerance !== undefined ? { tolerance: group.tolerance } : {}),
      ...(group.lazy !== undefined ? { noAlert: group.lazy } : {}),
    });
  }

  // Two interleaved fixpoints.
  //
  // `alive`  - groups still emittable, pruned against the previous round.
  // `useful` - groups that can reach an emitted node *through their members*,
  //            so a cycle of groups referencing only each other cannot keep
  //            itself alive (nor keep a group that points at it alive).
  // Both only ever shrink; a round that changes neither is the fixpoint.
  let alive = new Set(candidates.map((group) => group.name));
  let pruned = new Map<string, string[]>();
  for (;;) {
    pruned = new Map<string, string[]>();
    for (const group of candidates) {
      if (!alive.has(group.name)) continue;
      const seen = new Set<string>();
      const members: string[] = [];
      for (const raw of group.members) {
        const member = typeof raw === 'string' ? raw.trim() : '';
        if (!member || !isWritableName(member)) continue;
        const builtin = builtins.get(member.toUpperCase());
        // Only emitted nodes, still-alive groups and built-ins survive: a
        // skipped node, an unknown name and a group the client cannot express
        // would all reference something the output does not define.
        if (!nodes.has(member) && !alive.has(member) && !builtin) continue;
        const written = builtin ?? member;
        const key = written.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        members.push(written);
      }
      pruned.set(group.name, members);
    }

    const useful = reachableGroups(candidates, pruned, nodes, new Set(options.builtins));

    const nextAlive = new Set<string>();
    for (const group of candidates) {
      if (!alive.has(group.name)) continue;
      if (!useful.has(group.name)) continue;
      if ((pruned.get(group.name) ?? []).length > 0) nextAlive.add(group.name);
    }

    if (nextAlive.size === alive.size) {
      return candidates
        .filter((group) => nextAlive.has(group.name))
        .map((group) => ({ ...group, members: pruned.get(group.name) ?? [] }));
    }
    alive = nextAlive;
  }
}

/**
 * Groups that can reach an emitted node or a built-in through their (already
 * pruned) members. Groups left out reference only each other.
 */
function reachableGroups(
  candidates: LineGroup[],
  pruned: Map<string, string[]>,
  nodes: Set<string>,
  builtins: Set<string>,
): Set<string> {
  const reached = new Set<string>();

  // Seed with the groups that own a real outbound, then admit any group that
  // references an already-reached group, to a fixpoint. The flood runs from
  // the outbound UP through the referrers: a leaf service group that only
  // rules point at (e.g. an AI group chaining into the regional groups) is
  // useful because IT reaches an outbound, not because some other group
  // references it. A pure cycle never enters — none of its members is ever
  // reached.
  for (const group of candidates) {
    if ((pruned.get(group.name) ?? []).some((member) => nodes.has(member) || builtins.has(member))) {
      reached.add(group.name);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const group of candidates) {
      if (reached.has(group.name)) continue;
      if ((pruned.get(group.name) ?? []).some((member) => reached.has(member))) {
        reached.add(group.name);
        changed = true;
      }
    }
  }
  return reached;
}

/** A name that can be written inside a single line-based config line. */
export function isWritableName(name: string): boolean {
  return name.trim() !== '' && !/[\r\n]/.test(name) && !name.includes('=');
}

/** The result shape of a per-node client line builder. */
export type ProxyLineResult =
  | { line: string }
  | { skipped: string }
  // An already-dropped marker node being fed back in (see `markUnemitted`).
  | { reason: string };

/**
 * Replace the nodes line builders skip with marker nodes that carry the reason.
 *
 * A nameless node loses its reason when the skipped list is built from
 * `node.name` alone, so the reason is persisted through `withSkipReason` (on a
 * cleaned copy, so no raw credentials travel along) and the builder that sees
 * the marker returns it unchanged. Emitted nodes pass through untouched.
 */
export function markUnemitted(
  nodes: ProxyNode[],
  build: (node: ProxyNode) => ProxyLineResult,
): ProxyNode[] {
  return nodes.map((node) => {
    const built = build(node);
    if ('line' in built) return node;
    const reason = 'reason' in built ? built.reason : built.skipped;
    return withSkipReason({ name: String(node.name ?? ''), type: '', server: '', port: 0 }, reason);
  });
}

/** One `name = TYPE, ...` line, tolerating a name that itself contains commas. */
export function lineGroup(group: LineGroup): string {
  const parts = [group.type, ...group.members];
  if (group.url) parts.push(`url=${group.url}`);
  if (group.interval !== undefined) parts.push(`interval=${group.interval}`);
  if (group.tolerance !== undefined) parts.push(`tolerance=${group.tolerance}`);
  if (group.noAlert !== undefined) parts.push(`no-alert=${group.noAlert ? 1 : 0}`);
  return `${group.name} = ${parts.join(',')}`;
}

/** Join non-empty document sections with exactly one blank line between them. */
export function joinSections(sections: string[][]): string {
  const blocks = sections
    .map((lines) => lines.filter((line) => line !== ''))
    .filter((lines) => lines.length > 0);
  if (blocks.length === 0) return '';
  return `${blocks.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}
