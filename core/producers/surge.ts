// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Surge producer (`[Proxy]` + `[Proxy Group]`).
 *
 * Line syntax (`name = type, server, port, key=value, ...`) follows Surge's
 * config format. Only protocols Surge itself can dial are emitted; unsupported
 * combinations are skipped instead of being faked (the point
 * of a real producer is that the client can load the result).
 *
 * No `[Rule]` section: rules are owned by the client/its own template. Surge
 * policy names are therefore irrelevant here, and the profile groups are
 * translated only for navigation (see `buildLineGroups`).
 *
 * Protocol coverage (mirrors Surge's docs):
 * - `ss`       `ss, server, port, encrypt-method=, password=, udp-relay=`
 * - `vmess`    `vmess, server, port, username=<uuid>, tls=, ws=, ws-path=,
 *              ws-headers=Host:.., sni=, skip-cert-verify=`
 * - `trojan`   `trojan, server, port, password=, sni=, skip-cert-verify=`
 * - `anytls`   `anytls, server, port, password=, sni=, skip-cert-verify=`
 *              (Surge iOS 5.17.0+ / Mac 6.4.3+, AnyTLS v2, UDP over TCP)
 * - `tuic`     `tuic, server, port, token=<uuid>|<password>, ...
 *              (uuid and password are joined with `:`)*
 * - `hysteria2` `hysteria2, server, port, password=, sni=, skip-cert-verify=`,
 *              plus port hopping (`port-hopping=`, `port-hopping-interval=`)
 * - `snell`    `snell, server, port, psk=, version=` (v1–v6)
 * - `socks5`/`http` (with `, tls=true` for https proxies)
 *
 * Native VLESS: RAW/WS/HTTPUpgrade/gRPC/XHTTP, with the security/flow limits
 * documented at https://manual.nssurge.com/policies/vless.html.
 * Skipped on purpose: SSR (no Surge support), shadowsocks plugins (obfs / v2ray-plugin — Surge has neither),
 * WireGuard, and any node whose required credentials are missing.
 */

import type { ClashProxyGroup, ProxyNode } from '../types';
import { isTruthyFlag } from '../utils';
import { hasVlessEncryption, unverifiedVlessOptions } from '../vless';
import { nodeSkipReason, prepareNode } from './common';
import { isWritableName, markUnemitted } from './groups';
import { buildLineGroups, joinSections, lineGroup, type LineGroup } from './groups';
import { isSnellLineValue, snellObfs, snellPsk, snellVersion } from './snell';

/** Surge's own policy names that a profile group may reference. */
export const SURGE_BUILTINS = ['DIRECT', 'REJECT'] as const;

/** Subconverter group type -> Surge `[Proxy Group]` keyword. */
const SURGE_GROUP_TYPES: Record<string, string> = {
  select: 'select',
  'url-test': 'url-test',
  fallback: 'fallback',
  'load-balance': 'load-balance',
};

export interface SurgeNodeResult {
  /** Emitted `[Proxy]` lines, one per node, in input order. */
  lines: string[];
  /** Names of the emitted proxies, in the same order. */
  names: string[];
  /** Nodes the client cannot load, with the reason (for diagnostics/tests). */
  skipped: Array<{ name: string; reason: string }>;
}

function headerValue(node: ProxyNode, name: string): string | undefined {
  const opts = node['ws-opts'] as Record<string, unknown> | undefined;
  const headers = opts?.headers as Record<string, unknown> | undefined;
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase() && value !== undefined && value !== '') {
      return String(value);
    }
  }
  return undefined;
}

function wsOptions(node: ProxyNode): string[] {
  const opts = node['ws-opts'] as Record<string, unknown> | undefined;
  const path = typeof opts?.path === 'string' && opts.path ? opts.path : '/';
  const parts = ['ws=true', `ws-path=${path}`];
  const host = headerValue(node, 'host');
  if (host) parts.push(`ws-headers=Host:${host}`);
  return parts;
}

const H2_NETWORKS = new Set(['h2', 'http']);

function isSupportedNetwork(node: ProxyNode): boolean {
  return H2_NETWORKS.has(String(node.network)) || node.network === 'ws' || !node.network;
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

/** VMess password line. Returns null when the transport is not representable. */
function vmessLine(node: ProxyNode): string | null {
  const head = `vmess, ${node.server}, ${node.port}, username=${node.uuid}`;
  if (!node.uuid) return null;

  if (node.network === 'ws') {
    const opts = wsOptions(node);
    const tls = node.tls ? ['tls=true'] : [];
    const sni = sniOf(node);
    const serverName = sni ? [`sni=${sni}`] : [];
    const insecure =
      node['skip-cert-verify'] !== undefined
        ? [`skip-cert-verify=${bool(node['skip-cert-verify'])}`]
        : [];
    return [head, ...tls, ...opts, ...serverName, ...insecure].join(', ');
  }

  // Surge's VMess only speaks raw TCP or WebSocket. HTTP/2, gRPC, Reality and
  // XTLS flows have no Surge equivalent.
  if (node.network || node['reality-opts'] || node.flow) return null;
  const parts = [head];
  if (node.tls) parts.push('tls=true');
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  parts.push('ws=false');
  return parts.join(', ');
}

/**
 * Native VLESS (iOS 6 / Mac 6.12+). Source of truth:
 * https://manual.nssurge.com/policies/vless.html (including its combination table).
 * REALITY's ML-KEM negotiation is automatic; no explicit mihomo toggle exists.
 */
function vlessLine(node: ProxyNode): string | null {
  const network = String(node.network || 'tcp');
  if (!node.uuid || !['tcp', 'raw', 'ws', 'httpupgrade', 'grpc', 'xhttp'].includes(network)) return null;
  const reality = node['reality-opts'] as Record<string, unknown> | undefined;
  const tls = isTruthyFlag(node.tls) || !!reality;
  const encrypted = hasVlessEncryption(node);
  if (reality && !reality['public-key']) return null;
  if (reality && ['ws', 'httpupgrade'].includes(network)) return null;
  if (network === 'grpc' && (!tls || node.flow)) return null;
  if (node.flow && !['xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(String(node.flow))) return null;
  if (node.flow && !encrypted && (!tls || !['tcp', 'raw'].includes(network))) return null;
  // Surge always uses XUDP; do not silently substitute another packet format.
  if (node['packet-encoding'] && node['packet-encoding'] !== 'xudp') return null;
  const parts = [`vless, ${node.server}, ${node.port}`, `username=${node.uuid}`];
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${value}`);
  };
  add('encryption', node.encryption);
  add('flow', node.flow);
  if (reality) {
    add('reality-public-key', reality['public-key']);
    add('reality-short-id', reality['short-id']);
  } else if (tls) {
    parts.push('tls=true');
    if (node['skip-cert-verify'] !== undefined) add('skip-cert-verify', bool(node['skip-cert-verify']));
  }
  add('sni', sniOf(node));
  const fingerprint = node['client-fingerprint'];
  // Official share-link mapping (policies/overview.html#importing-from-share-links).
  // These are Surge's documented approximations, not invented uTLS parameters.
  const fingerprints: Record<string, string> = {
    chrome: 'chromium-155', edge: 'chromium-155', android: 'chromium-155',
    '360': 'chromium-155', qq: 'chromium-155', safari: 'apple-26', ios: 'apple-26',
    firefox: 'auto', golang: 'auto', random: 'auto', randomized: 'auto',
    randomizedalpn: 'auto', randomizednoalpn: 'auto',
  };
  if (fingerprint) {
    const value = String(fingerprint).toLowerCase();
    const mapped = fingerprints[value] ?? (['auto', 'none', 'apple-26', 'chromium-155'].includes(value) ? value : undefined);
    if (!mapped) return null;
    add('client-fingerprint', mapped);
  }
  // Surge's ALPN is a comma-separated list inside a quoted config value.
  const alpn = alpnOf(node);
  if (alpn) add('alpn', alpn.includes(',') ? `"${alpn}"` : alpn);
  const headers = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return Object.entries(value).map(([key, val]) => `${key}:${val}`).join('|') || undefined;
  };
  if (network === 'ws' || network === 'httpupgrade') {
    const opts = (node['ws-opts'] ?? node['httpupgrade-opts'] ?? {}) as Record<string, unknown>;
    if (opts['max-early-data']) return null;
    parts.push('ws=true');
    if (network === 'httpupgrade' || isTruthyFlag(opts['v2ray-http-upgrade'])) parts.push('ws-http-upgrade=true');
    add('ws-path', opts.path || '/');
    add('ws-headers', headers(opts.headers));
  } else if (network === 'grpc') {
    const opts = (node['grpc-opts'] ?? {}) as Record<string, unknown>;
    const mode = opts['_grpc-type'] ?? opts['grpc-mode'];
    if (mode && mode !== 'gun' && mode !== 'multi') return null;
    parts.push('grpc=true');
    add('grpc-service-name', opts['grpc-service-name']);
    add('grpc-mode', mode);
    add('grpc-authority', opts['_grpc-authority'] ?? opts['grpc-authority']);
  } else if (network === 'xhttp') {
    const opts = (node['xhttp-opts'] ?? {}) as Record<string, unknown>;
    // Separate download servers have no Surge grammar. Reuse settings have no
    // verified mihomo -> Surge mapping either; never silently discard them.
    if (Object.keys(opts).some((key) => !['path', 'host', 'mode', 'headers'].includes(key))) return null;
    if (opts.mode && !['auto', 'stream-one', 'stream-up', 'packet-up'].includes(String(opts.mode))) return null;
    parts.push('xhttp=true');
    add('xhttp-path', opts.path || '/');
    add('xhttp-host', opts.host);
    add('xhttp-mode', opts.mode);
    add('xhttp-headers', headers(opts.headers));
  }
  // A value must not escape its comma-separated declaration or start a line.
  if (parts.slice(1).some((part) => /[\r\n]/.test(part) || (part.includes(',') && !/^alpn="[^"\r\n]+"$/.test(part)))) return null;
  return parts.join(', ');
}

function shadowsocksLine(node: ProxyNode): string | null {
  if (!node.cipher || !node.password) return null;
  // Surge cannot run Shadowsocks plugins, and a line without the plugin would
  // silently connect differently.
  if (node.plugin) return null;
  const parts = [`ss, ${node.server}, ${node.port}`, `encrypt-method=${node.cipher}`];
  parts.push(`password=${node.password}`);
  parts.push(`udp-relay=${bool(node.udp ?? true)}`);
  return parts.join(', ');
}

function trojanLine(node: ProxyNode): string | null {
  // Surge's Trojan is TLS-only and raw TCP: no WS/gRPC transport.
  if (!node.password || node.network) return null;
  const parts = [`trojan, ${node.server}, ${node.port}`, `password=${node.password}`];
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  if (node.udp !== undefined) parts.push(`udp-relay=${bool(node.udp)}`);
  return parts.join(', ');
}

function tuicLine(node: ProxyNode): string | null {
  const uuid = node.uuid ? String(node.uuid) : '';
  // Surge's TUIC `token` is `uuid:password`; without a UUID there is no token
  // to write (a bare password would authenticate differently).
  if (!uuid || !node.password) return null;
  const parts = [`tuic, ${node.server}, ${node.port}`, `token=${uuid}:${node.password}`];
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  if (node['disable-sni'] !== undefined) parts.push(`disable-sni=${bool(node['disable-sni'])}`);
  if (node['reduce-rtt'] !== undefined) parts.push(`reduce-rtt=${bool(node['reduce-rtt'])}`);
  return parts.join(', ');
}

/**
 * Hysteria2 `ports` ("60000-62000", "60000,61000-62000") as Surge's
 * `port-hopping` list: comma-separated entries, ranges with a `-`, entries
 * separated by **semicolons**. Empty/garbage entries are dropped; `undefined`
 * when nothing usable is left (then the declaration port applies).
 */
export function surgePortHopping(ports: unknown): string | undefined {
  if (ports === undefined || ports === null) return undefined;
  const items = String(ports)
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => /^\d+(-\d+)?$/.test(item));
  return items.length > 0 ? items.join(';') : undefined;
}

