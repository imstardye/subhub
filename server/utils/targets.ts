// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription export targets (SPEC: 订阅出口).
 *
 * Split out of `subscription.ts` so the shared renderer
 * (`export-nodes.ts`) and the admin preview can import the list without
 * pulling in the rate limiter / access logger.
 */

/** Targets accepted by /s/:token/:target. */
export const EXPORT_TARGETS = [
  'mihomo',
  'clash',
  'shadowrocket',
  'singbox',
  'surge',
  'loon',
  'uri',
] as const;

export type ExportTarget = (typeof EXPORT_TARGETS)[number];

/**
 * Targets that still render the mihomo YAML body because their dedicated
 * producer is not implemented yet. Every current target has a real producer
 * (mihomo/clash YAML, shadowrocket/surge/loon line formats, singbox JSON,
 * uri share links), so the fallback set is empty; the check stays so a
 * future target can opt into the fallback explicitly.
 */
export type FallbackTarget = never;

const FALLBACK_TARGETS = new Set<string>([]);

export function isFallbackTarget(target: ExportTarget): target is FallbackTarget {
  return FALLBACK_TARGETS.has(target);
}

/** Content-Type of a target's body (also used by the admin preview). */
export function contentTypeForTarget(target: ExportTarget): string {
  // `singbox` is JSON; the share-link and line-based bodies are plain text.
  // Everything else renders Clash/mihomo YAML.
  if (target === 'singbox') return 'application/json; charset=utf-8';
  if (
    target === 'uri' ||
    target === 'shadowrocket' ||
    target === 'surge' ||
    target === 'loon'
  ) {
    return 'text/plain; charset=utf-8';
  }
  return 'text/yaml; charset=utf-8';
}

/** File extension used in the download `Content-Disposition`. */
export function fileNameExtensionFor(target: ExportTarget): string {
  if (target === 'singbox') return 'json';
  if (target === 'uri' || target === 'shadowrocket') return 'txt';
  if (target === 'surge' || target === 'loon') return 'conf';
  return 'yaml';
}

export function isExportTarget(value: string): value is ExportTarget {
  return (EXPORT_TARGETS as readonly string[]).includes(value);
}
