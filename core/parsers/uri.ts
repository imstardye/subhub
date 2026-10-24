// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Share-link proxy parsers.
 *
 * Ported and adapted from Sub-Store
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * Original project: https://github.com/sub-store-org/Sub-Store
 *
 * The implementation here intentionally keeps the internal proxy shape close
 * to Sub-Store's so later phases can reuse its processor pipeline. Test data
 * must always use example.com and fake credentials.
 */

import type { ProxyNode } from '../types';
import {
  decodeBase64,
  decodeComponent,
  isTruthyFlag,
  normalizeLoopbackName,
  normalizeVmessSecurity,
  parseAlpn,
  parseHostPort,
  parsePort,
  parseQuery,
  splitFragment,
  stripIpv6Brackets,
  tryDecodeBase64,
} from '../utils';

function splitHeadAndQuery(value: string): { head: string; query?: string } {
  const index = value.indexOf('?');
  if (index === -1) return { head: value };
  return { head: value.slice(0, index), query: value.slice(index + 1) };
}

function parseUserInfo(raw: string): string {
  const decoded = decodeComponent(raw);
  if (decoded.includes(':')) return decoded;
  const base64Decoded = tryDecodeBase64(decoded);
  return base64Decoded ?? decoded;
}

function parsePlugin(query: Record<string, string>): {
  plugin?: string;
  pluginOpts?: Record<string, unknown>;
} {
  const raw = query.plugin;
  if (!raw) return {};

  const [name, ...parts] = raw.split(';');
  const opts: Record<string, unknown> = {};
  for (const part of parts) {
    if (!part) continue;
    const index = part.indexOf('=');
    const key = index === -1 ? part : part.slice(0, index);
    const value = index === -1 ? true : part.slice(index + 1);
    opts[key] = value;
  }

  if (name === 'obfs-local' || name === 'simple-obfs' || name === 'obfs') {
    const mode = typeof opts.obfs === 'string' ? opts.obfs : undefined;
    const host = typeof opts['obfs-host'] === 'string' ? opts['obfs-host'] : undefined;
    return {
      plugin: 'obfs',
      pluginOpts: {
        mode: mode ?? 'http',
        ...(host ? { host } : {}),
      },
    };
  }

  if (name === 'v2ray-plugin') {
    const pluginOpts: Record<string, unknown> = {};
    if (typeof opts.mode === 'string') pluginOpts.mode = opts.mode;
    if (typeof opts.host === 'string') pluginOpts.host = opts.host;
    if (typeof opts.path === 'string') pluginOpts.path = opts.path;
    if (opts.tls === true || isTruthyFlag(opts.tls)) pluginOpts.tls = true;
    if (opts.mux === true || isTruthyFlag(opts.mux)) pluginOpts.mux = true;
    return { plugin: 'v2ray-plugin', pluginOpts };
  }

  return { plugin: name, pluginOpts: opts };
}

/**
 * Parse Shadowsocks SIP002 and legacy base64 URIs.
 */
