// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shadowrocket full-config producer (`shadowrocket-conf`).
 *
 * Unlike the nodes-only `shadowrocket` target (a base64 list of share links),
 * this renders a native Shadowrocket `.conf` document: `[General]`, `[Proxy]`,
 * `[Proxy Group]`, `[Rule]`, `[Host]`. Shadowrocket conf lines are
 * comma-separated, so the whole document is line syntax rather than YAML.
 *
 * Protocol coverage (v1):
 * - `ss`        `ss, server, port, cipher, password` (+ `obfs=`, `obfs-host=`)
 * - `vmess`     `vmess, server, port, username=<uuid>` (+ tls/ws/aead/method)
 * - `vless`     `vless, server, port, username=<uuid>` (+ tls/reality/ws/flow)
 * - `trojan`    `trojan, server, port, password=` (TLS implied)
 * - `hysteria2` `hysteria2, server, port, password=` (base port only)
 * - `tuic`      `tuic, server, port, username=<uuid>, password=`
 * - `anytls`    `anytls, server, port, password=`
 * - `socks5` / `http` (type `https` for a TLS HTTP proxy)
 *
 * Unsupported types/transports/plugins are skipped with a diagnostic instead
 * of being faked. WireGuard is deliberately out of scope: its Shadowrocket
 * syntax is a separate, poorly documented shape.
 *
 * Names are the one free-form field written before the first `,`: a comma,
 * `=` or newline in a node name would corrupt the document (start a new field
 * or a new line), so this target replaces those characters with a space. The
 * same transform runs in `buildTargetProxies`/`targetProxyNames`
 * (`server/utils/export-nodes.ts`) so group expansion and rule policies use
 * exactly the names the document emits.
 *
 * Profile groups translate to Shadowrocket's group keywords. Group types the
 * client cannot express (`relay`, ...) are dropped, and their references are
 * removed from surviving groups/rules. Rules the client cannot express
 * (`GEOSITE`, `AND`/`OR`/`NOT`, process rules, ...) are dropped. A RULE-SET is
 * rewritten to its provider URL; an inline/unknown provider is dropped.
 */
import type { ClashProxyGroup, ProxyNode } from '../types';
import { isTruthyFlag, normalizeVmessSecurity } from '../utils';
import { rulePolicy } from '../rules/prune-groups';
import { nodeSkipReason, prepareNode } from './common';
import { buildLineGroups, joinSections, markUnemitted, type LineGroup } from './groups';

/** Shadowrocket's own policy names that a profile group may reference. */
export const SHADOWROCKET_CONF_BUILTINS = ['DIRECT', 'REJECT', 'PROXY'] as const;

/** Default health-check URL/interval for `url-test` and `fallback` groups. */
export const SHADOWROCKET_CONF_GROUP_URL = 'http://www.gstatic.com/generate_204';
export const SHADOWROCKET_CONF_GROUP_INTERVAL = 300;

/** Subconverter group type -> Shadowrocket `[Proxy Group]` keyword. */
const SHADOWROCKET_CONF_GROUP_TYPES: Record<string, string> = {
  select: 'select',
  'url-test': 'url-test',
  fallback: 'fallback',
  'load-balance': 'load-balance',
};

/** Rule types translated 1:1 (the payload/options are kept as written). */
const SAME_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-WILDCARD',
  'GEOIP',
  'DST-PORT',
  'SRC-PORT',
  'IN-PORT',
  'SRC-IP-CIDR',
  'USER-AGENT',
  'URL-REGEX',
]);

export interface ShadowrocketConfNodeResult {
  /** Emitted `[Proxy]` lines, one per node, in input order. */
  lines: string[];
  /** Names of the emitted proxies, in the same order. */
  names: string[];
  /** Nodes the client cannot load, with the reason (diagnostics/tests). */
  skipped: Array<{ name: string; reason: string }>;
}

/** Replace characters that would corrupt a comma-separated conf line. */
export function sanitizeShadowrocketConfName(value: unknown): string {
  return String(value ?? '')
    .replace(/[,\r\n=]/g, ' ')
    .trim();
}

function bool(value: unknown): string {
  return isTruthyFlag(value) ? 'true' : 'false';
}

function sniOf(node: ProxyNode): string | undefined {
  const value = node.sni ?? node.servername ?? node.peer;
  return value === undefined || value === null || value === '' ? undefined : String(value);
}