function hysteria2Line(node: ProxyNode): string | null {
  if (!node.password) return null;
  const parts = [`hysteria2, ${node.server}, ${node.port}`, `password=${node.password}`];
  if (node.obfs !== undefined && node.obfs !== '' && node.obfs !== 'none') {
    parts.push('obfs=salamander');
    if (node['obfs-password']) parts.push(`obfs-password=${node['obfs-password']}`);
  }
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  // Port hopping: when set, the client ignores the declaration port above.
  const hopping = surgePortHopping(node.ports);
  if (hopping) parts.push(`port-hopping=${hopping}`);
  const interval = node['hop-interval'];
  if (interval !== undefined && interval !== null && String(interval) !== '') {
    parts.push(`port-hopping-interval=${String(interval)}`);
  }
  // Bandwidth hints: only the download side has a confirmed Surge parameter.
  const down = node.down ?? node.downmbps;
  if (down !== undefined && down !== null && String(down) !== '') {
    parts.push(`download-bandwidth=${String(down)}`);
  }
  return parts.join(', ');
}

/**
 * AnyTLS (Surge iOS 5.17.0+ / Mac 6.4.3+, AnyTLS v2):
 * `anytls, server, port, password=, sni=, skip-cert-verify=`. TLS is implicit
 * for the protocol, so the shared TLS params carry the identity/verification
 * settings only. UDP travels over the TCP session: no extra parameter.
 */