export function parseShadowsocks(line: string): ProxyNode {
  const { content: rawContent, fragment } = splitFragment(line.slice('ss://'.length));
  const { head, query: rawQuery } = splitHeadAndQuery(rawContent);
  const query = parseQuery(rawQuery);

  let content = head;
  let userInfoRaw: string;
  let hostPortRaw: string;

  const atIndex = content.lastIndexOf('@');
  if (atIndex !== -1) {
    userInfoRaw = content.slice(0, atIndex);
    hostPortRaw = content.slice(atIndex + 1);
  } else {
    // Legacy: ss://base64(method:password@host:port)
    const decoded = tryDecodeBase64(content);
    if (!decoded) {
      throw new Error('Invalid Shadowsocks URI: missing user info');
    }
    content = decoded;
    const decodedAt = content.lastIndexOf('@');
    if (decodedAt === -1) {
      throw new Error('Invalid Shadowsocks URI: missing server');
    }
    userInfoRaw = content.slice(0, decodedAt);
    hostPortRaw = content.slice(decodedAt + 1);
  }

  const userInfo = parseUserInfo(userInfoRaw);
  const separator = userInfo.indexOf(':');
  if (separator === -1) {
    throw new Error('Invalid Shadowsocks URI: invalid user info');
  }

  const cipher = userInfo.slice(0, separator);
  const password = userInfo.slice(separator + 1);
  const { host, port } = parseHostPort(hostPortRaw);

  const pluginInfo = parsePlugin(query);
  const node: ProxyNode = {
    type: 'ss',
    name: normalizeLoopbackName(fragment, `SS ${host}:${parsePort(port)}`),
    server: host,
    port: parsePort(port),
    cipher,
    password,
    udp: true,
  };

  if (pluginInfo.plugin) node.plugin = pluginInfo.plugin;
  if (pluginInfo.pluginOpts) node['plugin-opts'] = pluginInfo.pluginOpts;

  const uot = query.uot ?? query['udp-over-tcp'] ?? query.udp_over_tcp;
  if (uot != null) {
    const normalized = String(uot).trim().toLowerCase();
    if (normalized === 'sp.v1' || normalized === 'spv1') {
      node['udp-over-tcp'] = true;
      node['udp-over-tcp-version'] = 1;
    } else if (normalized === 'sp.v2' || normalized === 'spv2') {
      node['udp-over-tcp'] = true;
      node['udp-over-tcp-version'] = 2;
    } else if (isTruthyFlag(uot)) {
      node['udp-over-tcp'] = true;
    }
  }

  return node;
}

/**
 * Parse ShadowsocksR links: ssr://base64(server:port:protocol:cipher:obfs:password/?...).
 */
export function parseSsr(line: string): ProxyNode {
  const encoded = line.slice('ssr://'.length).trim();
  const decoded = tryDecodeBase64(encoded);
  if (!decoded) throw new Error('Invalid SSR URI: cannot decode payload');

  const queryIndex = decoded.indexOf('/?');
  const main = (queryIndex === -1 ? decoded : decoded.slice(0, queryIndex)).replace(
    /\/$/,
    '',
  );
  const query = parseQuery(queryIndex === -1 ? undefined : decoded.slice(queryIndex + 2));

  // Split from the right so bracketed IPv6 servers keep their colons.
  const fields = main.split(':');
  if (fields.length < 6) throw new Error('Invalid SSR URI: malformed payload');

  const passwordRaw = fields.pop() ?? '';
  const obfs = fields.pop() ?? '';
  const cipher = fields.pop() ?? '';
  const protocol = fields.pop() ?? '';
  const portRaw = fields.pop() ?? '';
  const server = stripIpv6Brackets(fields.join(':'));
  if (!server || !cipher || !protocol || !obfs) {
    throw new Error('Invalid SSR URI: malformed payload');
  }

  // SSR writers use the literal `(null)` for empty parameters.
  const decodeSsrParam = (value: string | undefined): string =>
    value && value.trim() !== '(null)'
      ? decodeBase64(value)
      : '';
  const remarks = decodeSsrParam(query.remarks);
  const group = decodeSsrParam(query.group);
  const protocolParam = decodeSsrParam(
    query.protoparam || query.protocolparam,
  );
  const obfsParam = decodeSsrParam(query.obfsparam);

  const node: ProxyNode = {
    type: 'ssr',
    name: normalizeLoopbackName(
      remarks,
      `SSR ${server}:${parsePort(portRaw)}`,
    ),
    server,
    port: parsePort(portRaw),
    protocol,
    cipher,
    obfs,
    password: decodeBase64(passwordRaw),
  };

  if (protocolParam) node['protocol-param'] = protocolParam;
  if (obfsParam) node['obfs-param'] = obfsParam;
  if (group) node.group = group;

  return node;
}

function getInsecureFlag(params: Record<string, string>): string | undefined {
  return params.insecure ?? params.allowInsecure ?? params.allow_insecure;
}

