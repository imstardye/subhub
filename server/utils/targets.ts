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
 * A target that still falls back to mihomo YAML (P4 TODO): sing-box and the
 * generic URI list. mihomo/clash, shadowrocket, surge and loon have real
 * producers (see `renderTargetBody`).
 */
export type FallbackTarget = Exclude<
  ExportTarget,
  'mihomo' | 'clash' | 'shadowrocket' | 'surge' | 'loon'
>;

/** Share-link subscription (base64 of newline-joined links). */
const SHADOWROCKET_TARGET: ExportTarget = 'shadowrocket';
const LINE_TARGETS: ReadonlySet<ExportTarget> = new Set(['surge', 'loon']);

/** Content-Type each target's body is served with. */
export function exportContentType(target: ExportTarget): string {
  if (target === SHADOWROCKET_TARGET || LINE_TARGETS.has(target)) {
    return 'text/plain; charset=utf-8';
  }
  return 'text/yaml; charset=utf-8';
}

/** Download file extension for a target's body. */
export function exportFileExtension(target: ExportTarget): string {
  if (target === SHADOWROCKET_TARGET) return 'txt';
  if (LINE_TARGETS.has(target)) return 'conf';
  return 'yaml';
}

export function isExportTarget(value: string): value is ExportTarget {
  return (EXPORT_TARGETS as readonly string[]).includes(value);
}