function anytlsLine(node: ProxyNode): string | null {
  if (!node.password) return null;
  const parts = [`anytls, ${node.server}, ${node.port}`, `password=${node.password}`];
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(', ');
}

/** https://manual.nssurge.com/policies/snell.html */
function snellLine(node: ProxyNode): string | null {
  const version = snellVersion(node.version ?? 1);
  if (!version || node.userkey || node.plugin) return null;
  const psk = snellPsk(node, version);
  if (!isSnellLineValue(psk)) return null;
  const parts = ['snell', node.server, node.port, `psk=${psk}`, `version=${version}`];
  const { mode, host, uri } = snellObfs(node);
  if (mode && mode !== 'none' && mode !== 'http' && mode !== 'tls') return null;
  if (version === 6) {
    // v6 uses native traffic shaping, not the legacy HTTP/TLS obfs fields.
    if (node.mode) {
      if (node.mode !== 'default' && node.mode !== 'unshaped' && node.mode !== 'unsafe-raw') return null;
      parts.push(`mode=${node.mode}`);
    }
  } else if (mode && mode !== 'none') {
    if (mode === 'tls' && version >= 4) return null;
    parts.push(`obfs=${mode}`);
    if (host) {
      if (!isSnellLineValue(host)) return null;
      parts.push(`obfs-host=${host}`);
    }
    if (mode === 'http' && uri) {
      if (!isSnellLineValue(uri)) return null;
      parts.push(`obfs-uri=${uri}`);
    }
  }
  if (version >= 4 && node.reuse !== undefined) parts.push(`reuse=${bool(node.reuse)}`);
  // Unlike Shadowsocks, Snell's UDP relay is automatic from v3 onward;
  // udp-relay is not a Snell parameter. Only a UDP port override is available.
  if (version >= 3 && node['udp-port'] !== undefined) {
    const port = Number(node['udp-port']);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    parts.push(`udp-port=${port}`);
  }
  return parts.join(', ');
}