function extractPathEarlyData(path: string): { path: string; ed?: string } {
  const queryIndex = path.indexOf('?');
  if (queryIndex === -1) return { path };

  const basePath = path.slice(0, queryIndex);
  const kept: string[] = [];
  let ed: string | undefined;

  for (const part of path.slice(queryIndex + 1).split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const key = decodeComponent(separator === -1 ? part : part.slice(0, separator));
    const value = decodeComponent(separator === -1 ? '' : part.slice(separator + 1));
    if (key === 'ed') {
      if (ed === undefined && value) ed = value;
      continue;
    }
    kept.push(part);
  }

  return {
    path: kept.length > 0 ? `${basePath}?${kept.join('&')}` : basePath,
    ...(ed !== undefined ? { ed } : {}),
  };
}

function applyTransport(
  node: ProxyNode,
  params: Record<string, string>,
  options: { defaultPath?: string } = {},
): void {
  let network = params.net || params.type || 'tcp';
  if (network === 'websocket') network = 'ws';
  if (network === 'httpupgrade') network = 'ws';
  if (network === 'tcp' && params.headerType === 'http') network = 'http';
  else if (network === 'http') network = 'h2';
  if (!network || network === 'tcp' || network === 'none') return;

  const opts: Record<string, unknown> = {};
  const host = params.host ?? params.obfsParam;
  if (host) {
    if (params.obfsParam) {
      try {
        const parsed = JSON.parse(host) as Record<string, string>;
        opts.headers = parsed;
      } catch {
        opts.headers = { Host: host };
      }
    } else {
      opts.headers = { Host: host };
    }
  }

  if (['h2'].includes(network)) {
    const hostValue = (opts.headers as Record<string, string> | undefined)?.Host;
    if (hostValue) {
      opts.host = hostValue
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      delete opts.headers;
    }
  }

  if (params.serviceName) {
    opts[`${network}-service-name`] = params.serviceName;
    if (network === 'grpc' && params.authority) {
      opts['_grpc-authority'] = params.authority;
    }
  }

  let path = params.path || options.defaultPath;
  let earlyData = params.ed;
  if (network === 'ws' && path) {
    const extracted = extractPathEarlyData(path);
    path = extracted.path;
    earlyData = extracted.ed ?? earlyData;
  }
  if (path) opts.path = path;
  if (network === 'ws' && !opts.path) opts.path = '/';
  if (network === 'grpc' && params.mode) opts['_grpc-type'] = params.mode;
  if (network === 'ws' && earlyData && /^\d+$/.test(earlyData)) {
    opts['max-early-data'] = Number.parseInt(earlyData, 10);
    opts['early-data-header-name'] =
      params.eh || 'Sec-WebSocket-Protocol';
  }

  if (params.type === 'httpupgrade' || params.net === 'httpupgrade') {
    opts['v2ray-http-upgrade'] = true;
  }

  node.network = network;
  node[`${network}-opts`] = opts;
}

function applyReality(node: ProxyNode, params: Record<string, string>): void {
  if (params.security !== 'reality' && !params.pbk) return;
  node['reality-opts'] = {
    'public-key': params.pbk ?? '',
    ...(params.sid ? { 'short-id': params.sid } : {}),
    ...(params.spx ? { '_spider-x': params.spx } : {}),
  };
}

/**
 * Parse V2rayN VMess JSON links. The URI-style `vmess://uuid@host:port` form is
 * delegated to the VLESS parser, matching Sub-Store behaviour.
 */
