// SPDX-License-Identifier: AGPL-3.0-only
/**
 * sing-box producer: `{ "outbounds": [...] }` (sing-box >= 1.11/1.12 JSON).
 *
 * Only what sing-box actually accepts is emitted; unknown node types and
 * features sing-box has no field for are skipped, never approximated. Field
 * names follow the sing-box outbound schema
 * (https://sing-box.sagernet.org/configuration/outbound/):
 *
 *   type                node types
 *   ─────────────────── ────────────────────────────────────────────────────
 *   shadowsocks         ss (method/password, plugin, udp_over_tcp)
 *   vmess               vmess (uuid/security/alter_id, transport, tls)
 *   vless               vless (uuid/flow, transport, tls incl. reality/utls)
 *   trojan              trojan (password, transport, tls, multiplex)
 *   tuic                tuic (uuid/password, congestion_control, udp_relay_mode)
 *   hysteria            hysteria (auth_str/up/down, obfs)
 *   hysteria2           hysteria2 (password, obfs, up/down, port ranges)
 *   anytls              anytls (password, idle_session_*, tls)
 *   wireguard           wireguard (peers[0] from the node)
 *   socks / http        local dialer outbounds carry no credentials, so
 *                       authenticated proxies are skipped (see below)
 *
 * Skipped: ssr/snell/direct and every other type (no sing-box outbound),
 * a non-empty HTTP/SOCKS username (sing-box rejects credentials there),
 * wireguard nodes without a key, and transports sing-box has no JSON field for
 * in the given outbound (e.g. `httpupgrade` on trojan).
 */
import type { ProxyNode } from '../types';
import { parseAlpn } from '../utils';
import { normalizeCommonTransport, prepareNode } from './common';

/** sing-box outbound types this producer can emit. */
export const SINGBOX_SUPPORTED_TYPES = [
  'ss',
  'vmess',
  'vless',
  'trojan',
  'tuic',
  'hysteria',
  'hysteria2',
  'anytls',
  'wireguard',
  'socks',
  'http',
] as const;

/** A sing-box outbound. `server_port` is absent for hysteria2 port hopping. */
export interface SingboxOutbound {
  type: string;
  tag: string;
  server: string;
  server_port?: number;
  [key: string]: unknown;
}

export interface SingboxConfig {
  outbounds: SingboxOutbound[];
}