function alpnOf(node: ProxyNode): string | undefined {
  if (node.alpn === undefined || node.alpn === null) return undefined;
  const list = Array.isArray(node.alpn) ? node.alpn : [node.alpn];
  // A conf line is comma-separated: joining a multi-value ALPN would
  // manufacture an extra field and corrupt the line. First value only.
  const first = list.map((item) => String(item)).find(Boolean);
  return first || undefined;
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

/**
 * WebSocket options, or `null` for a transport Shadowrocket's conf syntax
 * cannot express here (gRPC/h2/http header mode). A plain TCP node has no
 * transport keys at all.
 */
function transportOptions(node: ProxyNode): string[] | null {
  switch (node.network) {
    case undefined:
    case '':
    case 'tcp':
    case 'none':
      return [];
    case 'ws': {
      const opts = node['ws-opts'] as Record<string, unknown> | undefined;
      const path = typeof opts?.path === 'string' && opts.path ? opts.path : '/';
      const parts = ['ws=true', `ws-path=${path}`];
      const host = headerValue(node, 'host');
      if (host) parts.push(`ws-host=${host}`);
      return parts;
    }
    // XHTTP has no grounded Shadowrocket conf grammar; sharing a node link is
    // the `shadowrocket` target's job. Never degrade it to a plain line.
    case 'xhttp':
      return null;
    default:
      return null;
  }
}

/** TLS identity/verification options shared by VMess/VLESS. */
function tlsOptions(node: ProxyNode): string[] {
  const parts: string[] = [];
  const reality = node['reality-opts'] as Record<string, unknown> | undefined;
  if (node.tls || reality) parts.push('tls=true');
  if (reality) {
    const publicKey = reality['public-key'];
    if (publicKey !== undefined && publicKey !== null && publicKey !== '') {
      parts.push(`reality-public-key=${String(publicKey)}`);
    }
    const shortId = reality['short-id'];
    if (shortId !== undefined && shortId !== null && shortId !== '') {
      parts.push(`reality-short-id=${String(shortId)}`);
    }
  }
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node.flow) parts.push(`flow=${String(node.flow)}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`allow-insecure=${bool(node['skip-cert-verify'])}`);
  }
  return parts;
}

function shadowsocksLine(node: ProxyNode): string | null {
  if (!node.cipher || !node.password) return null;
  const parts = ['ss', node.server, node.port, String(node.cipher), String(node.password)];
  if (node.plugin) {
    // Only simple-obfs is grounded for a Shadowrocket conf line. Any other
    // plugin would silently connect differently if omitted.
    if (node.plugin !== 'obfs') return null;
    const opts = (node['plugin-opts'] as Record<string, unknown> | undefined) ?? {};
    const mode = opts.mode === 'tls' ? 'tls' : 'http';
    parts.push(`obfs=${mode}`);
    if (opts.host !== undefined && opts.host !== null && opts.host !== '') {
      parts.push(`obfs-host=${String(opts.host)}`);
    }
  }
  return parts.join(', ');
}

function vmessLine(node: ProxyNode): string | null {
  if (!node.uuid) return null;
  const transport = transportOptions(node);
  if (!transport) return null;
  const parts = [
    'vmess',
    node.server,
    node.port,
    `username=${node.uuid}`,
    ...tlsOptions(node),
    ...transport,
  ];
  const method = normalizeVmessSecurity(node.cipher ?? 'auto');
  if (method !== 'auto') parts.push(`method=${method}`);
  // `alterId > 0` is legacy VMess; modern AEAD is the default.
  if (!node.alterId) parts.push('aead=true');
  return parts.join(', ');
}

function vlessLine(node: ProxyNode): string | null {
  if (!node.uuid) return null;
  const transport = transportOptions(node);
  if (!transport) return null;
  return [
    'vless',
    node.server,
    node.port,
    `username=${node.uuid}`,
    ...tlsOptions(node),
    ...transport,
  ].join(', ');
}

function trojanLine(node: ProxyNode): string | null {
  if (!node.password) return null;
  const transport = transportOptions(node);
  if (!transport) return null;
  const parts = ['trojan', node.server, node.port, `password=${node.password}`];
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`allow-insecure=${bool(node['skip-cert-verify'])}`);
  }
  parts.push(...transport);
  return parts.join(', ');
}

function hysteria2Line(node: ProxyNode): string | null {
  if (!node.password) return null;
  const parts = ['hysteria2', node.server, node.port, `password=${node.password}`];
  // Port hopping has no grounded conf expression here: only the base port is
  // emitted in v1 (documented in AGENTS.md).
  if (node.obfs !== undefined && node.obfs !== '' && node.obfs !== 'none') {
    parts.push('obfs=salamander');
    if (node['obfs-password']) parts.push(`obfs-password=${node['obfs-password']}`);
  }
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`allow-insecure=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(', ');
}

function tuicLine(node: ProxyNode): string | null {
  if (!node.uuid || !node.password) return null;
  const parts = [
    'tuic',
    node.server,
    node.port,
    `username=${node.uuid}`,
    `password=${node.password}`,
  ];
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node['congestion-controller']) {
    parts.push(`congestion-controller=${node['congestion-controller']}`);
  }
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`allow-insecure=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(', ');
}

function anytlsLine(node: ProxyNode): string | null {
  if (!node.password) return null;
  const parts = ['anytls', node.server, node.port, `password=${node.password}`];
  const sni = sniOf(node);
  if (sni) parts.push(`sni=${sni}`);
  const alpn = alpnOf(node);
  if (alpn) parts.push(`alpn=${alpn}`);
  if (node['skip-cert-verify'] !== undefined) {
    parts.push(`allow-insecure=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(', ');
}

