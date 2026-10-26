// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Share-link (`uri`) subscription producer.
 *
 * Every emitted link is built so that the repo's own share-link parsers
 * (`core/parsers/uri.ts`) read the node back unchanged: same type, server,
 * port, credential, name and the transport/TLS options they support. That is
 * the round-trip contract, and `tests/uri-producer.test.ts` enforces it.
 *
 * The supported type set is exactly `URI_PARSERS` in the parser module:
 * ss, ssr, vmess, vless, trojan, hysteria2, tuic, anytls, mieru. Everything
 * else (socks/http/snell/wireguard/…) is skipped rather than faked.
 *
 * Body: standard base64 (with padding) of the newline-joined links, which is
 * what the repo's `parseSubscription` accepts (`decodeBase64` also tolerates
 * missing padding / URL-safe alphabet).
 */
import type { ProxyNode } from '../types';
import { encodeBase64, parseAlpn } from '../utils';
import { isShareLink, parseUri } from '../parsers/uri';
import { normalizeAlpn, normalizeCommonTransport, prepareNode } from './common';

/** Types the share-link parsers understand (see `URI_PARSERS`). */
export const URI_SUPPORTED_TYPES = [
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'tuic',
  'anytls',
  'mieru',
] as const;

const URI_TYPES = new Set<string>(URI_SUPPORTED_TYPES);

type Opts = Record<string, unknown>;

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value == null ? undefined : String(value);
}

/** Percent-encode a URI component the way the parser decodes it (`decodeURIComponent`). */
function component(value: string): string {
  return encodeURIComponent(value);
}

/** `udp-over-tcp` as the `sp.v1`/`sp.v2` value the parsers read back. */
function udpOverTcpValue(node: ProxyNode): string {
  const version = node['udp-over-tcp-version'];
  return version === 1 || version === 2 ? `sp.v${version}` : '1';
}

