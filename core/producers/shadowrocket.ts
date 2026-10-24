// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shadowrocket producer: a base64 subscription of V2Ray-style share links.
 *
 * Shadowrocket imports the same URI schemes the repo's URI parser consumes
 * (`core/parsers/uri.ts`), so each link here is the inverse of that parser:
 * parsing a produced line must yield the same node back. Links are joined with
 * `\n` and the whole payload is base64-encoded, which is what Shadowrocket
 * expects from a subscription URL (Content-Type: text/plain). There is no
 * Shadowrocket group syntax: the profile is not applied to this target.
 *
 * Per-protocol link shapes:
 * - `ss://`          SIP002: `ss://base64url(method:password)@host:port?plugin=…#name`
 * - `ssr://`         `ssr://base64(host:port:protocol:method:obfs:base64(password)/?params)`
 * - `vmess://`       V2rayN JSON, base64-encoded
 * - `vless://`, `trojan://`, `hysteria2://`, `tuic://`, `anytls://` standard URIs
 * - `socks://`, `http://` (also `https://` for TLS http proxies)
 *
 * Nodes Shadowrocket cannot load (anything without a share-link form, e.g.
 * chained proxies or missing credentials) are skipped, never faked.
 */

import type { ProxyNode } from '../types';
import {
  encodeBase64,
  isTruthyFlag,
  normalizeVmessSecurity,
  stripIpv6Brackets,
} from '../utils';
import { prepareNode } from './common';

export interface PrefixNodeResult {
  /** One share link per representable node, in input order. */
  lines: string[];
  /** Names of the emitted nodes, in the same order. */
  names: string[];
  /** Skipped nodes with the reason (diagnostics/tests). */
  skipped: Array<{ name: string; reason: string }>;
}

const encode = (value: unknown): string => encodeURIComponent(String(value ?? ''));

/** IPv6 hosts need brackets inside a URI authority. */
function host(server: string): string {
  return server.includes(':') ? `[${stripIpv6Brackets(server)}]` : server;
}

function fragment(name: string): string {
  return `#${encode(name)}`;
}

/** WebSocket / gRPC / h2 / http transport query parameters, shared by V2Ray links. */
function transportQuery(node: ProxyNode): string[] {
  const params: string[] = [];
  const ws = node['ws-opts'] as Record<string, unknown> | undefined;
  const grpc = node['grpc-opts'] as Record<string, unknown> | undefined;
  const h2 = node['h2-opts'] as Record<string, unknown> | undefined;
  const headers = ws?.headers as Record<string, unknown> | undefined;
  const wsHost = headers
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'host')?.[1]
    : undefined;

  switch (node.network) {
    case 'ws':
      params.push('type=ws');
      if (wsHost) params.push(`host=${encode(wsHost)}`);
      if (typeof ws?.path === 'string' && ws.path) params.push(`path=${encode(ws.path)}`);
      break;
    case 'grpc': {
      params.push('type=grpc');
      const service = grpc?.['grpc-service-name'];
      if (service) params.push(`serviceName=${encode(service)}`);
      break;
    }
    case 'h2': {
      params.push('type=http');
      const hosts = h2?.host;
      const h2Host = Array.isArray(hosts) ? hosts.join(',') : hosts;
      if (h2Host) params.push(`host=${encode(h2Host)}`);
      if (typeof h2?.path === 'string' && h2.path) params.push(`path=${encode(h2.path)}`);
      break;
    }
    case 'http':
      params.push('type=tcp', 'headerType=http');
      if (wsHost) params.push(`host=${encode(wsHost)}`);
      if (typeof ws?.path === 'string' && ws.path) params.push(`path=${encode(ws.path)}`);
      break;
    default:
      break;
  }
  return params;
}