/** `socks5` and `http`/`https`: credentials are trailing positionals. */
function socksHttpLine(node: ProxyNode, type: 'socks5' | 'http' | 'https'): string | null {
  const username = node.username !== undefined && node.username !== '' ? String(node.username) : '';
  const password = node.password !== undefined && node.password !== '' ? String(node.password) : '';
  // Positional fields: a lone half would shift the other into the wrong slot.
  if (Boolean(username) !== Boolean(password)) return null;
  const parts = [type, node.server, node.port];
  if (username && password) parts.push(username, password);
  if (node['skip-cert-verify'] !== undefined && type === 'https') {
    parts.push(`allow-insecure=${bool(node['skip-cert-verify'])}`);
  }
  return parts.join(', ');
}

/**
 * Build one `[Proxy]` line for a node, or the reason it is skipped. Returns
 * the same marker shape as the other line producers so `markUnemitted` keeps
 * one skip reason per node.
 */
export function shadowrocketConfProxyLine(node: ProxyNode):
  | { line: string }
  | { reason: string }
  | { skipped: string } {
  const marked = nodeSkipReason(node);
  if (marked) return { reason: marked };

  const proxy = prepareNode(node);
  const name = sanitizeShadowrocketConfName(proxy.name);
  if (!name) return { skipped: 'missing name' };
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
      body = socksHttpLine(proxy, 'socks5');
      break;
    case 'http':
      body = socksHttpLine(proxy, isTruthyFlag(proxy.tls) ? 'https' : 'http');
      break;
    case 'wireguard':
      return { skipped: 'WireGuard conf syntax is out of scope' };
    default:
      return { skipped: `unsupported protocol: ${String(proxy.type)}` };
  }

  if (!body) return { skipped: 'missing or unrepresentable protocol options' };
  // A newline in a credential/value would still start a new line.
  if (/[\r\n]/.test(body)) return { skipped: 'value not representable in a config line' };
  return { line: `${name} = ${body}` };
}

/** Names + lines of the nodes Shadowrocket can load, in input order. */
export function buildShadowrocketConfProxies(nodes: ProxyNode[]): ShadowrocketConfNodeResult {
  const result: ShadowrocketConfNodeResult = { lines: [], names: [], skipped: [] };
  const seen = new Set<string>();
  for (const node of nodes) {
    const built = shadowrocketConfProxyLine(node);
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
    result.skipped.push({ name: sanitizeShadowrocketConfName(node.name), reason });
  }
  return result;
}

/**
 * Translate profile groups for Shadowrocket. A group name containing a comma
 * cannot be written either, so it is dropped before the shared pruning runs
 * (references to it are then removed like any other dead group).
 */
export function buildShadowrocketConfGroups(
  groups: ClashProxyGroup[],
  nodeNames: Iterable<string>,
): LineGroup[] {
  const writable = groups.filter(
    (group) => !String(group.name ?? '').includes(','),
  );
  return buildLineGroups(writable, nodeNames, {
    typeMap: SHADOWROCKET_CONF_GROUP_TYPES,
    builtins: SHADOWROCKET_CONF_BUILTINS,
  });
}

