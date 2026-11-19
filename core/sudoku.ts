// SPDX-License-Identifier: AGPL-3.0-only
import type { ProxyNode } from './types';
import { decodeBase64, encodeBase64 } from './utils';

// Upstream Sudoku CLI short link. This is not the mihomo YAML schema, and
// Shadowrocket's release notes don't specify whether it imports this format.
// https://github.com/SUDOKU-ASCII/sudoku/blob/b1d1f0e767653d2c70e2ff814a01264c7dedf1f4/internal/config/shortlink.go
const SCHEME = 'sudoku://';
const OPTIONAL_FIELDS = {
  a: 'string', e: 'string', m: 'number', x: 'boolean', t: 'string', ts: 'array',
  hd: 'boolean', hm: 'string', ht: 'boolean', hh: 'string', hx: 'string', hy: 'string',
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validAddress(host: unknown, port: unknown): host is string {
  return typeof host === 'string' && host.trim() !== ''
    && typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function linkOptions(source: Record<string, unknown>): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(OPTIONAL_FIELDS)) {
    const value = source[field];
    if (value == null) continue;
    const valid = kind === 'array' ? Array.isArray(value) && value.every((item) => typeof item === 'string')
      : kind === 'number' ? Number.isSafeInteger(value) : typeof value === kind;
    if (!valid) throw new Error(`Invalid Sudoku short link field: ${field}`);
    options[field] = value;
  }
  return options;
}

export function parseSudokuLink(link: string): ProxyNode {
  const encoded = link.slice(SCHEME.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid Sudoku short link encoding');
  let payload: Record<string, unknown> | undefined;
  try {
    payload = record(JSON.parse(decodeBase64(encoded)));
  } catch {
    throw new Error('Invalid Sudoku short link payload');
  }
  if (!payload || !validAddress(payload.h, payload.p) || typeof payload.k !== 'string' || !payload.k.trim()
      || (payload.n != null && typeof payload.n !== 'string')) {
    throw new Error('Invalid Sudoku short link: expected server, port and key');
  }
  return {
    type: 'sudoku',
    name: typeof payload.n === 'string' && payload.n.trim() ? payload.n : `sudoku ${payload.h}:${payload.p}`,
    server: payload.h,
    port: payload.p as number,
    key: payload.k,
    'sudoku-link-options': linkOptions(payload),
  };
}

export function buildSudokuLink(node: ProxyNode): string | null {
  const options = record(node['sudoku-link-options']);
  if (!options || !validAddress(node.server, node.port) || typeof node.key !== 'string' || !node.key.trim()) {
    return null;
  }
  try {
    const payload = { n: node.name, h: node.server, p: node.port, k: node.key, ...linkOptions(options) };
    const encoded = encodeBase64(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return SCHEME + encoded;
  } catch {
    return null;
  }
}