function tlsQuery(node: ProxyNode): string[] {
  const params: string[] = [];
  const reality = node['reality-opts'] as Record<string, unknown> | undefined;
  if (reality) {
    params.push('security=reality');
    if (reality['public-key']) params.push(`pbk=${encode(reality['public-key'])}`);
    if (reality['short-id']) params.push(`sid=${encode(reality['short-id'])}`);
    if (reality['_spider-x']) params.push(`spx=${encode(reality['_spider-x'])}`);
  } else if (node.tls) {
    params.push('security=tls');
  } else {
    params.push('security=none');
  }
  const sni = node.sni ?? node.servername;
  if (sni) params.push(`sni=${encode(sni)}`);
  if (node['client-fingerprint']) params.push(`fp=${encode(node['client-fingerprint'])}`);
  if (node.alpn !== undefined) {
    const alpn = Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn);
    if (alpn) params.push(`alpn=${encode(alpn)}`);
  }
  if (node['skip-cert-verify'] !== undefined) {
    params.push(`allowInsecure=${isTruthyFlag(node['skip-cert-verify']) ? 1 : 0}`);
  }
  if (node['tls-fingerprint']) params.push(`pcs=${encode(node['tls-fingerprint'])}`);
  return params;
}

function query(params: string[]): string {
  return params.length > 0 ? `?${params.join('&')}` : '';
}

function shadowsocksPlugin(node: ProxyNode): string | undefined {
  const plugin = node.plugin;
  if (!plugin) return undefined;
  const opts = (node['plugin-opts'] as Record<string, unknown> | undefined) ?? {};
  if (plugin === 'obfs') {
    // The URI parser reads `obfs-local`/`simple-obfs` back into `plugin: obfs`.
    const parts = ['simple-obfs'];
    if (opts.mode) parts.push(`obfs=${opts.mode}`);
    if (opts.host) parts.push(`obfs-host=${opts.host}`);
    return parts.join(';');
  }
  if (plugin === 'v2ray-plugin') {
    const parts = ['v2ray-plugin'];
    if (opts.mode) parts.push(`mode=${opts.mode}`);
    if (opts.host) parts.push(`host=${opts.host}`);
    if (opts.path) parts.push(`path=${opts.path}`);
    if (opts.tls === true || isTruthyFlag(opts.tls)) parts.push('tls');
    if (opts.mux === true || isTruthyFlag(opts.mux)) parts.push('mux');
    return parts.join(';');
  }
  return undefined;
}

function shadowsocksLink(node: ProxyNode): string | null {
  if (!node.cipher || !node.password) return null;
  // SIP002 user info is base64url(method:password), unpadded (matching the
  // conventions of the repo's own URI parser).
  const userInfo = encodeBase64(`${node.cipher}:${node.password}`)
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const params: string[] = [];
  const plugin = shadowsocksPlugin(node);
  if (node.plugin && !plugin) return null;
  if (plugin) params.push(`plugin=${encode(plugin)}`);
  if (node['udp-over-tcp']) {
    const version = node['udp-over-tcp-version'];
    params.push(`uot=${version === 2 ? 'sp.v2' : version === 1 ? 'sp.v1' : 1}`);
  }
  return `ss://${userInfo}@${host(String(node.server))}:${node.port}${query(params)}${fragment(
    String(node.name),
  )}`;
}

function ssrLink(node: ProxyNode): string | null {
  if (!node.cipher || !node.password || !node.protocol || !node.obfs) return null;
  // SSR parameters are plain (padded) base64, not percent-encoded, matching
  // what the repo's SSR parser (and Shadowrocket) reads back.
  const b64 = (value: unknown) => encodeBase64(String(value ?? ''));
  const main = [
    stripIpv6Brackets(String(node.server)),
    node.port,
    node.protocol,
    node.cipher,
    node.obfs,
    b64(node.password),
  ].join(':');
  const params = [`remarks=${b64(node.name)}`];
  if (node['protocol-param']) params.push(`protoparam=${b64(node['protocol-param'])}`);
  if (node['obfs-param']) params.push(`obfsparam=${b64(node['obfs-param'])}`);
  if (node.group) params.push(`group=${b64(node.group)}`);
  // No `#name` fragment: an SSR link *is* the base64 payload, and appending a
  // fragment makes the whole link undecodable (for Shadowrocket and for the
  // repo's own `parseSsr`). The name travels in `remarks=`.
  return `ssr://${encodeBase64(`${main}/?${params.join('&')}`)}`;
}

