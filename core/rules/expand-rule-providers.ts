// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Expand remote rule-provider lists into literal rule lines.
 *
 * Exported configs used to reference `rule-providers` and `RULE-SET` lines, so
 * every client had to fetch the lists itself. This module replaces a
 * `RULE-SET,<key>,<policy>` line with the provider's parsed body, in place, and
 * drops the provider from the returned map. A list body that could not be
 * fetched keeps today's remote reference (never a missing rule).
 */
import type { ClashRuleProvider } from '../types';
import { CUSTOM_RULE_TYPES } from './custom-rules';

/**
 * Rule types a mihomo/clash top level accepts. A provider payload is parsed
 * leniently by mihomo (an unsupported line inside a list, e.g. the Surge-only
 * URL-REGEX, is skipped), but the same line promoted to the top-level `rules:`
 * array is FATAL — so mihomo-family renders expand through this filter.
 * Reuses the custom-rules whitelist as the single source of truth.
 */
export const MIHOMO_EXPANSION_RULE_TYPES: ReadonlySet<string> = CUSTOM_RULE_TYPES;

/** Rule options that trail a classical rule line; never a policy. */
const RULE_PARAMS = new Set([
  'no-resolve',
  'src',
  'dport',
  'src-port',
  'dst-port',
  'extended-matching',
]);

/** Types that may inherit the RULE-SET line's options. */
const IP_RULE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'GEOIP']);

/** Types that cannot be nested inside an expanded list. */
const NON_EXPANDABLE_TYPES = new Set(['RULE-SET', 'MATCH', 'FINAL', 'AND', 'OR', 'NOT']);

export interface ExpandedRuleProviders {
  rules: string[];
  providers: Record<string, ClashRuleProvider>;
}

interface RuleSetReference {
  provider: string;
  policy: string;
  params: string[];
}

function parseRuleSetLine(line: string): RuleSetReference | null {
  const parts = line.split(',').map((part) => part.trim());
  if (parts.length < 3) return null;
  if (parts[0]?.toUpperCase() !== 'RULE-SET') return null;
  const provider = parts[1] ?? '';
  const policy = parts[2] ?? '';
  if (!provider || !policy) return null;
  return { provider, policy, params: parts.slice(3).filter(Boolean) };
}

function expandBody(
  body: string,
  setPolicy: string,
  setParams: string[],
  policies: ReadonlySet<string>,
  allowedTypes?: ReadonlySet<string>,
): string[] {
  const emitted: string[] = [];
  const seen = new Set<string>();

  for (const raw of body.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const parts = line.split(',').map((part) => part.trim());
    const type = (parts[0] ?? '').toUpperCase();
    if (!type || NON_EXPANDABLE_TYPES.has(type)) continue;
    if (allowedTypes && !allowedTypes.has(type)) continue;

    const payload = parts[1] ?? '';
    if (!payload) continue;

    const tail = parts.slice(2).filter(Boolean);
    let policy = setPolicy;
    let params: string[] = [];

    if (tail.length > 0) {
      const candidate = tail[0]!;
      if (policies.has(candidate) && !RULE_PARAMS.has(candidate.toLowerCase())) {
        policy = candidate;
        params = tail.slice(1);
      } else {
        params = tail;
      }
    }

    if (IP_RULE_TYPES.has(type)) {
      for (const param of setParams) {
        if (!params.some((existing) => existing.toLowerCase() === param.toLowerCase())) {
          params.push(param);
        }
      }
    }

    const rule = [type, payload, policy, ...params].filter(Boolean).join(',');
    if (seen.has(rule)) continue;
    seen.add(rule);
    emitted.push(rule);
  }

  return emitted;
}

/**
 * Replace every expandable `RULE-SET` line with its provider's body, in place.
 *
 * `bodiesByUrl` maps provider URLs to their fetched text; `null`/missing means
 * "unavailable" and leaves both the line and the provider untouched. `policies`
 * decides whether a body line's third field is its own policy or the first of
 * its options.
 */
export function expandRuleProviders(
  rules: string[],
  providers: Record<string, ClashRuleProvider>,
  bodiesByUrl: ReadonlyMap<string, string | null>,
  policies: ReadonlySet<string>,
  allowedTypes?: ReadonlySet<string>,
): ExpandedRuleProviders {
  let nextRules: string[] | null = null;
  let nextProviders = providers;

  rules.forEach((rule, index) => {
    const reference = parseRuleSetLine(rule);
    const provider = reference ? providers[reference.provider] : undefined;
    const body = provider ? bodiesByUrl.get(provider.url) : null;
    if (!reference || !provider || typeof body !== 'string') {
      nextRules?.push(rule);
      return;
    }

    if (nextRules === null) {
      nextRules = rules.slice(0, index);
      nextProviders = { ...providers };
    }
    delete nextProviders[reference.provider];
    nextRules.push(...expandBody(body, reference.policy, reference.params, policies, allowedTypes));
  });

  return {
    rules: nextRules ?? rules,
    providers: nextProviders,
  };
}
