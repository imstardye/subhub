// SPDX-License-Identifier: AGPL-3.0-only
import type { ProxyNode } from './types';

// These fields belong inside amnezia-wg-option, not at the WireGuard node root.
// https://github.com/MetaCubeX/mihomo/blob/v1.19.31/adapter/outbound/wireguard.go
const AMNEZIA_FIELDS = ['jc', 'jmin', 'jmax', 's1', 's2', 'h1', 'h2', 'h3', 'h4'] as const;

export function flatAmneziaFields(node: ProxyNode): string[] {
  return AMNEZIA_FIELDS.filter((key) => node[key] != null);
}

export function hasAmneziaOptions(node: ProxyNode): boolean {
  return node.type === 'wireguard'
    && (node['amnezia-wg-option'] != null || flatAmneziaFields(node).length > 0);
}