function vmessLink(node: ProxyNode): string | null {
  if (!node.uuid) return null;
  const ws = node['ws-opts'] as Record<string, unknown> | undefined;
  const headers = ws?.headers as Record<string, unknown> | undefined;
  const wsHost = headers
    ? Object.entries(headers).find(([key]) => key.toLowerCase() === 'host')?.[1]
    : undefined;
  const grpc = node['grpc-opts'] as Record<string, unknown> | undefined;
  const h2 = node['h2-opts'] as Record<string, unknown> | undefined;
  const sni = node.sni ?? node.servername;

  const payload: Record<string, unknown> = {
    v: '2',
    ps: node.name,
    add: stripIpv6Brackets(String(node.server)),
    port: String(node.port),
    id: node.uuid,
    aid: String(node.alterId ?? 0),
    scy: normalizeVmessSecurity(node.cipher ?? 'auto'),
    net: node.network || 'tcp',
    type: 'none',
    host: '',
    path: '',
    tls: node.tls ? 'tls' : '',
    sni: sni ? String(sni) : '',
  };
  if (node.network === 'ws') {
    payload.host = wsHost ? String(wsHost) : '';
    payload.path = typeof ws?.path === 'string' ? ws.path : '/';
  } else if (node.network === 'grpc') {
    payload.path = grpc?.['grpc-service-name'] ? String(grpc['grpc-service-name']) : '';
  } else if (node.network === 'h2') {
    const hosts = h2?.host;
    payload.host = Array.isArray(hosts) ? hosts.join(',') : String(hosts ?? '');
    payload.path = typeof h2?.path === 'string' ? h2.path : '';
  }
  if (node['skip-cert-verify'] !== undefined) {
    payload.allowInsecure = node['skip-cert-verify'] ? 1 : 0;
  }
  if (node.alpn !== undefined) {
    payload.alpn = Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn);
  }
  if (node['client-fingerprint']) payload.fp = node['client-fingerprint'];
  return `vmess://${encodeBase64(JSON.stringify(payload))}`;
}

/**
 * `http` (TCP + HTTP obfuscation) opts live under `http-opts`, a shape
 * `transportQuery` does not write: it would emit the `ws-opts` values instead.
 * VLESS cannot do the `headerType=http` variant at all, and a mismatched
 * option set is worse than a skipped node.
 */
function httpTransportUnsupported(node: ProxyNode): boolean {
  return node.network === 'http';
}

function vlessLink(node: ProxyNode): string | null {
  if (!node.uuid) return null;
  if (httpTransportUnsupported(node)) return null;
  const params = [
    `encryption=${encode(node.encryption ?? 'none')}`,
    ...tlsQuery(node),
    ...transportQuery(node),
  ];
  if (node.flow) params.push(`flow=${encode(node.flow)}`);
  return `vless://${encode(node.uuid)}@${host(String(node.server))}:${node.port}${query(
    params,
  )}${fragment(String(node.name))}`;
}

function trojanLink(node: ProxyNode): string | null {
  if (!node.password) return null;
  if (httpTransportUnsupported(node)) return null;
  // Trojan is TLS-only; keep the TLS options but never emit a second
  // `security=` (tlsQuery would report `none` for a node without `tls`).
  const params = [
    'security=tls',
    ...tlsQuery(node).filter((param) => !param.startsWith('security=')),
    ...transportQuery(node),
  ];
  return `trojan://${encode(node.password)}@${host(String(node.server))}:${node.port}${query(
    params,
  )}${fragment(String(node.name))}`;
}

