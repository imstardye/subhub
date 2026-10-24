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

/** A target that still falls back to mihomo YAML (P4 TODO). */
export type FallbackTarget = Exclude<ExportTarget, 'mihomo' | 'clash'>;

export function isExportTarget(value: string): value is ExportTarget {
  return (EXPORT_TARGETS as readonly string[]).includes(value);
}
