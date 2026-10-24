// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loon producer (`[Proxy]` + `[Proxy Group]`).
 *
 * Loon does not accept Clash/mihomo proxy YAML and its line syntax differs from
 * Surge's: the protocol keyword is capitalised (`Shadowsocks`, `ShadowsocksR`,
 * `VMess`, `VLESS`, `Trojan`, `Hysteria2`, `TUIC`, `AnyTLS`, `Socks5`, `HTTP`)
 * and the arguments are positional rather than `key=value`:
 *
 *   ss        Shadowsocks, server, port, method, password
 *   ssr       ShadowsocksR, server, port, method, password, protocol, protocol-param, obfs, obfs-param
 *   vmess     VMess, server, port, method, password(uuid), transport(, obfs=ws, obfs-uri=, obfs-host=, tls=true ...)
 *   vless     VLESS, server, port, method(none), password(uuid), transport, ...
 *   trojan    Trojan, server, port, password(, sni=, skip-cert-verify=, alpn=)
 *   hysteria2 Hysteria2, server, port, password(, sni=, skip-cert-verify=, alpn=)
 *   tuic      TUIC, server, port, token(, alpn=, sni=, skip-cert-verify=)
 *   anytls    AnyTLS, server, port, password(, sni=, skip-cert-verify=)
 *   socks5/http Socks5|HTTP, server, port, username, password
 *
 * Transport keywords: `tcp`, `ws`, `http`, `grpc`, `h2`, `http2`,
 * `over-tls=true` marks an explicit TLS transport in the protocol line.
 *
 * No `[Rule]` section. Loon's health-check group keywords are `select`,
 * `url-test` and `fall-back` (current versions also accept `fallback`);
 * `fallback` from a subconverter profile is emitted as `fall-back`.
 */

import type { ClashProxyGroup, ProxyNode } from '../types';
import { isTruthyFlag } from '../utils';
import { nodeSkipReason, prepareNode } from './common';
import {
  buildLineGroups,
  isWritableName,
  joinSections,
  lineGroup,
  markUnemitted,
  type LineGroup,
} from './groups';

/** Loon's own policy names that a profile group may reference. */
export const LOON_BUILTINS = ['DIRECT', 'REJECT'] as const;

/**
 * Subconverter group type -> Loon `[Proxy Group]` keyword. `load-balance` is
 * absent on purpose: Loon has no equivalent group type.
 */
const LOON_GROUP_TYPES: Record<string, string> = {
  select: 'select',
  'url-test': 'url-test',
  fallback: 'fall-back',
};

export interface LoonNodeResult {
  lines: string[];
  names: string[];
  skipped: Array<{ name: string; reason: string }>;
}

function bool(value: unknown): string {
  return isTruthyFlag(value) ? 'true' : 'false';
}

function sniOf(node: ProxyNode): string | undefined {
  const value = node.sni ?? node.servername ?? node['peer'];
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function alpnOf(node: ProxyNode): string | undefined {
  if (node.alpn === undefined || node.alpn === null) return undefined;
  const list = Array.isArray(node.alpn) ? node.alpn : [node.alpn];
  const joined = list.map((item) => String(item)).filter(Boolean).join(',');
  return joined || undefined;
}

function wsOptions(node: ProxyNode): string[] {
  const opts = node['ws-opts'] as Record<string, unknown> | undefined;
  const headers = opts?.headers as Record<string, unknown> | undefined;
  const host = headers
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'host')?.[1]
    : undefined;
  const path = typeof opts?.path === 'string' && opts.path ? opts.path : '/';
  const parts = ['obfs=ws', `obfs-uri=${path}`];
  if (host) parts.push(`obfs-host=${String(host)}`);
  return parts;
}

function grpcOptions(node: ProxyNode): string[] {
  const opts = node['grpc-opts'] as Record<string, unknown> | undefined;
  const parts = ['obfs=grpc'];
  const service = opts?.['grpc-service-name'];
  if (service) parts.push(`grpc-service-name=${String(service)}`);
  return parts;
}

/**
 * `VMess`/`VLESS` need a transport keyword; `undefined` means "cannot be
 * expressed by Loon" (h2, or Reality which Loon's VMess/VLESS entry has no
 * field for).
 */