/**
 * Hysteria2 carries a password, never a UUID (a UUID-bearing node is a
 * mis-parsed Hysteria v1 / v2ray link, not a hy2 node).
 *
 * Port hopping and the bandwidth hints *do* have link-level expressions in
 * the ecosystem, and this repo's own parser reads them back: `mport` (the
 * `ports` list) and `upmbps`/`downmbps`. They are emitted, never used as a
 * reason to drop the node — dropping them was what silently removed 11 of 71
 * real nodes from a subscription.
 */
function hysteria2Link(node: ProxyNode): string | null {
  if (!node.password || node.uuid) return null;
  const params: string[] = [];
  const sni = node.sni ?? node.servername;
  if (sni) params.push(`sni=${encode(sni)}`);
  if (node.obfs && node.obfs !== 'none') {
    params.push(`obfs=${encode(node.obfs)}`);
    if (node['obfs-password']) params.push(`obfs-password=${encode(node['obfs-password'])}`);
  }
  if (node.ports !== undefined && node.ports !== null && String(node.ports) !== '') {
    params.push(`mport=${encode(node.ports)}`);
  }
  if (node['skip-cert-verify'] !== undefined) {
    params.push(`insecure=${isTruthyFlag(node['skip-cert-verify']) ? 1 : 0}`);
  }
  if (node['tls-fingerprint']) params.push(`pinSHA256=${encode(node['tls-fingerprint'])}`);
  if (node.alpn !== undefined) {
    const alpn = Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn);
    if (alpn) params.push(`alpn=${encode(alpn)}`);
  }
  if (node.up !== undefined && node.up !== null) params.push(`upmbps=${encode(node.up)}`);
  if (node.down !== undefined && node.down !== null) params.push(`downmbps=${encode(node.down)}`);
  const hopInterval = node['hop-interval'];
  if (hopInterval !== undefined && hopInterval !== null && String(hopInterval) !== '') {
    params.push(`hop-interval=${encode(hopInterval)}`);
  }
  return `hysteria2://${encode(node.password)}@${host(String(node.server))}:${node.port}${query(
    params,
  )}${fragment(String(node.name))}`;
}

/**
 * TUIC authenticates with `uuid:password` in the user info. A node that only
 * carries a `token` (or a bare password) has no equivalent URI form here, so it
 * is skipped rather than emitted with empty credentials.
 */
function tuicLink(node: ProxyNode): string | null {
  const uuid = node.uuid ? String(node.uuid) : '';
  const password = node.password ? String(node.password) : '';
  if (!uuid || !password) return null;
  const params: string[] = [];
  const sni = node.sni;
  if (sni) params.push(`sni=${encode(sni)}`);
  if (node.alpn !== undefined) {
    const alpn = Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn);
    if (alpn) params.push(`alpn=${encode(alpn)}`);
  }
  const congestion = node['congestion-controller'];
  if (congestion) params.push(`congestion_control=${encode(congestion)}`);
  const relay = node['udp-relay-mode'];
  if (relay) params.push(`udp_relay_mode=${encode(relay)}`);
  if (node['skip-cert-verify'] !== undefined) {
    params.push(`insecure=${isTruthyFlag(node['skip-cert-verify']) ? 1 : 0}`);
  }
  return `tuic://${encode(`${uuid}:${password}`)}@${host(String(node.server))}:${node.port}${query(
    params,
  )}${fragment(String(node.name))}`;
}

function anytlsLink(node: ProxyNode): string | null {
  if (!node.password || node.uuid) return null;
  const params: string[] = [];
  const sni = node.sni;
  if (sni) params.push(`sni=${encode(sni)}`);
  if (node.alpn !== undefined) {
    const alpn = Array.isArray(node.alpn) ? node.alpn.join(',') : String(node.alpn);
    if (alpn) params.push(`alpn=${encode(alpn)}`);
  }
  if (node['skip-cert-verify'] !== undefined) {
    params.push(`insecure=${isTruthyFlag(node['skip-cert-verify']) ? 1 : 0}`);
  }
  if (node['client-fingerprint']) params.push(`fp=${encode(node['client-fingerprint'])}`);
  return `anytls://${encode(node.password)}@${host(String(node.server))}:${node.port}${query(
    params,
  )}${fragment(String(node.name))}`;
}

