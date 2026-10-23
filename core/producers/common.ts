// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared producer helpers.
 *
 * Adapted from Sub-Store
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

import { stringify as stringifyYaml } from 'yaml';
import type { ProduceOptions, ProxyNode } from '../types';
import { deepClone, normalizeVmessSecurity } from '../utils';

export function cleanupValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .map((entry) => cleanupValue(entry))
      .filter((entry) => entry !== undefined && entry !== null) as T;
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined || entry === null) continue;
      if (/^_/.test(key)) continue;
      output[key] = cleanupValue(entry);
    }
    return output as T;
  }

  return value;
}

export function prepareNode(node: ProxyNode): ProxyNode {
  return cleanupValue(deepClone(node));
}

export function renameSniToServername(node: ProxyNode): void {
  if (node.type === 'vmess' || node.type === 'vless') {
    if (node.sni !== undefined && node.servername === undefined) {
      node.servername = node.sni;
    }
    delete node.sni;
  }
}

export function normalizeVmessNode(node: ProxyNode): void {
  if (node.type === 'vmess') {
    node.cipher = normalizeVmessSecurity(node.cipher);
    node.alterId = Number.parseInt(String(node.alterId ?? 0), 10) || 0;
  }
}

export function normalizeWebSocketOptions(node: ProxyNode): void {
  if (node.network !== 'ws') return;
  const key = 'ws-opts';
  const existing = (node[key] as Record<string, unknown> | undefined) ?? {};
  if (!existing.path) existing.path = '/';
  const headers = existing.headers as Record<string, unknown> | undefined;
  if (headers && Object.keys(headers).length === 0) delete existing.headers;
  node[key] = existing;
}

export function normalizeH2Options(node: ProxyNode): void {
  if (node.network !== 'h2') return;
  const opts = node['h2-opts'] as Record<string, unknown> | undefined;
  if (!opts) return;

  if (Array.isArray(opts.path)) opts.path = opts.path[0] ?? '/';
  if (!opts.path) opts.path = '/';

  const headers = opts.headers as Record<string, unknown> | undefined;
  let host = opts.host;
  if (host === undefined && headers) {
    host = headers.Host ?? headers.host;
  }
  if (host !== undefined) {
    opts.host = Array.isArray(host) ? host : [host];
  }
  if (headers) {
    delete headers.Host;
    delete headers.host;
    if (Object.keys(headers).length === 0) delete opts.headers;
  }
}

export function normalizeCommonTransport(node: ProxyNode): void {
  normalizeWebSocketOptions(node);
  normalizeH2Options(node);
}

export function normalizeAlpn(node: ProxyNode): void {
  if (node.alpn === undefined) return;
  node.alpn = Array.isArray(node.alpn) ? node.alpn : [node.alpn];
}

export function toYamlProxies(nodes: ProxyNode[], options: ProduceOptions = {}): string {
  if (options.pretty === false) {
    return (
      'proxies:\n' +
      nodes.map((node) => `  - ${JSON.stringify(node)}\n`).join('')
    );
  }

  return stringifyYaml(
    { proxies: nodes },
    {
      lineWidth: 0,
      aliasDuplicateObjects: false,
    },
  );
}
