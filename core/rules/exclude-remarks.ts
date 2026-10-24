// SPDX-License-Identifier: AGPL-3.0-only
/**
 * subconverter `exclude_remarks` support.
 *
 * A subconverter profile INI may carry `[common] exclude_remarks=<regex>`.
 * subconverter drops every node whose *remark* (the node name) matches that
 * regex — in practice the info/ads pseudo-nodes providers append to their
 * subscriptions (`剩余流量：...`, `套餐到期：...`, `官网 ...`).
 *
 * Semantics (mirroring subconverter):
 * - the value is compiled with `new RegExp(pattern)` — no flags, so matching is
 *   a case-sensitive substring search (`RegExp.test`);
 * - an empty/missing pattern, or a pattern that does not compile, means "no
 *   exclusion" (an invalid user regex must never break an export);
 * - an empty/missing node name is always kept.
 */
import type { ProxyNode, SubconverterIni } from '../types';

/** Predicate telling whether a remark should be dropped. */
export type RemarkExcluder = (name: string | null | undefined) => boolean;

/**
 * Compile the `exclude_remarks` pattern of a parsed INI.
 *
 * Returns `null` when there is nothing to exclude (no `[common]` entry, empty
 * pattern, or an invalid regex). Never throws.
 */
export function compileExcludeRemarks(ini: SubconverterIni | null | undefined): RemarkExcluder | null {
  const pattern = ini?.common?.['exclude_remarks'];
  if (typeof pattern !== 'string') return null;
  const source = pattern.trim();
  if (!source) return null;

  let regex: RegExp;
  try {
    regex = new RegExp(source);
  } catch {
    // User-supplied regex: a typo disables the feature, it does not 500.
    return null;
  }

  return (name) => {
    if (typeof name !== 'string' || !name) return false;
    // `lastIndex` is irrelevant without the `g` flag, but resetting keeps the
    // predicate safe if the compiled regex ever gains flags.
    regex.lastIndex = 0;
    return regex.test(name);
  };
}

/**
 * Drop the nodes whose name matches `exclude_remarks` (subconverter's
 * `excludeRemarks`). Without a usable pattern the list is returned unchanged
 * (same array contents, in order).
 */
export function excludeRemarkNodes(nodes: ProxyNode[], ini: SubconverterIni | null | undefined): ProxyNode[] {
  const excluded = compileExcludeRemarks(ini);
  if (!excluded) return nodes;
  return nodes.filter((node) => !excluded(node.name));
}