export function parseVmess(line: string): ProxyNode {
  const { content: rawContent, fragment } = splitFragment(line.slice('vmess://'.length));
  const { head, query: rawQuery } = splitHeadAndQuery(rawContent);

  if (head.includes('@')) {
    return parseVless(line, 'vmess');
  }

  const decoded = tryDecodeBase64(head);
  if (!decoded) throw new Error('Invalid VMess URI: cannot decode payload');

  let params: Record<string, unknown>;
  try {
    params = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    // Shadowrocket style: base64(cipher:uuid@host:port)?query
    const shadowrocket = /^([^:]+):([^@]+)@(.*):(\d+)$/.exec(decoded);
    if (!shadowrocket) throw new Error('Invalid VMess URI: invalid JSON payload');
    const query = parseQuery(rawQuery);
    params = {
      scy: shadowrocket[1],
      id: shadowrocket[2],
      add: shadowrocket[3],
      port: shadowrocket[4],
      ...query,
    };
  }

  const server = String(params.add ?? params.server ?? '');
  const port = parsePort(params.port as string | number | undefined);
  const name = normalizeLoopbackName(
    fragment ??
      (params.ps as string | undefined) ??
      (params.remarks as string | undefined) ??
      (params.remark as string | undefined),
    `VMess ${server}:${port}`,
  );

  const node: ProxyNode = {
    type: 'vmess',
    name,
    server,
    port,
    uuid: String(params.id ?? params.uuid ?? ''),
    alterId: Number.parseInt(String(params.aid ?? params.alterId ?? 0), 10) || 0,
    cipher: normalizeVmessSecurity(params.scy ?? params.cipher),
    udp: true,
    tls: ['tls', true, 1, '1'].includes(params.tls as string | boolean | number),
  };

  if (node.tls) {
    const sni = (params.sni ?? params.peer ?? params.servername) as string | undefined;
    if (sni) node.sni = sni;
  }
  const insecure = getInsecureFlag(
    params as Record<string, string>,
  );
  if (insecure != null) {
    node['skip-cert-verify'] = isTruthyFlag(insecure);
  } else if (params.verify_cert != null) {
    node['skip-cert-verify'] = !isTruthyFlag(params.verify_cert);
  }

  const alpn = params.alpn as string | undefined;
  if (alpn) node.alpn = parseAlpn(alpn);
  if (params.fp) node['client-fingerprint'] = params.fp;

  const transportParams: Record<string, string> = {};
  for (const key of ['net', 'type', 'host', 'path', 'serviceName', 'mode', 'headerType']) {
    const value = params[key];
    if (typeof value === 'string') transportParams[key] = value;
  }
  if (params.net === 'httpupgrade') transportParams.type = 'httpupgrade';
  applyTransport(node, transportParams, { defaultPath: undefined });

  return node;
}

/**
 * Parse VLESS links, including Reality and common transports. `protocol` is
 * also used by VMess URI-style links.
 */
export function parseVless(line: string, protocol: 'vless' | 'vmess' = 'vless'): ProxyNode {
  const { content: rawContent, fragment } = splitFragment(
    line.slice(`${protocol}://`.length),
  );
  const { head: rawHead, query: rawQuery } = splitHeadAndQuery(rawContent);
  const params = parseQuery(rawQuery);

  let head = rawHead;
  if (!head.includes('@')) {
    const decoded = tryDecodeBase64(head);
    if (decoded) head = decoded;
  }

  const atIndex = head.lastIndexOf('@');
  if (atIndex === -1) throw new Error(`Invalid ${protocol.toUpperCase()} URI`);

  const uuid = decodeComponent(head.slice(0, atIndex));
  const { host, port } = parseHostPort(head.slice(atIndex + 1));
  const finalPort = parsePort(port);

  const node: ProxyNode = {
    type: protocol,
    name: normalizeLoopbackName(
      fragment ?? params.remarks ?? params.remark,
      `${protocol === 'vmess' ? 'VMess' : 'VLESS'} ${host}:${finalPort}`,
    ),
    server: host,
    port: finalPort,
    uuid,
    udp: true,
    tls: Boolean(params.security && params.security !== 'none'),
  };

  if (protocol === 'vmess') {
    node.cipher = normalizeVmessSecurity(params.encryption);
    node.alterId = 0;
  } else if (params.encryption) {
    node.encryption = params.encryption;
  }

  if (!node.tls && params.pbk) node.tls = true;
  if (params.security === 'reality' || params.pbk) applyReality(node, params);
  if (params.flow) node.flow = params.flow;
  const sni = params.sni || params.peer || params.servername;
  if (sni) node.sni = sni;
  if (params.fp) node['client-fingerprint'] = params.fp;
  if (params.alpn) node.alpn = parseAlpn(params.alpn);
  const insecure = getInsecureFlag(params);
  if (insecure != null) {
    node['skip-cert-verify'] = isTruthyFlag(insecure);
  }
  if (params.pcs) node['tls-fingerprint'] = params.pcs;

  applyTransport(node, params, { defaultPath: undefined });

  return node;
}

