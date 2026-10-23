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
  'socks5',
  'http',
  'snell',
  'wireguard',
  'direct',
]);

function normalizeNode(raw: unknown): ProxyNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type !== 'string' || !SUPPORTED_NODE_TYPES.has(record.type)) {
    return null;
  }
  if (typeof record.server !== 'string' || !record.server) return null;
  if (!('port' in record)) return null;

  const port = parsePort(record.port as string | number | undefined, 0);
  if (!port) return null;

  return {
    ...record,
    name:
      typeof record.name === 'string' && record.name.trim()
        ? record.name
        : `${record.type} ${record.server}:${port}`,
    type: record.type,
    server: record.server,
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
    parsed = parseYaml(raw);
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
  const document = parseYaml(raw) as unknown;

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

function maybeDecodeSubscription(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Plain-text subscriptions always contain a URI separator.
  if (trimmed.includes('://') || /(^|\n)\s*proxies\s*:/.test(trimmed)) {
    return trimmed;
  }

  let current = trimmed;
  for (let depth = 0; depth < 2; depth += 1) {
    const decoded = tryDecodeBase64(current);
    if (!decoded) break;
    if (!decoded.includes('://') && !/(^|\n)\s*proxies\s*:/.test(decoded)) break;
    current = decoded.trim();
    if (current.includes('://') || /(^|\n)\s*proxies\s*:/.test(current)) break;
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
