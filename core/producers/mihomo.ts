// SPDX-License-Identifier: AGPL-3.0-only
/**
 * mihomo (Clash.Meta) producer.
 *
 * Ported and adapted from Sub-Store's clashmeta producer
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

import type { ClashProxyGroup, ProduceOptions, ProxyNode } from '../types';
import { resolveDnsTemplate } from '../dns';
import { buildTailscaleInjection } from '../tailscale';
import { stringify as stringifyYaml } from 'yaml';
import {
  normalizeAlpn,
  normalizeCommonTransport,
  normalizeVmessNode,
  prepareNode,
  renameSniToServername,
  stringifyProxiesSection,
  stringifyYamlBlocks,
} from './common';

/**
 * Drop QUIC (`UDP/443`). Encrypted-UDP flows bypass the TCP proxy path and are
 * the usual DNS/SNI leak vector, so the rule is emitted first, before any
 * profile ruleset can re-route it.
 */
export const QUIC_BLOCK_RULE = 'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT';

/**
 * Does a rule already block QUIC (so the default must not be duplicated)?
 * Matches the canonical rule, whitespace-only variations of it and any other
 * `NETWORK`/`DST-PORT` 443 reject the profile (or the user) wrote, in both the
 * `NETWORK,UDP` and the classic `NETWORK=UDP` (from a URI) spelling.
 */
export function isQuicBlockRule(rule: string): boolean {
  const compact = rule.replace(/\s+/g, '');
  if (compact === QUIC_BLOCK_RULE.replace(/\s+/g, '')) return true;
  return (
    /NETWORK[,(=]{1,2}UDP/i.test(compact) &&
    /DST-PORT[,(=]{1,2}443/i.test(compact) &&
    /REJECT/i.test(compact)
  );
}

/**
 * Rules emitted at the head of a mihomo config: the QUIC block unless the
 * caller disabled it or `rules` already contains an equivalent rule.
 */
export function buildLeadingRules(
  rules: string[],
  options: ProduceOptions = {},
): string[] {
  if (options.leadingRules === false) return [];
  const candidates = options.leadingRules ?? [QUIC_BLOCK_RULE];
  return candidates.filter(
    (candidate) => candidate.trim() !== '' && !rules.some(isQuicBlockRule),
  );
}

const TLS_IMPLICIT_TYPES = new Set([
  'trojan',
  'tuic',
  'hysteria',
  'hysteria2',
  'anytls',
]);

function transform(node: ProxyNode): ProxyNode {
  const proxy = prepareNode(node);

  normalizeVmessNode(proxy);
  renameSniToServername(proxy);
  normalizeCommonTransport(proxy);

  if (proxy.type === 'anytls') {
    // subhub default: do not keep idle sessions around.
    if (proxy['min-idle-session'] === undefined) {
      proxy['min-idle-session'] = 0;
    }
    if (proxy['idle-session-timeout'] === undefined) {
      proxy['idle-session-timeout'] = 30;
    }
  }

  if (proxy.type === 'tuic') {
    normalizeAlpn(proxy);
    if (proxy.tfo !== undefined && proxy['fast-open'] === undefined) {
      proxy['fast-open'] = proxy.tfo;
    }
    delete proxy.tfo;
    if (!proxy.token && proxy.version === undefined) proxy.version = 5;
  }

  if (proxy.type === 'hysteria2' || proxy.type === 'hysteria') {
    normalizeAlpn(proxy);
    if (proxy.tfo !== undefined && proxy['fast-open'] === undefined) {
      proxy['fast-open'] = proxy.tfo;
    }
    delete proxy.tfo;
  }

  if (proxy.type === 'vless' && proxy['reality-opts']) {
    if (!proxy['client-fingerprint']) proxy['client-fingerprint'] = 'chrome';
  }

  if (TLS_IMPLICIT_TYPES.has(proxy.type)) {
    delete proxy.tls;
  }

  if (proxy['tls-fingerprint'] !== undefined) {
    proxy.fingerprint = proxy['tls-fingerprint'];
    delete proxy['tls-fingerprint'];
  }

  return proxy;
}

export function buildMihomoProxies(
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): ProxyNode[] {
  return nodes.map((node) => {
    const proxy = transform(node);
    if (!options.includeUnsupported) {
      // mihomo supports every protocol handled by P1, so nothing is filtered.
    }
    return proxy;
  });
}

/**
 * `proxies` block only (the historical body). Used by the unimplemented P4
 * targets, which must stay untouched by the mihomo DNS/QUIC template.
 */
export function produceMihomoProxiesOnly(
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): string {
  return stringifyProxiesSection(buildMihomoProxies(nodes, options), options);
}

/**
 * Full mihomo (and Clash.Meta-compatible) body: `dns:` + `proxies:` + the
 * leading (QUIC) rules. A profile `dnsTemplate` replaces the built-in DNS
 * section; an invalid one falls back to the built-in.
 */
export function produceMihomo(
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): string {
  const proxies = buildMihomoProxies(nodes, options);
  // Built-in Tailscale outbound (opt-in). The proxy is appended AFTER the
  // converted nodes; the group and head rules go through the shared assembler
  // below so the QUIC block stays first. Without `options.tailscale` this is a
  // no-op and the output is byte-identical.
  const injection = buildTailscaleInjection(
    options.tailscale,
    proxies.map((proxy) => proxy.name),
    [],
  );
  return stringifyMihomoConfig(
    injection ? [...proxies, injection.proxy] : proxies,
    options,
    [],
    injection ? { rules: injection.rules, group: injection.group } : null,
  );
}

/**
 * Assemble a mihomo body. `leadingRules` are emitted before `profileRules`;
 * QUIC is injected unless it is disabled or already present.
 *
 * `injection` is the optional built-in Tailscale block (see
 * `core/tailscale.ts`): its `rules` are inserted right after the leading rules
 * and before `profileRules`, and its `group` is emitted as a `proxy-groups`
 * section when the caller does not assemble groups itself (the no-profile
 * `produceMihomo` path). Callers that build their own `proxy-groups` pass only
 * `{ rules }` and append the group to their own list.
 */
export function stringifyMihomoConfig(
  proxies: ProxyNode[],
  options: ProduceOptions = {},
  profileRules: string[] = [],
  injection: { rules?: readonly string[]; group?: ClashProxyGroup } | null = null,
): string {
  const leading = buildLeadingRules(profileRules, options);
  const rules = [...leading, ...(injection?.rules ?? []), ...profileRules];
  return stringifyYamlBlocks({
    dns: resolveDnsTemplate(options.dnsTemplate),
    proxies,
    // No `rules` key at all when there is nothing to emit (e.g. the profile
    // already blocks QUIC and has no other rules).
    ...(rules.length > 0 ? { rules } : {}),
    ...(injection?.group ? { 'proxy-groups': [injection.group] } : {}),
  }, options);
}