/** One `[Proxy Group]` line in Shadowrocket's `key = value` style. */
export function shadowrocketConfGroupLine(group: LineGroup): string {
  const parts = [group.type, ...group.members];
  if (group.type === 'url-test' || group.type === 'fallback') {
    parts.push(`url = ${group.url ?? SHADOWROCKET_CONF_GROUP_URL}`);
    parts.push(`interval = ${group.interval ?? SHADOWROCKET_CONF_GROUP_INTERVAL}`);
  }
  return `${group.name} = ${parts.join(', ')}`;
}

/** Policy names a translated rule may point at. */
function livePolicies(
  nodeNames: Iterable<string>,
  groupNames: Iterable<string>,
): Set<string> {
  return new Set<string>([
    ...nodeNames,
    ...groupNames,
    ...SHADOWROCKET_CONF_BUILTINS,
  ]);
}

/**
 * Translate one Clash rule, or `null` when Shadowrocket cannot express it (or
 * its policy no longer resolves to a surviving group/node/builtin).
 */
export function translateShadowrocketConfRule(
  rule: string,
  ruleProviders: Record<string, unknown>,
  policies: ReadonlySet<string>,
): string | null {
  const line = rule.trim();
  if (!line || line.startsWith('#') || line.startsWith(';')) return null;
  const parts = line.split(',');
  const type = (parts[0] ?? '').trim().toUpperCase();
  const policy = rulePolicy(line);
  if (!policy || !policies.has(policy)) return null;

  if (type === 'MATCH' || type === 'FINAL') return `FINAL,${policy}`;

  if (type === 'RULE-SET') {
    const providerName = (parts[1] ?? '').trim();
    const provider = ruleProviders[providerName] as { url?: unknown } | undefined;
    const url = provider?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    return `RULE-SET,${url},${policy}`;
  }

  if (!SAME_RULE_TYPES.has(type) && type !== 'IP-CIDR' && type !== 'IP-CIDR6') {
    return null;
  }

  // Keep payload/options exactly, only the type is normalised. The policy
  // index is found from the *end* so comma-containing payloads survive.
  let policyIndex = parts.length - 1;
  while (policyIndex >= 1 && parts[policyIndex].trim() !== policy) policyIndex -= 1;
  if (policyIndex < 1) return null;
  const translatedType = type === 'IP-CIDR6' ? 'IP-CIDR' : type;
  const head = [...parts.slice(0, policyIndex)];
  head[0] = translatedType;
  const tail = parts.slice(policyIndex + 1);
  return [...head, policy, ...tail].join(',');
}

/** Translate the profile's final rule list; untranslatable lines are dropped. */
export function translateShadowrocketConfRules(
  rules: string[],
  ruleProviders: Record<string, unknown>,
  nodeNames: Iterable<string>,
  groupNames: Iterable<string>,
): string[] {
  const policies = livePolicies(nodeNames, groupNames);
  const out: string[] = [];
  for (const rule of rules) {
    const translated = translateShadowrocketConfRule(rule, ruleProviders, policies);
    if (translated) out.push(translated);
  }
  return out;
}

/**
 * Full Shadowrocket `.conf` document. `[General]` and `[Host]` are always
 * present (the known-good minimal scaffolding); the other sections appear
 * only when they have content.
 */
export function produceShadowrocketConf(
  nodes: ProxyNode[],
  groups: ClashProxyGroup[] = [],
  rules: string[] = [],
  ruleProviders: Record<string, unknown> = {},
): string {
  const proxies = buildShadowrocketConfProxies(markUnemitted(nodes, shadowrocketConfProxyLine));
  const builtGroups = buildShadowrocketConfGroups(groups, proxies.names);
  const groupLines = builtGroups.map(shadowrocketConfGroupLine);
  const ruleLines = translateShadowrocketConfRules(
    rules,
    ruleProviders,
    proxies.names,
    builtGroups.map((group) => group.name),
  );

  return joinSections([
    ['[General]', 'bypass-system = true'],
    proxies.lines.length > 0 ? ['[Proxy]', ...proxies.lines] : [],
    groupLines.length > 0 ? ['[Proxy Group]', ...groupLines] : [],
    ruleLines.length > 0 ? ['[Rule]', ...ruleLines] : [],
    ['[Host]', 'localhost = 127.0.0.1'],
  ]);
}