function v2rayTransport(node: ProxyNode): string[] | undefined {
  if (node['reality-opts']) return undefined;
  switch (node.network) {
    case undefined:
    case '':
      return ['tcp'];
    case 'ws':
      return wsOptions(node);
    case 'grpc':
      return grpcOptions(node);
    case 'tcp':
    case 'http':
      return ['tcp'];
    default:
      return undefined;
  }
}

function vmessLine(node: ProxyNode): string | null {
  if (!node.uuid) return null;
  const transport = v2rayTransport(node);
  if (!transport) return null;
  const cipher = typeof node.cipher === 'string' && node.cipher ? node.cipher : 'auto';
  const parts = ['VMess', node.server, node.port, cipher, node.uuid, ...transport];
  if (node.tls) parts.push('over-tls=true');
  const sni = sniOf(node);
  if (sni) parts.push(`tls-name=${sni}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(',');
}

function vlessLine(node: ProxyNode): string | null {
  if (!node.uuid) return null;
  const transport = v2rayTransport(node);
  if (!transport) return null;
  const encryption = typeof node.encryption === 'string' && node.encryption ? node.encryption : 'none';
  const parts = ['VLESS', node.server, node.port, encryption, node.uuid, ...transport];
  if (node.tls) parts.push('over-tls=true');
  const sni = sniOf(node);
  if (sni) parts.push(`tls-name=${sni}`);
  if (node.flow) parts.push(`flow=${node.flow}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(',');
}

function tlssOptions(node: ProxyNode): string[] {
  const parts: string[] = [];
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  return parts;
}

/** Shared by Trojan / Hysteria2 / AnyTLS: `Name, server, port, password, ...`. */
function passwordLine(node: ProxyNode, keyword: string): string | null {
  // Loon's Trojan is TLS-only and has no WS/gRPC/Reality transport.
  if (!node.password) return null;
  return [keyword, node.server, node.port, node.password, ...tlssOptions(node)].join(',');
}

function trojanLine(node: ProxyNode): string | null {
  // Loon's Trojan is TLS-only and has no WS/gRPC/Reality transport.
  if (node.network || node['reality-opts']) return null;
  return passwordLine(node, 'Trojan');
}

function anytlsLine(node: ProxyNode): string | null {
  if (!node.password) return null;
  return ['AnyTLS', node.server, node.port, node.password, ...tlssOptions(node)].join(',');
}

function hysteria2Line(node: ProxyNode): string | null {
  if (!node.password) return null;
  return ['Hysteria2', node.server, node.port, node.password, ...tlssOptions(node)].join(',');
}

function tuicLine(node: ProxyNode): string | null {
  const token = node.token
    ? String(node.token)
    : node.uuid && node.password
      ? `${node.uuid}:${node.password}`
      : '';
  if (!token) return null;
  const parts: string[] = ['TUIC', String(node.server), String(node.port), token];
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(',');
}

function shadowsocksLine(node: ProxyNode): string | null {
  if (!node.cipher || !node.password) return null;
  // Loon has no Shadowsocks plugin line; a plugin-less line would connect to a
  // server that expects obfuscation, so skip instead.
  if (node.plugin) return null;
  return ['Shadowsocks', node.server, node.port, String(node.cipher), String(node.password)].join(
    ',',
  );
}

function shadowsocksrLine(node: ProxyNode): string | null {
  if (!node.cipher || !node.password || !node.protocol || !node.obfs) return null;
  return [
    'ShadowsocksR',
    node.server,
    node.port,
    String(node.cipher),
    String(node.password),
    String(node.protocol),
    String(node['protocol-param'] ?? ''),
    String(node.obfs),
    String(node['obfs-param'] ?? ''),
  ].join(',');
}

/**
 * `Socks5`/`HTTP, server, port, username, password`. Loon's fields are
 * positional, so credentials are written as a pair: a lone username would make
 * the password field swallow `over-tls=true` (and a lone password would sit in
 * the username position). Nodes with only one half are skipped.
 */
function socksHttpLine(node: ProxyNode, keyword: 'Socks5' | 'HTTP'): string | null {
  const hasUser = node.username !== undefined && node.username !== '';
  const hasPassword = node.password !== undefined && node.password !== '';
  if (hasUser !== hasPassword) return null;
  const parts = [keyword, node.server, node.port];
  if (hasUser && hasPassword) parts.push(String(node.username), String(node.password));
  if (keyword === 'HTTP' && isTruthyFlag(node.tls)) parts.push('over-tls=true');
  return parts.join(',');
}

/**
 * One Loon `[Proxy]` line, or the reason the node is skipped.
 *
 * An *unemitted* node (`markUnemitted`) arrives as a marker carrying its reason;
 * it is returned as-is instead of being re-derived (a nameless node would
 * otherwise report "missing name" instead of e.g. "unsupported protocol").
 */
export function loonProxyLine(node: ProxyNode):
  | { line: string }
  | { reason: string }
  | { skipped: string } {
  const marked = nodeSkipReason(node);
  if (marked) return { reason: marked };

  const proxy = prepareNode(node);
  const name = String(proxy.name ?? '').trim();
  if (!name) return { skipped: 'missing name' };
  // A newline or `=` in the name would start a new config line (or move the
  // assignment): the document is line-based, so such a node is not writable.
  if (!isWritableName(name)) return { skipped: 'name not representable in a config line' };
  if (!proxy.server || !proxy.port) return { skipped: 'missing server/port' };
  if (proxy['underlying-proxy'] || proxy['dialer-proxy']) {
    return { skipped: 'chained proxy not supported' };
  }

  let body: string | null;
  switch (proxy.type) {
    case 'ss':
      body = shadowsocksLine(proxy);
      break;
    case 'ssr':
      body = shadowsocksrLine(proxy);
      break;
    case 'vmess':
      body = vmessLine(proxy);
      break;
    case 'vless':
      body = vlessLine(proxy);
      break;
    case 'trojan':
      body = trojanLine(proxy);
      break;
    case 'hysteria2':
      body = hysteria2Line(proxy);
      break;
    case 'tuic':
      body = tuicLine(proxy);
      break;
    case 'anytls':
      body = anytlsLine(proxy);
      break;
    case 'socks5':
    case 'socks':
      body = socksHttpLine(proxy, 'Socks5');
      break;
    case 'http':
      body = socksHttpLine(proxy, 'HTTP');
      break;
    default:
      return { skipped: `unsupported protocol: ${String(proxy.type)}` };
  }

  if (!body) return { skipped: 'missing or unrepresentable protocol options' };
  return { line: `${name} = ${body}` };
}

/** Names + lines of the nodes Loon can load, in input order. */
export function buildLoonProxies(nodes: ProxyNode[]): LoonNodeResult {
  const result: LoonNodeResult = { lines: [], names: [], skipped: [] };
  const seen = new Set<string>();
  for (const node of nodes) {
    const built = loonProxyLine(node);
    if ('line' in built) {
      const name = built.line.slice(0, built.line.indexOf(' = '));
      // Duplicate names would define the same policy twice; the first wins.
      if (seen.has(name.toUpperCase())) {
        result.skipped.push({ name, reason: 'duplicate name' });
        continue;
      }
      seen.add(name.toUpperCase());
      result.lines.push(built.line);
      result.names.push(name);
      continue;
    }
    const reason = 'reason' in built ? built.reason : built.skipped;
    result.skipped.push({ name: String(node.name ?? ''), reason });
  }
  return result;
}

/** Translate profile groups for Loon, pruning references to skipped nodes. */
export function buildLoonGroups(
  groups: ClashProxyGroup[],
  nodeNames: Iterable<string>,
): LineGroup[] {
  return buildLineGroups(groups, nodeNames, {
    typeMap: LOON_GROUP_TYPES,
    builtins: LOON_BUILTINS,
  });
}

/**
 * Full Loon body: `[Proxy]` + `[Proxy Group]`, no `[Rule]`. Groups are pruned
 * against the proxies this body actually emits.
 */
export function produceLoon(nodes: ProxyNode[], groups: ClashProxyGroup[] = []): string {
  // Markers keep every skip reason in the single `skipped` list built below.
  const proxies = buildLoonProxies(markUnemitted(nodes, loonProxyLine));
  const lines = buildLoonGroups(groups, proxies.names).map(lineGroup);
  return joinSections([proxies.lines, lines]);
}
