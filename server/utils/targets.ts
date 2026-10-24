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
 * producer is not implemented yet (P4).
 *
 * `singbox` and `uri` are real producers now (`core/producers/singbox.ts` /
 * `core/producers/uri.ts`); surge/loon/shadowrocket are done on another branch.
 */
export type FallbackTarget = Extract<ExportTarget, 'shadowrocket' | 'surge' | 'loon'>;

const FALLBACK_TARGETS = new Set<string>(['shadowrocket', 'surge', 'loon']);

export function isFallbackTarget(target: ExportTarget): target is FallbackTarget {
  return FALLBACK_TARGETS.has(target);
}

/** Content-Type of a target's body (also used by the admin preview). */
export function contentTypeForTarget(target: ExportTarget): string {
  // `singbox` is JSON; `uri` is an opaque base64 blob (its own body is share
  // links, not YAML). Everything else still renders Clash/mihomo YAML.
  if (target === 'singbox') return 'application/json; charset=utf-8';
  if (target === 'uri') return 'text/plain; charset=utf-8';
  return 'text/yaml; charset=utf-8';
}

/** File extension used in the download `Content-Disposition`. */
export function fileNameExtensionFor(target: ExportTarget): string {
  if (target === 'singbox') return 'json';
  if (target === 'uri') return 'txt';
  return 'yaml';
}

export function isExportTarget(value: string): value is ExportTarget {
  return (EXPORT_TARGETS as readonly string[]).includes(value);
}