export function parseTrojan(line: string): ProxyNode {
  const { content: rawContent, fragment } = splitFragment(
    line.slice('trojan://'.length),
  );
  const { head, query: rawQuery } = splitHeadAndQuery(rawContent);
  const params = parseQuery(rawQuery);

  const atIndex = head.lastIndexOf('@');
  if (atIndex === -1) throw new Error('Invalid Trojan URI: missing password');

  const password = decodeComponent(head.slice(0, atIndex));
  const serverPart = head.slice(atIndex + 1);
  const { host, port } = parseHostPort(serverPart);
  const finalPort = parsePort(port);

  const node: ProxyNode = {
    type: 'trojan',
    name: normalizeLoopbackName(fragment, `Trojan ${host}:${finalPort}`),
    server: host,
    port: finalPort,
    password,
    udp: true,
    tls: params.security !== 'none',
  };

  const sni = params.sni || params.peer || params.servername;
  if (sni) node.sni = sni;
  if (params.alpn) node.alpn = parseAlpn(params.alpn);
  const insecure = getInsecureFlag(params);
  if (insecure != null) {
    node['skip-cert-verify'] = isTruthyFlag(insecure);
  }
  if (params.fp) node['client-fingerprint'] = params.fp;
  applyReality(node, params);
  applyTransport(node, params, { defaultPath: undefined });

  return node;
}

export function parseHysteria2(line: string): ProxyNode {
  const { content, fragment } = splitFragment(
    line.replace(/^(hysteria2|hy2):\/\//, ''),
  );
  const { head, query: rawQuery } = splitHeadAndQuery(content);
  const params = parseQuery(rawQuery);

  const atIndex = head.lastIndexOf('@');
  if (atIndex === -1) throw new Error('Invalid Hysteria2 URI: missing password');

  const password = decodeComponent(head.slice(0, atIndex));
  const serverPart = head.slice(atIndex + 1);
  const match = /^(\[[^\]]+\]|[^:/]+)(?::([^/]+))?\/?$/.exec(serverPart);
  if (!match) throw new Error('Invalid Hysteria2 URI: invalid server');

  const host = stripIpv6Brackets(match[1]);
  const rawPort = match[2];
  let port: number;
  let ports: string | undefined;
  if (!rawPort) {
    port = 443;
  } else if (/^\d+$/.test(rawPort)) {
    port = Number.parseInt(rawPort, 10);
  } else {
    ports = rawPort;
    const first = rawPort.match(/\d+/)?.[0];
    port = parsePort(first);
  }

  if (params.mport) ports = params.mport;

  const node: ProxyNode = {
    type: 'hysteria2',
    name: normalizeLoopbackName(fragment, `Hysteria2 ${host}:${port}`),
    server: host,
    port,
    password,
    udp: true,
  };

  if (ports) node.ports = ports;
  const sni = params.sni || params.peer;
  if (sni) node.sni = sni;
  if (params.obfs && params.obfs !== 'none') {
    node.obfs = params.obfs;
    if (params['obfs-password']) node['obfs-password'] = params['obfs-password'];
  }
  const insecure = getInsecureFlag(params);
  if (insecure != null) {
    node['skip-cert-verify'] = isTruthyFlag(insecure);
  }
  if (params.fastopen != null) node.tfo = isTruthyFlag(params.fastopen);
  if (params.pinSHA256) node['tls-fingerprint'] = params.pinSHA256;
  if (params.alpn) node.alpn = parseAlpn(params.alpn);
  if (params['hop-interval'] || params.hop_interval) {
    node['hop-interval'] = params['hop-interval'] ?? params.hop_interval;
  }
  if (params.keepalive && /^\d+$/.test(params.keepalive)) {
    node.keepalive = Number.parseInt(params.keepalive, 10);
  }
  if (params.upmbps) node.up = params.upmbps;
  if (params.downmbps) node.down = params.downmbps;
  if (params.ech) node['ech-opts'] = { enable: true, config: params.ech };

  return node;
}