type Opts = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function positiveInt(value: unknown, fallback?: number): number | undefined {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const rendered = text(entry);
    if (rendered !== undefined) output[key] = rendered;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function alpnList(node: ProxyNode): string[] | undefined {
  if (Array.isArray(node.alpn)) {
    const list = node.alpn.map((entry) => text(entry)).filter((entry): entry is string => !!entry);
    return list.length > 0 ? list : undefined;
  }
  return parseAlpn(text(node.alpn));
}

/** `{ type, path, headers? }` for ws/httpupgrade; `null` for "no transport". */
function transportFor(
  node: ProxyNode,
  allowed: readonly string[],
): { transport: Record<string, unknown> | null; unsupported: boolean } {
  const network = text(node.network);
  if (!network || network === 'tcp' || network === 'none') return { transport: null, unsupported: false };
  if (!allowed.includes(network)) return { transport: null, unsupported: true };

  const opts = (node[`${network}-opts`] as Opts | undefined) ?? {};
  if (network === 'ws') {
    const headers = stringMap(opts.headers);
    const earlyData = positiveInt(opts['max-early-data']);
    return {
      transport: {
        // HTTPUpgrade is the same outbound type with `path`/`headers`.
        type: opts['v2ray-http-upgrade'] ? 'httpupgrade' : 'ws',
        path: text(opts.path) ?? '/',
        ...(headers ? { headers } : {}),
        ...(earlyData !== undefined && earlyData > 0 ? { max_early_data: earlyData } : {}),
        ...(text(opts['early-data-header-name'])
          ? { early_data_header_name: text(opts['early-data-header-name']) }
          : {}),
      },
      unsupported: false,
    };
  }
  if (network === 'grpc') {
    return {
      transport: {
        type: 'grpc',
        service_name: text(opts['grpc-service-name']) ?? '',
      },
      unsupported: false,
    };
  }
  if (network === 'h2' || network === 'http') return { transport: null, unsupported: true };
  return { transport: null, unsupported: true };
}

/**
 * `tls` block (sing-box: `enabled`, `server_name`, `insecure`, `alpn`,
 * `utls.fingerprint`, `reality.public_key/short_id`). Returns `undefined` when
 * TLS is off, `null` when the node needs a TLS feature sing-box cannot express.
 */
function tlsFor(
  node: ProxyNode,
  options: { implicit?: boolean; requireServerName?: boolean } = {},
): Record<string, unknown> | null | undefined {
  const reality = node['reality-opts'] as Opts | undefined;
  const enabled = options.implicit === true || node.tls === true || reality !== undefined;
  if (!enabled) return undefined;

  const block: Record<string, unknown> = { enabled: true };

  const serverName = text(node.sni) ?? text(node.servername);
  if (serverName) block.server_name = serverName;
  if (node['skip-cert-verify'] === true) block.insecure = true;
  const alpn = alpnList(node);
  if (alpn) block.alpn = alpn;

  if (reality) {
    const publicKey = text(reality['public-key']);
    if (!publicKey) return null; // Reality needs a public key in sing-box.
    block.reality = {
      enabled: true,
      public_key: publicKey,
      ...(text(reality['short-id']) ? { short_id: text(reality['short-id']) } : {}),
    };
    // sing-box's REALITY client must send a uTLS fingerprint.
    block.utls = {
      enabled: true,
      fingerprint: text(node['client-fingerprint']) ?? 'chrome',
    };
    return block;
  }

  const fingerprint = text(node['client-fingerprint']);
  if (fingerprint) block.utls = { enabled: true, fingerprint };
  return block;
}

/** Multiplex block when the node asks for it (sing-box requires `enabled`). */
function multiplexFor(node: ProxyNode): Record<string, unknown> | undefined {
  const smux = node.smux as Opts | undefined;
  if (!smux || smux.enabled !== true) return undefined;
  const protocol = text(smux.protocol);
  const maxConnections = positiveInt(smux['max-connections']);
  const padding = smux.padding;
  return {
    enabled: true,
    ...(protocol ? { protocol } : {}),
    ...(maxConnections !== undefined ? { max_connections: maxConnections } : {}),
    ...(padding === true ? { padding: true } : {}),
  };
}

function base(node: ProxyNode, type: string): SingboxOutbound {
  return {
    type,
    tag: node.name,
    server: node.server,
    server_port: node.port,
  };
}

/**
 * Transports sing-box has a JSON field for in these outbounds. `h2` has none
 * (sing-box only speaks it over a TLS-only inbound), so such nodes are skipped.
 */
const V2RAY_TRANSPORTS = ['ws', 'grpc', 'httpupgrade'] as const;
const TROJAN_TRANSPORTS = V2RAY_TRANSPORTS;

function shadowsocks(node: ProxyNode): SingboxOutbound | null {
  const method = text(node.cipher);
  const password = text(node.password);
  if (!method || password === undefined) return null;
  const outbound = base(node, 'shadowsocks');
  outbound.method = method;
  outbound.password = password;

  const plugin = text(node.plugin);
  const pluginOpts = (node['plugin-opts'] as Opts | undefined) ?? {};
  if (plugin === 'obfs') {
    const mode = text(pluginOpts.mode) ?? 'http';
    const host = text(pluginOpts.host);
    outbound.plugin = 'obfs-local';
    outbound.plugin_opts = host ? `obfs=${mode};obfs-host=${host}` : `obfs=${mode}`;
  } else if (plugin === 'v2ray-plugin') {
    const parts: string[] = [];
    const mode = text(pluginOpts.mode);
    if (mode) parts.push(`mode=${mode}`);
    if (pluginOpts.tls === true) parts.push('tls');
    const host = text(pluginOpts.host);
    if (host) parts.push(`host=${host}`);
    const path = text(pluginOpts.path);
    if (path) parts.push(`path=${path}`);
    if (pluginOpts.mux === true) parts.push('mux=1');
    outbound.plugin = 'v2ray-plugin';
    if (parts.length > 0) outbound.plugin_opts = parts.join(';');
  } else if (plugin) {
    // Unknown SIP003 plugin: sing-box cannot load it.
    return null;
  }

  if (node['udp-over-tcp'] === true) {
    const version = positiveInt(node['udp-over-tcp-version']);
    outbound.udp_over_tcp = { enabled: true, ...(version !== undefined ? { version } : {}) };
  }
  return outbound;
}

function vmess(node: ProxyNode): SingboxOutbound | null {
  const uuid = text(node.uuid);
  if (!uuid) return null;
  const { transport, unsupported } = transportFor(node, V2RAY_TRANSPORTS);
  if (unsupported) return null;

  const outbound = base(node, 'vmess');
  outbound.uuid = uuid;
  outbound.security = text(node.cipher) ?? 'auto';
  const alterId = positiveInt(node.alterId, 0) ?? 0;
  if (alterId > 0) outbound.alter_id = alterId;
  const tls = tlsFor(node);
  if (tls === null) return null;
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  const multiplex = multiplexFor(node);
  if (multiplex) outbound.multiplex = multiplex;
  return outbound;
}

function vless(node: ProxyNode): SingboxOutbound | null {
  const uuid = text(node.uuid);
  if (!uuid) return null;
  const { transport, unsupported } = transportFor(node, V2RAY_TRANSPORTS);
  if (unsupported) return null;
  const tls = tlsFor(node);
  if (tls === null) return null;

  const outbound = base(node, 'vless');
  outbound.uuid = uuid;
  const flow = text(node.flow);
  if (flow) outbound.flow = flow;
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  const multiplex = multiplexFor(node);
  if (multiplex) outbound.multiplex = multiplex;
  return outbound;
}

function trojan(node: ProxyNode): SingboxOutbound | null {
  const password = text(node.password);
  if (password === undefined) return null;
  const { transport, unsupported } = transportFor(node, TROJAN_TRANSPORTS);
  if (unsupported) return null;
  const tls = tlsFor(node, { implicit: true });
  if (tls === null) return null;

  const outbound = base(node, 'trojan');
  outbound.password = password;
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  const multiplex = multiplexFor(node);
  if (multiplex) outbound.multiplex = multiplex;
  return outbound;
}

function tuic(node: ProxyNode): SingboxOutbound | null {
  const uuid = text(node.uuid);
  const password = text(node.password);
  if (!uuid || password === undefined) return null;
  const tls = tlsFor(node, { implicit: true });
  if (tls === null) return null;

  const outbound = base(node, 'tuic');
  outbound.uuid = uuid;
  outbound.password = password;
  const congestion = text(node['congestion-controller']);
  if (congestion) outbound.congestion_control = congestion;
  const relayMode = text(node['udp-relay-mode']);
  if (relayMode) outbound.udp_relay_mode = relayMode;
  if (node['udp-over-tcp'] === true) outbound.udp_over_stream = true;
  if (node['reduce-rtt'] === true) outbound.zero_rtt_handshake = true;
  const heartbeat = text(node['heartbeat-interval']);
  if (heartbeat) outbound.heartbeat = `${heartbeat}s`;
  if (tls) outbound.tls = tls;
  return outbound;
}

/** `50` / `'50'` / `'50 mbps'` -> `50` (sing-box uses Mbps integers). */
function bandwidth(value: unknown): number | undefined {
  const rendered = text(value);
  if (!rendered) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(?:mbps|m|M)?$/i.exec(rendered.replace(/,/g, ''));
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function hysteria(node: ProxyNode): SingboxOutbound | null {
  const auth = text(node['auth-str']) ?? text(node['auth_str']) ?? text(node.password);
  if (!auth) return null;
  const tls = tlsFor(node, { implicit: true });
  if (tls === null) return null;

  const outbound = base(node, 'hysteria');
  outbound.auth_str = auth;
  const up = bandwidth(node.up) ?? bandwidth(node.upmbps);
  const down = bandwidth(node.down) ?? bandwidth(node.downmbps);
  if (up === undefined || down === undefined) {
    // sing-box requires both bandwidth hints for hysteria v1.
    return null;
  }
  outbound.up_mbps = up;
  outbound.down_mbps = down;
  if (tls) outbound.tls = tls;
  return outbound;
}

/** Hysteria2 port hopping (`mport`/`ports`) -> sing-box `server_ports` list. */
export function singboxServerPorts(ports: string | undefined): string[] | undefined {
  if (!ports) return undefined;
  const rendered: string[] = [];
  for (const part of ports.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(item);
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : undefined;
    if (start < 1 || start > 65535) return undefined;
    if (end !== undefined && (end < start || end > 65535)) return undefined;
    rendered.push(end === undefined ? item : `${start}:${end}`);
  }
  return rendered.length > 0 ? rendered : undefined;
}

function hysteria2(node: ProxyNode): SingboxOutbound | null {
  const password = text(node.password);
  if (password === undefined) return null;
  const tls = tlsFor(node, { implicit: true });
  if (tls === null) return null;

  const outbound = base(node, 'hysteria2');
  outbound.password = password;
  const obfs = text(node.obfs);
  if (obfs && obfs !== 'none') {
    outbound.obfs = { type: obfs, ...(text(node['obfs-password']) ? { password: text(node['obfs-password']) } : {}) };
  }
  const up = bandwidth(node.up) ?? bandwidth(node.upmbps);
  const down = bandwidth(node.down) ?? bandwidth(node.downmbps);
  if (up !== undefined) outbound.up_mbps = up;
  if (down !== undefined) outbound.down_mbps = down;
  if (tls) outbound.tls = tls;
  // sing-box's hysteria2 outbound replaces `server`/`server_port` with
  // `server_ports` (never both), and only understands the `a:b` range form.
  const serverPorts = singboxServerPorts(text(node.ports));
  if (serverPorts) {
    const { server_port: _serverPort, ...hopping } = outbound;
    return { ...hopping, server_ports: serverPorts } as SingboxOutbound;
  }
  return outbound;
}

function anytls(node: ProxyNode): SingboxOutbound | null {
  const password = text(node.password);
  if (password === undefined) return null;
  const tls = tlsFor(node, { implicit: true });
  if (tls === null) return null;

  const outbound = base(node, 'anytls');
  outbound.password = password;
  if (tls) outbound.tls = tls;
  const idleInterval = text(node['idle-session-check-interval']);
  if (idleInterval) outbound.idle_session_check_interval = `${idleInterval}s`;
  const idleTimeout = text(node['idle-session-timeout']);
  if (idleTimeout) outbound.idle_session_timeout = `${idleTimeout}s`;
  const minIdle = text(node['min-idle-session']);
  if (minIdle) outbound.min_idle_session = positiveInt(minIdle);
  return outbound;
}

/** sing-box 1.11+ `wireguard` outbound: one peer per endpoint. */
function wireguard(node: ProxyNode): SingboxOutbound | null {
  const privateKey = text(node['private-key']);
  const publicKey = text(node['public-key']);
  if (!privateKey || !publicKey) return null;

  const outbound = base(node, 'wireguard');
  // In sing-box the endpoint (`server`/`server_port`) lives on the peer, not
  // on the outbound itself; the key pair moved up to the outbound in 1.11.
  const peer: Record<string, unknown> = {
    server: node.server,
    server_port: node.port,
    public_key: publicKey,
  };
  const preSharedKey = text(node['pre-shared-key']);
  if (preSharedKey) peer.pre_shared_key = preSharedKey;
  if (Array.isArray(node.reserved) && node.reserved.length === 3) {
    peer.reserved = node.reserved.map((entry) => Number(entry));
  }
  outbound.private_key = privateKey;
  outbound.peers = [peer];
  const localAddress = node['local-address'] ?? node.address;
  const addresses = (Array.isArray(localAddress) ? localAddress : [localAddress])
    .map((entry) => text(entry))
    .filter((entry): entry is string => !!entry);
  if (addresses.length > 0) outbound.local_address = addresses;
  const mtu = positiveInt(node.mtu);
  if (mtu !== undefined) outbound.mtu = mtu;
  return outbound;
}

/**
 * SOCKS/HTTP proxies. sing-box's `socks`/`http` outbounds are unauthenticated
 * dialers (there is no username/password field), so a credentialed proxy is
 * not representable and `null` is returned instead of leaking the node
 * without its credentials.
 */
function socksLike(node: ProxyNode): SingboxOutbound | null {
  const username = text(node.username);
  const password = text(node.password);
  if (username !== undefined || password !== undefined) return null;
  const outbound = base(node, node.type === 'socks' || node.type === 'socks5' ? 'socks' : 'http');
  if (!node.tls) return outbound;
  const tls = tlsFor(node);
  if (tls === null) return null;
  if (tls) outbound.tls = tls;
  return outbound;
}

/** Map one node to a sing-box outbound, or `null` when sing-box cannot express it. */
export function toSingboxOutbound(node: ProxyNode): SingboxOutbound | null {
  if (!node.server || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    return null;
  }
  if (typeof node.name !== 'string' || node.name === '') return null;

  switch (node.type) {
    case 'ss':
      return shadowsocks(node);
    case 'vmess':
      return vmess(node);
    case 'vless':
      return vless(node);
    case 'trojan':
      return trojan(node);
    case 'tuic':
      return tuic(node);
    case 'hysteria':
      return hysteria(node);
    case 'hysteria2':
      return hysteria2(node);
    case 'anytls':
      return anytls(node);
    case 'wireguard':
      return wireguard(node);
    case 'socks':
    case 'socks5':
    case 'http':
      return socksLike(node);
    default:
      // ssr, snell, direct, jsons, …: no sing-box outbound type.
      return null;
  }
}

/** Drop `undefined` values a builder may have assigned. */
function compact(outbound: SingboxOutbound): SingboxOutbound {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outbound)) {
    if (value !== undefined) output[key] = value;
  }
  return output as unknown as SingboxOutbound;
}

/** Outbounds for the nodes sing-box can express, in input order. */
export function buildSingboxOutbounds(nodes: ProxyNode[]): SingboxOutbound[] {
  const outbounds: SingboxOutbound[] = [];
  for (const raw of nodes) {
    const node = prepareNode(raw);
    normalizeCommonTransport(node);
    const outbound = toSingboxOutbound(node);
    if (outbound) outbounds.push(compact(outbound));
  }
  return outbounds;
}

/**
 * The `singbox` export body: `{ "outbounds": [...] }`, two-space indented,
 * trailing newline. No representable node yields `{ "outbounds": [] }`.
 */
export function produceSingbox(nodes: ProxyNode[]): string {
  const config: SingboxConfig = { outbounds: buildSingboxOutbounds(nodes) };
  return `${JSON.stringify(config, null, 2)}\n`;
}