/** Base64url without padding: the userinfo encoding SIP002 and SSR expect. */
function base64Url(value: string): string {
  return encodeBase64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** IPv6 servers must be bracketed in the authority; the parsers strip them. */
function formatHost(server: string): string {
  return server.includes(':') && !server.startsWith('[') ? `[${server}]` : server;
}

/** The parser's `net` vocabulary (`http` there means HTTP/2, `h2` is accepted too). */
function uriNetwork(node: ProxyNode): string | undefined {
  const network = toStringOrUndefined(node.network);
  if (!network || network === 'tcp' || network === 'none') return undefined;
  if (network === 'h2' || network === 'http') return 'http';
  return network;
}

/**
 * Transport query parameters (`type`/`net`, `host`, `path`, `serviceName`,
 * `mode`, `ed`) shared by VLESS/VMess-URI/Trojan links, matching what
 * `applyTransport` reads.
 */
function transportParams(node: ProxyNode): Array<[string, string]> {
  const network = uriNetwork(node);
  if (!network) return [];

  const opts = (node[`${toStringOrUndefined(node.network)}-opts`] as Opts | undefined) ?? {};
  const params: Array<[string, string]> = [['type', network]];

  if (network === 'ws') {
    const headers = opts.headers as Record<string, unknown> | undefined;
    const host = toStringOrUndefined(headers?.Host ?? headers?.host);
    if (host) params.push(['host', host]);
    let path = toStringOrUndefined(opts.path);
    if (path) {
      // Early data travels inside the ws path (`?ed=2048`), see `extractPathEarlyData`.
      const maxEarlyData = opts['max-early-data'];
      if (maxEarlyData !== undefined && maxEarlyData !== null && !/[?&]ed=/.test(path)) {
        path = `${path}${path.includes('?') ? '&' : '?'}ed=${toStringOrUndefined(maxEarlyData)}`;
      }
      params.push(['path', path]);
    }
  } else if (network === 'grpc') {
    const serviceName = toStringOrUndefined(opts['grpc-service-name']);
    if (serviceName) params.push(['serviceName', serviceName]);
  } else if (network === 'http') {
    const hostList = opts.host;
    const host = Array.isArray(hostList)
      ? hostList.map((entry) => toStringOrUndefined(entry)).filter(Boolean).join(',')
      : toStringOrUndefined(hostList);
    if (host) params.push(['host', host]);
    const path = toStringOrUndefined(opts.path);
    if (path) params.push(['path', path]);
  } else if (network === 'httpupgrade') {
    const headers = opts.headers as Record<string, unknown> | undefined;
    const host = toStringOrUndefined(headers?.Host ?? headers?.host);
    if (host) params.push(['host', host]);
    const path = toStringOrUndefined(opts.path);
    if (path) params.push(['path', path]);
  }

  return params;
}

/** TLS parameters; `TLS_IMPLICIT` types carry TLS anyway and only look at identity/verification. */
function tlsParams(node: ProxyNode, options: { security?: boolean } = {}): Array<[string, string]> {
  const params: Array<[string, string]> = [];
  const reality = node['reality-opts'] as Opts | undefined;

  if (options.security !== false) {
    if (reality) params.push(['security', 'reality']);
    else if (node.tls !== false && (node.tls || node.sni || node.servername)) {
      params.push(['security', 'tls']);
    }
  }

  const sni = toStringOrUndefined(node.sni) ?? toStringOrUndefined(node.servername);
  if (sni) params.push(['sni', sni]);
  if (node['skip-cert-verify'] === true) params.push(['insecure', '1']);
  const alpn = parseAlpn(Array.isArray(node.alpn) ? node.alpn.join(',') : toStringOrUndefined(node.alpn));
  if (alpn) params.push(['alpn', alpn.join(',')]);
  const fp = toStringOrUndefined(node['client-fingerprint']);
  if (fp) params.push(['fp', fp]);

  if (reality) {
    const publicKey = toStringOrUndefined(reality['public-key']);
    if (publicKey) params.push(['pbk', publicKey]);
    const shortId = toStringOrUndefined(reality['short-id']);
    if (shortId) params.push(['sid', shortId]);
    const spiderX = toStringOrUndefined(reality['_spider-x']);
    if (spiderX) params.push(['spx', spiderX]);
  }

  return params;
}

function withQuery(base: string, params: Array<[string, string] | undefined>): string {
  const query = params
    .filter((entry): entry is [string, string] => Array.isArray(entry) && entry[1] !== undefined)
    .map(([key, value]) => `${component(key)}=${component(value)}`)
    .join('&');
  return query ? `${base}?${query}` : base;
}

function withFragment(base: string, name: string): string {
  return name ? `${base}#${component(name)}` : base;
}

function authority(node: ProxyNode): string {
  return `${formatHost(node.server)}:${node.port}`;
}

function shadowsocksLink(node: ProxyNode): string {
  // SIP002: userinfo is base64url(method:password) *without* padding.
  const userInfo = base64Url(`${node.cipher ?? ''}:${node.password ?? ''}`);
  const base = `ss://${userInfo}@${authority(node)}`;

  const params: Array<[string, string] | undefined> = [];
  const plugin = toStringOrUndefined(node.plugin);
  const pluginOpts = node['plugin-opts'] as Opts | undefined;
  if (plugin === 'obfs' && pluginOpts) {
    const parts = ['obfs-local'];
    parts.push(`obfs=${toStringOrUndefined(pluginOpts.mode) ?? 'http'}`);
    const host = toStringOrUndefined(pluginOpts.host);
    if (host) parts.push(`obfs-host=${host}`);
    params.push(['plugin', parts.join(';')]);
  } else if (plugin === 'v2ray-plugin' && pluginOpts) {
    const parts = ['v2ray-plugin'];
    const mode = toStringOrUndefined(pluginOpts.mode);
    if (mode) parts.push(`mode=${mode}`);
    const host = toStringOrUndefined(pluginOpts.host);
    if (host) parts.push(`host=${host}`);
    const path = toStringOrUndefined(pluginOpts.path);
    if (path) parts.push(`path=${path}`);
    if (pluginOpts.tls === true) parts.push('tls');
    if (pluginOpts.mux === true) parts.push('mux');
    params.push(['plugin', parts.join(';')]);
  }
  if (node['udp-over-tcp'] === true) params.push(['uot', udpOverTcpValue(node)]);

  return withFragment(withQuery(base, params), node.name);
}

function shadowsocksrLink(node: ProxyNode): string {
  const params: Array<[string, string]> = [];
  const encodeSsrParam = (value: unknown) => {
    const text = toStringOrUndefined(value);
    return base64Url(text ?? '');
  };
  // SSR encodes every parameter base64. The parser only strips the literal
  // `(null)` (not an empty string) from a decoded value, so empty parameters
  // are omitted entirely instead of being written as `(null)`.
  params.push(['remarks', encodeSsrParam(node.name)]);
  if (node['protocol-param']) params.push(['protoparam', encodeSsrParam(node['protocol-param'])]);
  if (node['obfs-param']) params.push(['obfsparam', encodeSsrParam(node['obfs-param'])]);
  if (node.group) params.push(['group', encodeSsrParam(node.group)]);

  const payload = [
    formatHost(String(node.server)),
    String(node.port),
    String(node.protocol ?? ''),
    String(node.cipher ?? ''),
    String(node.obfs ?? ''),
    base64Url(String(node.password ?? '')),
  ].join(':');
  const query = params.map(([key, value]) => `${key}=${value}`).join('&');
  return `ssr://${encodeBase64(`${payload}/?${query}`)}`;
}

/**
 * V2rayN-style `vmess://` link: base64 of the JSON descriptor. The URI-style
 * `vmess://uuid@host` variant exists in the parser but cannot carry Reality
 * and is not what clients expect for VMess.
 */
function vmessLink(node: ProxyNode): string {
  const network = uriNetwork(node);
  const opts = network ? ((node[`${network}-opts`] as Opts | undefined) ?? {}) : {};
  const wsHeaders = opts.headers as Record<string, unknown> | undefined;

  const payload: Record<string, string> = {
    v: '2',
    ps: node.name,
    add: String(node.server),
    port: String(node.port),
    id: String(node.uuid ?? ''),
    aid: String(Number.parseInt(String(node.alterId ?? 0), 10) || 0),
    scy: toStringOrUndefined(node.cipher) ?? 'auto',
    net: network ?? 'tcp',
    // `type` is the TCP header mode (`none`/`http`) in the V2rayN JSON.
    type: toStringOrUndefined(node.headerType) ?? 'none',
    host: '',
    path: '',
    tls: node.tls === true ? 'tls' : '',
  };

  if (network === 'ws') {
    payload.host = toStringOrUndefined(wsHeaders?.Host ?? wsHeaders?.host) ?? '';
    payload.path = toStringOrUndefined(opts.path) ?? '';
    const maxEarlyData = opts['max-early-data'];
    if (maxEarlyData !== undefined && maxEarlyData !== null) {
      payload.path = `${payload.path}?ed=${toStringOrUndefined(maxEarlyData)}`;
    }
  } else if (network === 'grpc') {
    // `serviceName` is what the parser reads for grpc (`path` is not).
    payload.serviceName = toStringOrUndefined(opts['grpc-service-name']) ?? '';
  } else if (network === 'http') {
    const hostList = opts.host;
    payload.host = Array.isArray(hostList)
      ? hostList.map((entry) => toStringOrUndefined(entry)).filter(Boolean).join(',')
      : toStringOrUndefined(hostList) ?? '';
    payload.path = toStringOrUndefined(opts.path) ?? '';
  } else if (network === 'httpupgrade') {
    payload.type = 'httpupgrade';
    payload.host = toStringOrUndefined(wsHeaders?.Host ?? wsHeaders?.host) ?? '';
    payload.path = toStringOrUndefined(opts.path) ?? '';
  }

  const sni = toStringOrUndefined(node.sni) ?? toStringOrUndefined(node.servername);
  if (sni) payload.sni = sni;
  const alpn = parseAlpn(Array.isArray(node.alpn) ? node.alpn.join(',') : toStringOrUndefined(node.alpn));
  if (alpn) payload.alpn = alpn.join(',');
  const fp = toStringOrUndefined(node['client-fingerprint']);
  if (fp) payload.fp = fp;
  if (node['skip-cert-verify'] === true) payload.allowInsecure = '1';

  return `vmess://${encodeBase64(JSON.stringify(payload))}`;
}

function vlessLink(node: ProxyNode): string {
  const flow = toStringOrUndefined(node.flow);
  const params: Array<[string, string]> = [
    ['encryption', toStringOrUndefined(node.encryption) ?? 'none'],
    ...tlsParams(node),
    ...(flow ? [['flow', flow] as [string, string]] : []),
    ...transportParams(node),
  ];
  const base = `vless://${component(String(node.uuid ?? ''))}@${authority(node)}`;
  return withFragment(withQuery(base, params), node.name);
}

function trojanLink(node: ProxyNode): string {
  const params: Array<[string, string] | undefined> = [
    ...tlsParams(node),
    ...transportParams(node),
  ];
  const base = `trojan://${component(String(node.password ?? ''))}@${authority(node)}`;
  return withFragment(withQuery(base, params), node.name);
}

function hysteria2Link(node: ProxyNode): string {
  const params: Array<[string, string] | undefined> = [];
  const sni = toStringOrUndefined(node.sni) ?? toStringOrUndefined(node.servername);
  if (sni) params.push(['sni', sni]);
  if (node['skip-cert-verify'] === true) params.push(['insecure', '1']);
  const alpn = parseAlpn(Array.isArray(node.alpn) ? node.alpn.join(',') : toStringOrUndefined(node.alpn));
  if (alpn) params.push(['alpn', alpn.join(',')]);
  const obfs = toStringOrUndefined(node.obfs);
  if (obfs && obfs !== 'none') {
    params.push(['obfs', obfs]);
    const obfsPassword = toStringOrUndefined(node['obfs-password']);
    if (obfsPassword) params.push(['obfs-password', obfsPassword]);
  }
  const ports = toStringOrUndefined(node.ports);
  if (ports) params.push(['mport', ports]);
  if (node.tfo === true) params.push(['fastopen', '1']);
  const fingerprint = toStringOrUndefined(node['tls-fingerprint']);
  if (fingerprint) params.push(['pinSHA256', fingerprint]);
  if (node.up !== undefined && node.up !== null) params.push(['upmbps', String(node.up)]);
  if (node.down !== undefined && node.down !== null) params.push(['downmbps', String(node.down)]);
  const hopInterval = toStringOrUndefined(node['hop-interval']);
  if (hopInterval) params.push(['hop-interval', hopInterval]);
  const keepalive = toStringOrUndefined(node.keepalive);
  if (keepalive) params.push(['keepalive', keepalive]);
  const ech = (node['ech-opts'] as Opts | undefined)?.config;
  const echConfig = toStringOrUndefined(ech);
  if (echConfig) params.push(['ech', echConfig]);

  const base = `hysteria2://${component(String(node.password ?? ''))}@${authority(node)}`;
  return withFragment(withQuery(base, params), node.name);
}

function tuicLink(node: ProxyNode): string {
  const params: Array<[string, string] | undefined> = [];
  const sni = toStringOrUndefined(node.sni) ?? toStringOrUndefined(node.servername);
  if (sni) params.push(['sni', sni]);
  const alpn = parseAlpn(Array.isArray(node.alpn) ? node.alpn.join(',') : toStringOrUndefined(node.alpn));
  if (alpn) params.push(['alpn', alpn.join(',')]);
  if (node['skip-cert-verify'] === true) params.push(['allow_insecure', '1']);
  if (node.tfo === true) params.push(['fast_open', '1']);
  const congestion = toStringOrUndefined(node['congestion-controller']);
  if (congestion) params.push(['congestion_control', congestion]);
  const relayMode = toStringOrUndefined(node['udp-relay-mode']);
  if (relayMode) params.push(['udp_relay_mode', relayMode]);
  if (node['disable-sni'] === true) params.push(['disable_sni', '1']);
  if (node['reduce-rtt'] === true) params.push(['reduce_rtt', '1']);
  const heartbeat = toStringOrUndefined(node['heartbeat-interval']);
  if (heartbeat) params.push(['heartbeat_interval', heartbeat]);
  const requestTimeout = toStringOrUndefined(node['request-timeout']);
  if (requestTimeout) params.push(['request_timeout', requestTimeout]);
  if (node['udp-over-tcp'] === true) {
    params.push(['udp_over_tcp', udpOverTcpValue(node)]);
  }
  const token = toStringOrUndefined(node.token);
  if (token) params.push(['token', token]);
  if (node.version !== undefined && node.version !== null) {
    params.push(['version', String(node.version)]);
  }

  const userInfo = `${component(String(node.uuid ?? ''))}:${component(String(node.password ?? ''))}`;
  const base = `tuic://${userInfo}@${authority(node)}`;
  return withFragment(withQuery(base, params), node.name);
}

function anytlsLink(node: ProxyNode): string {
  const params: Array<[string, string] | undefined> = [
    ...tlsParams(node, { security: false }),
  ];
  if (node.udp === false) params.push(['udp', '0']);
  for (const key of [
    'min-idle-session',
    'idle-session-timeout',
    'idle-session-check-interval',
  ]) {
    const value = toStringOrUndefined(node[key]);
    if (value) params.push([key, value]);
  }

  const base = `anytls://${component(String(node.password ?? ''))}@${authority(node)}`;
  return withFragment(withQuery(base, params), node.name);
}

/**
 * mieru's official per-node "simple URL":
 * `mierus://<user>:<password>@<host>?profile=<name>&port=<port>&protocol=<TCP|UDP>`.
 * The node name travels in `profile` (there is no `#fragment`); `transport` is
 * the protocol, uppercased, defaulting to TCP. The whole-config
 * `mieru://<base64-protobuf>` scheme is deliberately never emitted.
 * Returns `''` when credentials or the port make the link unusable.
 */
export function buildMieruLink(node: ProxyNode): string {
  const username = toStringOrUndefined(node.username) ?? '';
  const password = toStringOrUndefined(node.password) ?? '';
  const port = node.port;
  if (!username || !password || !Number.isInteger(port) || port < 1) return '';
  const server = String(node.server ?? '');
  if (!server) return '';

  const name = String(node.name ?? '').trim() || `mieru ${server}:${port}`;
  const rawProtocol = (toStringOrUndefined(node.transport) ?? 'TCP').trim().toUpperCase();
  const protocol = rawProtocol === 'UDP' ? 'UDP' : 'TCP';

  return `mierus://${component(username)}:${component(password)}@${formatHost(server)}?profile=${component(name)}&port=${port}&protocol=${protocol}`;
}

/**
 * Build one share link for a node, or `null` when the type has no share-link
 * form (also `null` for an unusable server/port).
 */
export function toShareLink(node: ProxyNode): string | null {
  if (!URI_TYPES.has(node.type)) return null;
  if (!node.server || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) {
    return null;
  }
  // mieru carries its name in `profile`, which has a server:port fallback.
  if (!node.name && node.type !== 'mieru') return null;

  switch (node.type) {
    case 'ss':
      return node.cipher && node.password !== undefined ? shadowsocksLink(node) : null;
    case 'ssr':
      return shadowsocksrLink(node);
    case 'vmess':
      return node.uuid ? vmessLink(node) : null;
    case 'vless':
      return node.uuid ? vlessLink(node) : null;
    case 'trojan':
      return node.password !== undefined ? trojanLink(node) : null;
    case 'hysteria2':
      return node.password !== undefined ? hysteria2Link(node) : null;
    case 'tuic':
      return node.uuid && node.password !== undefined ? tuicLink(node) : null;
    case 'anytls':
      return node.password !== undefined ? anytlsLink(node) : null;
    case 'mieru':
      return buildMieruLink(node) || null;
    default:
      return null;
  }
}

/** Links for the nodes that have a share-link form, in input order. */
export function buildShareLinks(nodes: ProxyNode[]): string[] {
  const links: string[] = [];
  for (const raw of nodes) {
    const node = prepareNode(raw);
    normalizeCommonTransport(node);
    // Providers use either spelling for the TLS server name.
    if (node.type === 'hysteria2' || node.type === 'tuic' || node.type === 'anytls') {
      if (node.sni === undefined && node.servername !== undefined) node.sni = node.servername;
    }
    if (node.type === 'tuic' || node.type === 'hysteria2' || node.type === 'anytls') normalizeAlpn(node);
    const link = toShareLink(node);
    // Safety net: never emit a link our own parser would drop or reject.
    if (!link || !isShareLink(link)) continue;
    try {
      if (parseUri(link)) links.push(link);
    } catch {
      // Unrepresentable in share-link form after all; skip instead of faking.
    }
  }
  return links;
}

/**
 * The `uri` export body: standard base64 (padded) of the newline-joined
 * share links. No representable node yields the base64 of an empty string.
 */
export function produceUri(nodes: ProxyNode[]): string {
  return encodeBase64(buildShareLinks(nodes).join('\n'));
}