export function parseTuic(line: string): ProxyNode {
  const { content, fragment } = splitFragment(line.slice('tuic://'.length));
  const { head, query: rawQuery } = splitHeadAndQuery(content);
  const params = parseQuery(rawQuery);

  const atIndex = head.lastIndexOf('@');
  if (atIndex === -1) throw new Error('Invalid TUIC URI: missing credentials');

  const auth = decodeComponent(head.slice(0, atIndex));
  const separator = auth.indexOf(':');
  if (separator === -1) throw new Error('Invalid TUIC URI: invalid credentials');

  const uuid = auth.slice(0, separator);
  const password = auth.slice(separator + 1);
  const { host, port } = parseHostPort(head.slice(atIndex + 1));
  const finalPort = parsePort(port);

  const node: ProxyNode = {
    type: 'tuic',
    name: normalizeLoopbackName(fragment, `TUIC ${host}:${finalPort}`),
    server: host,
    port: finalPort,
    uuid,
    password,
    udp: true,
  };

  const sni = params.sni || params.peer;
  if (sni) node.sni = sni;
  if (params.alpn) node.alpn = parseAlpn(params.alpn);

  const insecure = getInsecureFlag(params);
  if (insecure != null) node['skip-cert-verify'] = isTruthyFlag(insecure);

  const fastOpen = params.fast_open ?? params['fast-open'];
  if (fastOpen != null) node.tfo = isTruthyFlag(fastOpen);

  const congestion =
    params.congestion_control ??
    params['congestion-control'] ??
    params.congestionControl;
  if (congestion) node['congestion-controller'] = congestion;

  const relayMode =
    params.udp_relay_mode ??
    params['udp-relay-mode'] ??
    params.udpRelayMode;
  if (relayMode) node['udp-relay-mode'] = relayMode;

  const disableSni = params.disable_sni ?? params['disable-sni'];
  if (disableSni != null) node['disable-sni'] = isTruthyFlag(disableSni);

  const reduceRtt = params.reduce_rtt ?? params['reduce-rtt'];
  if (reduceRtt != null) node['reduce-rtt'] = isTruthyFlag(reduceRtt);

  const heartbeat = params.heartbeat_interval ?? params['heartbeat-interval'];
  if (heartbeat) node['heartbeat-interval'] = heartbeat;

  const requestTimeout = params['request-timeout'] ?? params.request_timeout;
  if (requestTimeout) node['request-timeout'] = requestTimeout;

  const uot = params.udp_over_tcp ?? params['udp-over-tcp'];
  if (uot != null) {
    const normalized = String(uot).trim().toLowerCase();
    if (normalized === 'sp.v1' || normalized === 'spv1') {
      node['udp-over-tcp'] = true;
      node['udp-over-tcp-version'] = 1;
    } else if (normalized === 'sp.v2' || normalized === 'spv2') {
      node['udp-over-tcp'] = true;
      node['udp-over-tcp-version'] = 2;
    } else {
      node['udp-over-tcp'] = isTruthyFlag(uot);
    }
  }
  const uotVersion =
    params.udp_over_tcp_version ?? params['udp-over-tcp-version'];
  if (uotVersion != null) {
    const parsed = Number.parseInt(uotVersion, 10);
    if (Number.isFinite(parsed)) node['udp-over-tcp-version'] = parsed;
  }

  // Only explicitly supported URI fields are copied onto the node.
  if (params.token) node.token = params.token;
  if (params.version != null) {
    const parsed = Number.parseInt(params.version, 10);
    if (Number.isFinite(parsed)) node.version = parsed;
  }

  return node;
}

