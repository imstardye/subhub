// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Legacy Clash producer.
 *
 * Ported and adapted from Sub-Store's clash producer
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 *
 * Legacy Clash lacks Hysteria2, TUIC, AnyTLS, VLESS Reality/XTLS flow and a
 * number of newer transport options. Unsupported nodes are filtered instead of
 * emitting a config the kernel cannot load.
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

const SUPPORTED_TYPES = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'socks5',
  'http',
  'snell',
  'trojan',
]);

const SUPPORTED_SS_CIPHERS = new Set([
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'rc4-md5',
  'chacha20-ietf',
  'xchacha20',
  'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305',
]);

function isSupported(node: ProxyNode): boolean {
  if (!SUPPORTED_TYPES.has(node.type)) return false;

  if (node.type === 'ss' && !SUPPORTED_SS_CIPHERS.has(String(node.cipher))) {
    return false;
  }
  if (node.type === 'vless' && (node.flow !== undefined || node['reality-opts'])) {
    return false;
  }
  if (node.type === 'snell' && Number(node.version ?? 0) >= 4) return false;
  if (node.network === 'ws') {
    const opts = node['ws-opts'] as Record<string, unknown> | undefined;
    if (opts?.['v2ray-http-upgrade']) return false;
  }
  if (node['underlying-proxy'] || node['dialer-proxy']) return false;

  return true;
}

function transform(node: ProxyNode): ProxyNode {
  const proxy = prepareNode(node);

  normalizeVmessNode(proxy);
  renameSniToServername(proxy);
  normalizeCommonTransport(proxy);

  if (proxy.type === 'tuic' || proxy.type === 'hysteria' || proxy.type === 'hysteria2') {
    normalizeAlpn(proxy);
  }

  if (['trojan', 'tuic', 'hysteria', 'hysteria2', 'anytls'].includes(proxy.type)) {
    delete proxy.tls;
  }
  delete proxy['reality-opts'];
  delete proxy.flow;

  if (proxy['tls-fingerprint'] !== undefined) {
    proxy.fingerprint = proxy['tls-fingerprint'];
    delete proxy['tls-fingerprint'];
  }

  if (proxy.type === 'snell' && Number(proxy.version ?? 0) < 3) {
    delete proxy.udp;
  }

  return proxy;
}

export function buildLegacyProxies(
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): ProxyNode[] {
  return nodes
    .filter((node) => options.includeUnsupported || isSupported(node))
    .map((node) => transform(node));
}

export function produceLegacy(
  nodes: ProxyNode[],
  options: ProduceOptions = {},
): string {
  return toYamlProxies(buildLegacyProxies(nodes, options), options);
}