/** SOCKS5 / HTTP proxies (`socks5` is emitted with the `socks://` scheme). */
function socksHttpLink(node: ProxyNode, scheme: 'socks' | 'http' | 'https'): string | null {
  const auth =
    node.username !== undefined && node.username !== ''
      ? `${encode(node.username)}:${encode(node.password ?? '')}@`
      : '';
  return `${scheme}://${auth}${host(String(node.server))}:${node.port}${fragment(
    String(node.name),
  )}`;
}

/** Build the share link for one node, or the reason it is skipped. */
export function shadowrocketLink(node: ProxyNode): { line: string } | { skipped: string } {
  const proxy = prepareNode(node);
  const name = String(proxy.name ?? '').trim();
  if (!name) return { skipped: 'missing name' };
  if (!proxy.server || !proxy.port) return { skipped: 'missing server/port' };
  if (proxy['underlying-proxy'] || proxy['dialer-proxy']) {
    return { skipped: 'chained proxy not representable as a share link' };
  }

  let line: string | null;
  switch (proxy.type) {
    case 'ss':
      line = shadowsocksLink(proxy);
      break;
    case 'ssr':
      line = ssrLink(proxy);
      break;
    case 'vmess':
      // `http-opts` is a VLESS-only shape; the VMess writer has no field for
      // the `http` transport, so the node would silently become plain TCP.
      line = httpTransportUnsupported(proxy) ? null : vmessLink(proxy);
      break;
    case 'vless':
      line = vlessLink(proxy);
      break;
    case 'trojan':
      line = trojanLink(proxy);
      break;
    case 'hysteria2':
      line = hysteria2Link(proxy);
      break;
    case 'tuic':
      line = tuicLink(proxy);
      break;
    case 'anytls':
      line = anytlsLink(proxy);
      break;
    case 'socks5':
    case 'socks':
      line = socksHttpLink(proxy, 'socks');
      break;
    case 'http':
      line = socksHttpLink(proxy, isTruthyFlag(proxy.tls) ? 'https' : 'http');
      break;
    case 'snell':
      // Shadowrocket has no published share-link scheme for Snell.
      return { skipped: 'Shadowrocket has no Snell share link' };
    default:
      return { skipped: `unsupported protocol: ${String(proxy.type)}` };
  }

  if (!line) return { skipped: 'missing or unrepresentable protocol options' };
  return { line };
}

/**
 * Share links + emitted names for the nodes Shadowrocket can import.
 *
 * Shadowrocket keeps one profile entry per node *name*, so a repeated name
 * would silently collapse two links; a duplicate is skipped (the first wins)
 * and reported, exactly like the line-based clients do.
 */
export function buildShadowrocketSubscription(nodes: ProxyNode[]): PrefixNodeResult {
  const result: PrefixNodeResult = { lines: [], names: [], skipped: [] };
  const seen = new Set<string>();
  for (const node of nodes) {
    const built = shadowrocketLink(node);
    if ('line' in built) {
      const name = String(node.name);
      if (seen.has(name)) {
        result.skipped.push({ name, reason: 'duplicate name' });
        continue;
      }
      seen.add(name);
      result.lines.push(built.line);
      result.names.push(name);
      continue;
    }
    result.skipped.push({ name: String(node.name ?? ''), reason: built.skipped });
  }
  return result;
}

/** Plain share links for the nodes Shadowrocket can import. */
export function buildShadowrocketLinks(nodes: ProxyNode[]): string[] {
  return buildShadowrocketSubscription(nodes).lines;
}

/**
 * Full Shadowrocket body: base64 of the newline-joined links. With nothing
 * representable the payload stays empty (`base64('') === ''`), i.e. an empty
 * but valid document rather than a fake node.
 */
export function produceShadowrocket(nodes: ProxyNode[]): string {
  return encodeBase64(buildShadowrocketLinks(nodes).join('\n'));
}