export function parseAnyTLS(line: string): ProxyNode {
  const { content, fragment } = splitFragment(line.slice('anytls://'.length));
  const { head, query: rawQuery } = splitHeadAndQuery(content);
  const params = parseQuery(rawQuery);

  const atIndex = head.lastIndexOf('@');
  if (atIndex === -1) throw new Error('Invalid AnyTLS URI: missing password');

  const password = decodeComponent(head.slice(0, atIndex));
  const { host, port } = parseHostPort(head.slice(atIndex + 1));
  const finalPort = parsePort(port);

  const node: ProxyNode = {
    type: 'anytls',
    name: normalizeLoopbackName(fragment, `AnyTLS ${host}:${finalPort}`),
    server: host,
    port: finalPort,
    password,
    udp: true,
  };

  const sni = params.sni || params.peer;
  if (sni) node.sni = sni;
  if (params.alpn) node.alpn = parseAlpn(params.alpn);
  const insecure = getInsecureFlag(params);
  if (insecure != null) {
    node['skip-cert-verify'] = isTruthyFlag(insecure);
  }
  if (params.udp != null) node.udp = isTruthyFlag(params.udp);
  if (params.fp) node['client-fingerprint'] = params.fp;
  if (params['min-idle-session'] != null) {
    const value = Number.parseInt(params['min-idle-session'], 10);
    if (Number.isFinite(value)) node['min-idle-session'] = value;
  }
  if (params['idle-session-timeout'] != null) {
    const value = Number.parseInt(params['idle-session-timeout'], 10);
    if (Number.isFinite(value)) node['idle-session-timeout'] = value;
  }
  const idleSessionCheck =
    params['idle-session-check-interval'] ??
    params.idle_session_check_interval;
  if (idleSessionCheck != null) {
    const value = Number.parseInt(idleSessionCheck, 10);
    if (Number.isFinite(value)) {
      node['idle-session-check-interval'] = value;
    }
  }

  return node;
}

const URI_PARSERS: Array<{
  test: (line: string) => boolean;
  parse: (line: string) => ProxyNode;
}> = [
  { test: (line) => /^ss:\/\//i.test(line), parse: parseShadowsocks },
  { test: (line) => /^ssr:\/\//i.test(line), parse: parseSsr },
  { test: (line) => /^vmess:\/\//i.test(line), parse: parseVmess },
  { test: (line) => /^vless:\/\//i.test(line), parse: (line) => parseVless(line, 'vless') },
  { test: (line) => /^trojan:\/\//i.test(line), parse: parseTrojan },
  { test: (line) => /^(hysteria2|hy2):\/\//i.test(line), parse: parseHysteria2 },
  { test: (line) => /^tuic:\/\//i.test(line), parse: parseTuic },
  { test: (line) => /^anytls:\/\//i.test(line), parse: parseAnyTLS },
];

export function isShareLink(line: string): boolean {
  return URI_PARSERS.some((parser) => parser.test(line.trim()));
}

/**
 * Parse a single share link. Returns `null` for blank/comment lines and throws
 * for unsupported or malformed links (callers can collect the error).
 */
export function parseUri(line: string): ProxyNode | null {
  const trimmed = line.trim().replace(/^\uFEFF/, '');
  if (!trimmed || trimmed.startsWith('#')) return null;

  const parser = URI_PARSERS.find((entry) => entry.test(trimmed));
  if (!parser) {
    throw new Error(`Unsupported share link: ${trimmed.split(/[/:]/)[0]}`);
  }
  return parser.parse(trimmed);
}

export { decodeBase64 };
