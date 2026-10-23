// SPDX-License-Identifier: AGPL-3.0-only
/**
 * mihomo (Clash.Meta) producer.
 *
 * Ported and adapted from Sub-Store's clashmeta producer
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

import type { ProduceOptions, ProxyNode } from '../types';
import {
  normalizeAlpn,
  normalizeCommonTransport,
  normalizeVmessNode,
  prepareNode,
  renameSniToServername,
  toYamlProxies,
} from './common';

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

export function produceMihomo(
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): string {
  return toYamlProxies(buildMihomoProxies(nodes, options), options);
}