/** `socks5` and `http` (both plaintext and TLS proxies). */
function socksHttpLine(node: ProxyNode, type: 'socks5' | 'http'): string | null {
  const parts = [`${type}, ${node.server}, ${node.port}`];
  if (node.username !== undefined && node.username !== '') {
    parts.push(`username=${node.username}`);
  }
  if (node.password !== undefined && node.password !== '') {
    parts.push(`password=${node.password}`);
  }
  if (type === 'http' && isTruthyFlag(node.tls)) parts.push('tls=true');
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`skip-cert-verify=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(', ');
}

/**
 * Build one Surge `[Proxy]` line for a node, or the reason it is skipped.
 * Returned lines deliberately use Surge's `, ` separator.
 *
 * An *unemitted* node (`markUnemitted`) arrives as a marker carrying the skip
 * reason. Return that as-is instead of re-deriving it: a node with neither a
 * usable name nor credentials would otherwise be reported as "missing name",
 * hiding the original protocol-options diagnostic.
 *
 * The reason is *not* derived from `prepareNode`'s output: `cleanupValue`
 * strips every `_`-prefixed key, so it would never be visible there.
 */
export function surgeProxyLine(node: ProxyNode):
  | { line: string }
  | { reason: string }
  | { skipped: string } {
  const marked = nodeSkipReason(node);
  if (marked) return { reason: marked };
  if (node.type === 'easytier') return { skipped: 'unsupported protocol: easytier' };

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
    case 'vmess':
      body = vmessLine(proxy);
      break;
    case 'trojan':
      body = trojanLine(proxy);
      break;
    case 'tuic':
      body = tuicLine(proxy);
      break;
    case 'hysteria2':
      body = hysteria2Line(proxy);
      break;
    case 'socks5':
    case 'socks':
      body = socksHttpLine(proxy, 'socks5');
      break;
    case 'http':
      body = socksHttpLine(proxy, 'http');
      break;
    case 'anytls':
      body = anytlsLine(proxy);
      break;
    case 'snell':
      body = snellLine(proxy);
      break;
    case 'vless': {
      const reason = unverifiedVlessOptions(node);
      if (reason) return { skipped: reason };
      // URI gRPC mode/authority are internal metadata stripped by prepareNode.
      body = vlessLine(node);
      break;
    }
    case 'ssr':
      return { skipped: 'Surge has no ShadowsocksR support' };
    default:
      return { skipped: `unsupported protocol: ${String(proxy.type)}` };
  }

  if (!body) {
    const reason =
      proxy.type === 'ss' && proxy.plugin
        ? 'Shadowsocks plugins are not supported by Surge'
        : 'missing or unrepresentable protocol options';
    return { skipped: reason };
  }
  return { line: `${name} = ${body}` };
}

/** Names + lines of the nodes Surge can load, in input order. */
export function buildSurgeProxies(nodes: ProxyNode[]): SurgeNodeResult {
  const result: SurgeNodeResult = { lines: [], names: [], skipped: [] };
  const seen = new Set<string>();
  for (const node of nodes) {
    const built = surgeProxyLine(node);
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

/** Names of the nodes that end up in the `[Proxy]` section. */
export function surgeProxyNames(nodes: ProxyNode[]): string[] {
  return buildSurgeProxies(nodes).names;
}

/** Translate profile groups for Surge, pruning references to skipped nodes. */
export function buildSurgeGroups(
  groups: ClashProxyGroup[],
  nodeNames: Iterable<string>,
): LineGroup[] {
  return buildLineGroups(groups, nodeNames, {
    typeMap: SURGE_GROUP_TYPES,
    builtins: SURGE_BUILTINS,
  });
}

/**
 * Full Surge body: `[Proxy]` + `[Proxy Group]`, no `[Rule]`. Groups are pruned
 * against the proxies this body actually emits, whatever list the caller
 * resolved them against.
 *
 * Nodes are first resolved to either a line or a skip marker and the markers
 * are dropped again by `buildSurgeProxies`, which keeps one `skipped` list per
 * node in input order (and preserves a nameless node's reason; see
 * `markUnemitted`).
 */
export function produceSurge(nodes: ProxyNode[], groups: ClashProxyGroup[] = []): string {
  const proxies = buildSurgeProxies(markUnemitted(nodes, surgeProxyLine));
  const lines = buildSurgeGroups(groups, proxies.names).map(lineGroup);
  return joinSections([proxies.lines, lines]);
}
