// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Built-in DNS / anti-leak template for mihomo (Clash.Meta) configs.
 *
 * Every mihomo/clash export carries a `dns:` section so a client that would
 * otherwise use the system resolver (plaintext, leaks the query, and resolves
 * domains locally) is forced onto:
 *  - fake-ip: the proxy sees the real domain, so rule matching and the remote
 *    resolver win over a leaked local lookup;
 *  - DoH only: bootstrap resolvers are plain IPs (they cannot be looked up via
 *    DoH), every real lookup goes to an encrypted endpoint;
 *  - QUIC blocked (rule injected by the producer, see `QUIC_BLOCK_RULE`), so
 *    clients fall back to TCP/HTTP and the domain keeps flowing through the
 *    proxy instead of a UDP/443 quick handshake.
 *
 * A profile may carry its own `dnsTemplate` (a YAML mapping); it replaces this
 * section entirely, see `produceMihomo`.
 *
 * `listen` is deliberately omitted: mihomo's DNS listener is optional, and a
 * hard-coded `0.0.0.0:1053` collides with other local DNS software and with
 * some Clash-compatible importers. fake-ip + `respect-rules` reach the same
 * anti-leak goal without opening a port, so the template stays import-safe.
 */
import { isMap, isSeq, parseDocument, type Node } from 'yaml';

/** Same alias guard the other YAML inputs use. */
const MAX_YAML_ALIAS_COUNT = 100;

/** mihomo `dns:` mapping emitted by default. Frozen: callers get a clone. */
export const BUILTIN_DNS_TEMPLATE: Readonly<Record<string, unknown>> = Object.freeze({
  enable: true,
  // No AAAA queries: an IPv6 answer can bypass the proxied IPv4 path.
  ipv6: false,
  // fake-ip is the core of the anti-leak story: the domain, not a locally
  // resolved address, is what reaches the proxy and the rules.
  'enhanced-mode': 'fake-ip',
  'fake-ip-range': '198.18.0.1/16',
  // Keep local/OS-integration names on the real resolver; everything else is
  // proxied. Short and conventional on purpose.
  // (`*.x` suffixes, `+.x` subdomains-only, plus the exact `localhost` name.)
  'fake-ip-filter': [
    '*.lan',
    '*.local',
    'localhost',
    '*.home.arpa',
    '+.msftconnecttest.com',
    '+.msftncsi.com',
  ],
  // Bootstrap only: plain IPs, used to resolve the DoH hostnames below.
  'default-nameserver': ['223.5.5.5', '119.29.29.29'],
  // Encrypted DNS. Domestic DoH first so CN domains resolve fast.
  nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
  // Overseas DoH, used for answers that look foreign (see fallback-filter).
  fallback: ['https://1.1.1.1/dns-query', 'https://8.8.8.8/dns-query'],
  'fallback-filter': {
    geoip: true,
    'geoip-code': 'CN',
    // Reserved/experimental space that a polluted answer commonly returns.
    ipcidr: ['240.0.0.0/4'],
  },
  // Resolve through the proxy groups (so DNS follows the same route as the
  // traffic) and do not hand QUIC/H3 DNS to the fallback servers.
  'respect-rules': true,
  'prefer-h3': false,
});

/** A deep copy of the built-in template, safe to hand to a producer. */
export function builtinDnsTemplate(): Record<string, unknown> {
  return structuredClone(BUILTIN_DNS_TEMPLATE) as Record<string, unknown>;
}

/**
 * Parse a profile-supplied `dnsTemplate`. Returns the mapping to emit, or
 * `null` when the text is empty, invalid YAML or not a single mapping — the
 * caller then keeps the built-in template, so a broken template can never
 * break an export.
 *
 * A surrounding `dns:` wrapper is unwrapped, so pasting a whole `dns:` block
 * from a working config does what the admin expects.
 */
export function parseDnsTemplate(text: string | null | undefined): Record<string, unknown> | null {
  const raw = text?.trim();
  if (!raw) return null;

  let document: unknown;
  try {
    document = parseYamlToJson(raw);
  } catch {
    return null;
  }
  if (!isPlainMapping(document)) return null;

  const mapping = document;
  const keys = Object.keys(mapping);
  if (keys.length === 0) return null;

  // Unwrap a pasted full `dns:` block.
  if (keys.length === 1 && keys[0] === 'dns' && isPlainMapping(mapping.dns)) {
    return mapping.dns;
  }
  return mapping;
}

/** A YAML mapping (not a scalar, list or null). */
function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/** Plain JSON value check (the parsed node tree is never a Map/Seq). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * YAML -> plain JSON values, keeping every key as the text the admin typed.
 *
 * `parse()` applies the YAML 1.2 core schema, under which keys such as `on`,
 * `yes` or `1e3` are resolved as booleans/numbers before they become object
 * keys (e.g. a `use-hosts`-like key would come back as `true`). Building the
 * object from the node tree keeps key text intact while values still get their
 * normal scalar types (`true`, numbers, strings).
 */
function parseYamlToJson(raw: string): unknown {
  // `maxAliasCount` belongs to the ToJS options, hence the second call below
  // (`toJS` enforces the same alias guard as the other YAML inputs).
  const document = parseDocument(raw);
  document.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT });
  if (document.errors.length > 0) throw document.errors[0];
  return toJson(document.contents as Node | null);
}

function toJson(node: Node | null): unknown {
  if (node === null) return null;
  if (isMap(node)) {
    const output: Record<string, unknown> = {};
    for (const pair of node.items) {
      const key = keyText(pair.key as Node | null);
      if (key !== null) output[key] = toJson(pair.value as Node | null);
    }
    return output;
  }
  if (isSeq(node)) return node.items.map((item) => toJson(item as Node | null));
  return (node as { toJSON?: () => unknown }).toJSON?.() ?? null;
}

/** Key text as written, without scalar-schema coercion. */
function keyText(key: Node | null): string | null {
  if (key === null) return null;
  if ('value' in key) return String((key as { value: unknown }).value);
  const json = toJson(key);
  return json === null || typeof json === 'object' ? null : String(json);
}

/**
 * Resolve the `dns:` section for one export: the parsed profile template when
 * it is usable, the built-in template otherwise.
 */
export function resolveDnsTemplate(override?: string | null): Record<string, unknown> {
  return parseDnsTemplate(override) ?? builtinDnsTemplate();
}
