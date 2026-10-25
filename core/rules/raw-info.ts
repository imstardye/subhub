// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fallback traffic info read from a subscription's own info pseudo-nodes.
 *
 * Some providers do not send a complete `subscription-userinfo` header (or none
 * at all), yet they *do* report the same numbers inside their subscription as
 * fake nodes whose name is the report:
 *
 *   剩余流量：579.45 GB
 *   套餐到期：长期有效
 *   剩余流量：0
 *
 * The user center shows "what this subscription says about itself", so where
 * the header is silent these nodes fill the gap (`mergeUserInfo` in
 * `server/utils/user-center.ts`). The header always wins when it has a value.
 *
 * The node set is the same built-in one the export filter drops
 * (`INFO_NODE_KEYWORDS` / `isInfoNodeName` in `./info-nodes.ts`): a node that is
 * filtered out of the export is exactly a node whose name carries the report.
 * Applied on the read path only — caches keep the raw payload, and the export
 * keeps dropping these nodes.
 *
 * Pure functions (no DB, no Nuxt) so they are unit-tested directly.
 */
import type { ProxyNode } from '../types';
import { isInfoNodeName } from './info-nodes';

/** What the info nodes of one subscription told us. A missing part is `null`. */
export interface RawTrafficInfo {
  /** 剩余流量, in bytes. `0` is a real value (`剩余流量：0`), not "unknown". */
  remaining: number | null;
  /** 套餐到期 as epoch **seconds** when the text is a date. */
  expire: number | null;
  /** 套餐到期 as written (e.g. `长期有效`), when it is not a date. */
  expireText: string | null;
}

/** Nothing parsed: the header (if any) is shown unchanged. */
export const EMPTY_RAW_TRAFFIC_INFO: RawTrafficInfo = {
  remaining: null,
  expire: null,
  expireText: null,
};

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
  PB: 1024 ** 5,
};

/** Placeholder words providers use for "no expiry" — shown verbatim. */
const OPEN_ENDED = /^(长期有效|永久有效|无限期|长期|永久|永不过期|不过期|无期限)$/;

/** Value part of a `剩余流量：579.45 GB` name (accepts ASCII and full-width colon). */
const FLOW_PATTERN = /剩余流量\s*[:：]\s*(.+)$/;
const EXPIRE_PATTERN = /套餐到期\s*[:：]\s*(.+)$/;
const AMOUNT_PATTERN = /^([\d.]+)\s*(PB|TB|GB|MB|KB|B)$/i;
const DATE_PATTERN = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/;

/** `579.45 GB` -> bytes. Unit-less numbers are bytes (the provider's own unit). */
export function parseByteAmount(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/\s+/g, ' ');
  const match = AMOUNT_PATTERN.exec(text);
  const value = match ? Number(match[1]) : /^\d+(\.\d+)?$/.test(text) ? Number(text) : null;
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  const unit = match ? match[2]!.toUpperCase() : 'B';
  const bytes = value * UNITS[unit]!;
  if (!Number.isFinite(bytes) || bytes > Number.MAX_SAFE_INTEGER) return null;
  // One decimal place of the reported figure is all we promise.
  return Math.round(bytes);
}

/** `2026-10-01` / `2026/10/01` / `2026.10.01 12:00` -> epoch seconds (UTC). */
export function parseExpireDate(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const match = DATE_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const monthValue = Number(month);
  const dayValue = Number(day);
  if (monthValue < 1 || monthValue > 12 || dayValue < 1 || dayValue > 31) return null;
  const ms = Date.UTC(
    Number(year),
    monthValue - 1,
    dayValue,
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  );
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/** `套餐到期：…` value -> expiry; `长期有效`-style text is kept as written. */
export function parseExpireText(raw: string | null | undefined): Pick<RawTrafficInfo, 'expire' | 'expireText'> {
  if (typeof raw !== 'string') return { expire: null, expireText: null };
  const text = raw.trim();
  if (!text) return { expire: null, expireText: null };
  if (OPEN_ENDED.test(text)) return { expire: null, expireText: text };
  const epoch = parseExpireDate(text);
  if (epoch !== null) return { expire: epoch, expireText: null };
  // Any other wording is still the provider's own report: show it verbatim.
  return { expire: null, expireText: text };
}

/**
 * Parse every info pseudo-node of one subscription. The **last** node of each
 * kind wins (providers append a single summary node; a repeated one is newer).
 * A node name that is not an info node is ignored, so a real `香港 剩余流量`
 * proxy name cannot leak numbers into the card unless it matches the whole
 * `剩余流量：…` form.
 */
export function parseRawTrafficInfo(nodes: ReadonlyArray<Pick<ProxyNode, 'name'>>): RawTrafficInfo {
  const info: RawTrafficInfo = { ...EMPTY_RAW_TRAFFIC_INFO };
  for (const node of nodes) {
    const name = typeof node?.name === 'string' ? node.name : '';
    if (!name || !isInfoNodeName(name)) continue;

    const flow = FLOW_PATTERN.exec(name);
    if (flow) {
      const remaining = parseByteAmount(flow[1]);
      if (remaining !== null) info.remaining = remaining;
      continue;
    }
    const expire = EXPIRE_PATTERN.exec(name);
    if (expire) {
      const parsed = parseExpireText(expire[1]);
      info.expire = parsed.expire;
      info.expireText = parsed.expireText;
    }
  }
  return info;
}

/** True when at least one part was read from the nodes. */
export function hasRawTrafficInfo(info: RawTrafficInfo | null | undefined): boolean {
  if (!info) return false;
  return info.remaining !== null || info.expire !== null || info.expireText !== null;
}
