// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Built-in info/ads pseudo-node filter.
 *
 * Nearly every airport subscription appends a few "nodes" that are not proxies
 * at all — they only carry text in their name (`剩余流量：579.45 GB`,
 * `套餐到期：长期有效`, `官网 https://…`). Clients show them as broken nodes, so
 * `subhub` drops them on every conversion, whether or not the user's rule
 * profile carries a `[common] exclude_remarks` pattern.
 *
 * Relationship to subconverter's `exclude_remarks` (see `exclude-remarks.ts`):
 * - this built-in set is applied FIRST, unconditionally;
 * - the profile's `exclude_remarks` regex is applied on top, so the dropped set
 *   is the UNION of both. The INI path keeps its exact subconverter semantics
 *   (case-sensitive regex, invalid pattern = no-op) — nothing here changes it.
 *
 * Deliberately NARROW: only phrases that cannot be part of a real node name.
 * Broad words that airport names actually contain (`机场`, `订阅`, `平台`,
 * `产品`, `时间`, `分享`, …) are NOT built in — a `商丘机场·香港` node must
 * survive. A profile that wants those wider drops says so in `exclude_remarks`.
 *
 * Filtering happens on the read/convert path only (`loadUserProfile` and the
 * admin/user-center node counters). Caches keep the provider's raw payload.
 */
import type { ProxyNode } from '../types';

/**
 * Substrings that identify an info/ads pseudo-node by its name. Keep this list
 * short and unambiguous; see the module comment for what must not be added.
 */
export const INFO_NODE_KEYWORDS: readonly string[] = [
  '剩余流量',
  '套餐到期',
  '到期',
  '重置',
  '官网',
  '过期',
  '二手倒卖',
  '请勿使用该节点',
];

/**
 * True when a node name looks like an info/ads pseudo-node (case-sensitive
 * substring match, like the `exclude_remarks` predicate it complements).
 * An empty/missing name is never treated as an info node.
 */
export function isInfoNodeName(name: string | null | undefined): boolean {
  if (typeof name !== 'string' || !name) return false;
  return INFO_NODE_KEYWORDS.some((keyword) => name.includes(keyword));
}

/**
 * Drop the nodes whose name matches the built-in info-node set. Without a
 * match the list is returned unchanged (same array contents, in order).
 */
export function filterInfoNodes(nodes: ProxyNode[]): ProxyNode[] {
  return nodes.filter((node) => !isInfoNodeName(node.name));
}

/**
 * Union of the built-in filter and a profile's `exclude_remarks` predicate:
 * a node goes when either one matches. `exclude` may be `null` (no usable
 * pattern), in which case this is exactly `filterInfoNodes`.
 */
export function filterInfoAndRemarkNodes(
  nodes: ProxyNode[],
  exclude: ((name: string | null | undefined) => boolean) | null,
): ProxyNode[] {
  return nodes.filter((node) => !isInfoNodeName(node.name) && !(exclude ? exclude(node.name) : false));
}
