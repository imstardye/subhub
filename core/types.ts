// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared core types for subhub.
 *
 * Parsers/producers in this directory are adapted from Sub-Store
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

export type ProxyType =
  | 'ss'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'tuic'
  | 'anytls'
  | 'http'
  | 'socks5'
  | 'socks';

/**
 * Internal, lossless-ish representation of a proxy node. Keeping this as a
 * loose record mirrors Sub-Store's proxy JSON and makes it easy to preserve
 * protocol-specific options when they are not interpreted by the core yet.
 */
export interface ProxyNode {
  type: ProxyType | string;
  name: string;
  server: string;
  port: number;
  [key: string]: unknown;
}

export interface ParseResult {
  nodes: ProxyNode[];
  errors: Array<{ line: string; message: string }>;
}

export interface ProduceOptions {
  /** Emit human-readable YAML instead of the compact Clash list format. */
  pretty?: boolean;
  /** Include nodes the target kernel cannot load (off by default). */
  includeUnsupported?: boolean;
  /**
   * Raw `dns:` template YAML (a mapping) that replaces the built-in DNS
   * section. Ignored when empty/invalid; only mihomo/clash targets read it.
   */
  dnsTemplate?: string | null;
  /**
   * Rules to emit at the head of the generated `rules` list, before any
   * profile rule (mihomo producer only). The QUIC block is added by default;
   * `false` disables it. Profile rules are appended after this block.
   */
  leadingRules?: string[] | false;
}

export interface RulesetEntry {
  /** Proxy group that owns this ruleset. */
  group: string;
  /** Raw source, e.g. a URL or an inline `[]GEOIP,CN` declaration. */
  source: string;
  /** `url`, `inline` or `unknown` (empty source). */
  kind: 'url' | 'inline' | 'unknown';
  /** Inline rule type for `[]...` entries (`GEOIP`, `GEOSITE`, `FINAL`). */
  inlineType?: string;
  /** Inline rule payload split on commas (`['CN', 'no-resolve']`). */
  inlineValue?: string[];
  /** Policy already written on an inline rule, when one was present. */
  sourceTarget?: string;
  /** Original line, useful for diagnostics. */
  raw: string;
}

export type ProxyGroupMember =
  | { kind: 'ref'; name: string }
  | { kind: 'regex'; pattern: string }
  | { kind: 'builtin'; name: string };

export interface ProxyGroupEntry {
  name: string;
  type: string;
  /** Raw options after the group type, backtick separated. */
  rawOptions: string[];
  members: ProxyGroupMember[];
  url?: string;
  interval?: number;
  tolerance?: number;
  timeout?: number;
  lazy?: boolean;
  raw: string;
}

export interface SubconverterIni {
  /** Values from the `[common]` section. */
  common: Record<string, string>;
  /** Values from the `[custom]` section (excluding multi-value entries). */
  custom: Record<string, string>;
  rulesets: RulesetEntry[];
  groups: ProxyGroupEntry[];
}

export interface ClashProxyGroup {
  name: string;
  type: string;
  proxies: string[];
  url?: string;
  interval?: number;
  tolerance?: number;
  timeout?: number;
  lazy?: boolean;
}

export interface ClashRuleProvider {
  type: 'http';
  behavior: 'classical';
  format: 'text';
  url: string;
  path: string;
  interval: number;
}

export interface BuiltRules {
  ruleProviders: Record<string, ClashRuleProvider>;
  rules: string[];
  proxyGroups: ClashProxyGroup[];
}
