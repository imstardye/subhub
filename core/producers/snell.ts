// SPDX-License-Identifier: AGPL-3.0-only
import type { ProxyNode } from '../types';

/** Read an explicit version without silently rounding or changing it. */
export function snellVersion(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const version = Number(value);
  return Number.isInteger(version) && version >= 1 && version <= 6 ? version : undefined;
}

export function snellPsk(node: ProxyNode, version: number): string | undefined {
  const psk = typeof node.psk === 'number' && Number.isFinite(node.psk) ? String(node.psk) : node.psk;
  if (typeof psk !== 'string' || !psk) return undefined;
  if (version === 6) {
    const length = new TextEncoder().encode(psk).length;
    if (length < 12 || length > 255) return undefined;
  }
  return psk;
}

export function snellObfs(node: ProxyNode) {
  const options = node['obfs-opts'] as Record<string, unknown> | undefined;
  return {
    mode: options?.mode ?? node.obfs,
    host: options?.host ?? node['obfs-host'],
    uri: options?.path ?? node['obfs-uri'],
  };
}

/** Unquoted scalar in a comma-delimited proxy declaration. */
export function isSnellLineValue(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.trim() === value && !/[,"\r\n\0]/.test(value);
}
