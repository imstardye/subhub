// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Clash / mihomo YAML and subscription parsers.
 *
 * Adapted from Sub-Store's Clash pre-processor
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

import { parse as parseYaml } from 'yaml';
import type { ParseResult, ProxyNode } from '../types';
import { parsePort, tryDecodeBase64 } from '../utils';
import { isShareLink, parseUri } from './uri';

export const MAX_SUBSCRIPTION_INPUT_LENGTH = 10 * 1024 * 1024;
const MAX_YAML_ALIAS_COUNT = 100;

const SUPPORTED_NODE_TYPES = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'anytls',
  'mieru',
  'socks5',
  'http',
  'snell',
  'wireguard',
  'easytier',
  // Native mihomo YAML (not the upstream Sudoku CLI short-link envelope).
  'sudoku',
  'openvpn',
  // OpenConnect has no documented mihomo grammar. Retain the documented
  // sing-box endpoint fields in a subscription envelope for that target only.
  'openconnect',
  'direct',
]);

function normalizeNode(raw: unknown): ProxyNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type !== 'string' || !SUPPORTED_NODE_TYPES.has(record.type)) {
    return null;
  }
  if (record.type === 'easytier') {
    // No top-level TCP destination: peers/listeners are URI lists.
    // https://wiki.metacubex.one/config/proxies/easytier/
    const { name, 'network-name': networkName } = record;
    if (typeof name !== 'string' || !name.trim() || typeof networkName !== 'string' || !networkName.trim()) {
      return null;
    }
    return { ...record, type: 'easytier', name, server: '', port: 0 };
  }
  if (record.type === 'sudoku' && (typeof record.key !== 'string' || !record.key.trim())) return null;
  // mihomo ignores the top-level peer's fields when using the full peers form.
  if (record.type === 'wireguard' && record['amnezia-wg-option'] != null
      && Array.isArray(record.peers) && record.peers.length > 0
      && (!record.server || record.port == null)) {
    const name = typeof record.name === 'string' && record.name.trim() ? record.name : '';
    return name ? { ...record, type: 'wireguard', name, server: '', port: 0 } : null;
  }
  const realm = record.type === 'hysteria2'
    ? record['realm-opts'] as Record<string, unknown> | undefined : undefined;
  const realmEnabled = realm?.enable === true;
  if (!('port' in record) && record.type !== 'openconnect' && !realmEnabled) return null;

  let port: number;
  try {
    port = parsePort(record.port as string | number | undefined,
      record.type === 'openconnect' ? 443 : realmEnabled ? 443 : 0);
  } catch {
    return null;
  }
  if (!port) return null;
  if (!realmEnabled && (typeof record.server !== 'string' || !record.server.trim())) return null;
  const server = typeof record.server === 'string' ? record.server : '';

  // Stash names the SHA-256 certificate pin differently from mihomo. Keep
  // both native spellings, but bridge them through the producer's internal
  // pin field (never client-fingerprint, which selects a uTLS ClientHello).
  const anytlsPin = record.type === 'anytls'
    ? record['tls-fingerprint'] ?? record.fingerprint ?? record['server-cert-fingerprint']
    : undefined;

  // Keep protocol options verbatim, including nested AmneziaWG and REALITY
  // options. Producers decide which fields their target supports.
  return {
    ...record,
    ...(anytlsPin !== undefined ? { 'tls-fingerprint': anytlsPin } : {}),
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name
        : `${record.type} ${server || realm?.['realm-id']}:${port}`,
    type: record.type,
    server,
    port,
  } as ProxyNode;
}

/**
 * Parse a single Clash proxy object, either JSON or YAML.
 */
export function parseClashNode(raw: string): ProxyNode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = parseYaml(raw, { maxAliasCount: MAX_YAML_ALIAS_COUNT });
  }

  const node = normalizeNode(parsed);
  if (!node) throw new Error('Invalid Clash proxy node');
  return node;
}

/**
 * Parse a Clash/mihomo YAML document. Accepts both a full config with a
 * `proxies` array and a bare array of proxy objects.
 */
export function parseClashYaml(raw: string): ProxyNode[] {
  if (raw.length > MAX_SUBSCRIPTION_INPUT_LENGTH) {
    throw new Error('Input exceeds the 10MB limit');
  }
  const document = parseYaml(raw, {
    maxAliasCount: MAX_YAML_ALIAS_COUNT,
  }) as unknown;

  if (Array.isArray(document)) {
    return document
      .map(normalizeNode)
      .filter((node): node is ProxyNode => node !== null);
  }

  if (document && typeof document === 'object') {
    const proxies = (document as Record<string, unknown>).proxies;
    if (Array.isArray(proxies)) {
      return proxies
        .map(normalizeNode)
        .filter((node): node is ProxyNode => node !== null);
    }
  }

  return [];
}

function looksLikeSubscriptionPayload(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.includes('://') ||
    /(^|\n)\s*proxies\s*:/.test(trimmed) ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('{')
  );
}

function maybeDecodeSubscription(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  let current = trimmed;
  // Providers sometimes wrap an already base64-encoded subscription again.
  // Decode through a few layers until we reach a recognizable payload.
  for (let depth = 0; depth < 4; depth += 1) {
    if (looksLikeSubscriptionPayload(current)) break;
    const decoded = tryDecodeBase64(current);
    if (!decoded) break;
    current = decoded.trim();
  }
  return current;
}

/**
 * Parse a subscription payload. Supported inputs:
 *  - plain text share links (one per line)
 *  - base64 encoded share links (single or multi-line base64)
 *  - Clash/mihomo YAML with a `proxies` array
 *  - a JSON array of Clash proxy objects
 */
export function parseSubscriptionDetailed(raw: string): ParseResult {
  const nodes: ProxyNode[] = [];
  const errors: ParseResult['errors'] = [];

  if (raw.length > MAX_SUBSCRIPTION_INPUT_LENGTH) {
    errors.push({
      line: raw.slice(0, 120),
      message: 'Input exceeds the 10MB limit',
    });
    return { nodes, errors };
  }

  const payload = maybeDecodeSubscription(raw.replace(/^\uFEFF/, ''));
  if (!payload) return { nodes, errors };

  if (/(^|\n)\s*proxies\s*:/.test(payload) || payload.trimStart().startsWith('[')) {
    try {
      if (payload.trimStart().startsWith('[')) {
        const parsed = JSON.parse(payload) as unknown;
        for (const entry of Array.isArray(parsed) ? parsed : []) {
          const node = normalizeNode(entry);
          if (node) nodes.push(node);
        }
      } else {
        nodes.push(...parseClashYaml(payload));
      }
      return { nodes, errors };
    } catch (error) {
      errors.push({
        line: payload.slice(0, 120),
        message: error instanceof Error ? error.message : String(error),
      });
      return { nodes, errors };
    }
  }

  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    if (isShareLink(line)) {
      try {
        const node = parseUri(line);
        if (node) nodes.push(node);
      } catch (error) {
        errors.push({
          line,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    // Some providers mix Clash JSON nodes into a text subscription.
    if (line.startsWith('{')) {
      try {
        nodes.push(parseClashNode(line));
      } catch (error) {
        errors.push({
          line,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { nodes, errors };
}

export function parseSubscription(raw: string): ProxyNode[] {
  return parseSubscriptionDetailed(raw).nodes;
}
