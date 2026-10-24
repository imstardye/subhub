// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `subscription-userinfo` header parsing and aggregation.
 *
 * The header is how a subscription provider tells a client about traffic and
 * expiry, e.g. (Clash/mihomo convention):
 *
 *   upload=1024; download=2048; total=1099511627776; expire=1798761600
 *
 * Every part is optional and providers spell them differently (case, spaces,
 * order, extra keys, `bytes=` for `total=`). This module only ever accepts the
 * documented numeric form and treats anything else as "not present" — a
 * garbage header must not make a refresh fail, nor overwrite good stored data.
 *
 * Plain functions without DB/Nuxt imports, so the refresh task, the export
 * handler and the admin DTO all share the exact same rules.
 */

/** Parsed header values. A missing (or invalid) part is `null`. */
export interface SubscriptionUserInfo {
  upload: number | null;
  download: number | null;
  total: number | null;
  /** Unix epoch **seconds** (as the header spells it). */
  expire: number | null;
}

/** Header name, lower-case (HTTP headers are case-insensitive). */
export const USERINFO_HEADER = 'subscription-userinfo';

/** Largest exactly-representable byte count / timestamp we accept. */
const MAX_VALUE = Number.MAX_SAFE_INTEGER;

/**
 * Parse one numeric field. Accepts digits with optional surrounding
 * whitespace; rejects negatives, fractions, units and anything above
 * `Number.MAX_SAFE_INTEGER` (where arithmetic would silently lose precision).
 */
function parseAmount(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_VALUE ? value : null;
}

/**
 * Parse a `subscription-userinfo` header value.
 *
 * Returns `null` when nothing usable is present: an empty/absent header, a
 * value that is not `key=value` pairs at all, or only unknown keys. Unknown
 * keys are ignored; recognised keys with invalid values become `null` while
 * their siblings survive.
 */
export function parseUserInfo(header: string | null | undefined): SubscriptionUserInfo | null {
  if (typeof header !== 'string') return null;
  const text = header.trim();
  if (!text) return null;

  const info: SubscriptionUserInfo = { upload: null, download: null, total: null, expire: null };
  let seen = false;

  for (const part of text.split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const separator = piece.indexOf('=');
    if (separator <= 0) continue;
    const key = piece.slice(0, separator).trim().toLowerCase();
    const value = parseAmount(piece.slice(separator + 1));

    // `bytes` is a common alias for `total` in the wild.
    const field = key === 'bytes' ? 'total' : key;
    if (field !== 'upload' && field !== 'download' && field !== 'total' && field !== 'expire') {
      continue;
    }
    seen = true;
    if (value !== null) info[field] = value;
  }

  if (!seen) return null;
  if (info.upload === null && info.download === null && info.total === null && info.expire === null) {
    return null;
  }
  return info;
}

/** Does the parsed info carry at least one usable field? */
export function hasUserInfo(info: SubscriptionUserInfo | null | undefined): boolean {
  if (!info) return false;
  return (
    info.upload !== null || info.download !== null || info.total !== null || info.expire !== null
  );
}

/** The parts that exist, in the canonical Clash order (`upload; download; total; expire`). */
export function formatUserInfo(info: SubscriptionUserInfo): string {
  const parts: string[] = [];
  if (info.upload !== null) parts.push(`upload=${info.upload}`);
  if (info.download !== null) parts.push(`download=${info.download}`);
  if (info.total !== null) parts.push(`total=${info.total}`);
  if (info.expire !== null) parts.push(`expire=${info.expire}`);
  return parts.join('; ');
}

/**
 * Aggregate the sources of one export.
 *
 * - `upload`/`download`/`total` are summed over the sources that report them
 *   (a source without the value contributes nothing, it does not zero it);
 * - `expire` is the smallest **positive** epoch seconds, i.e. the moment the
 *   bundle runs out first (0/`null` mean "no expiry", never "expired in 1970").
 *
 * Returns `null` when no source carries any usable value, so the caller emits
 * no header at all instead of a fabricated one.
 */
export function aggregateUserInfo(
  entries: ReadonlyArray<SubscriptionUserInfo | null | undefined>,
): SubscriptionUserInfo | null {
  let upload: number | null = null;
  let download: number | null = null;
  let total: number | null = null;
  let expire: number | null = null;

  const add = (current: number | null, value: number | null): number | null => {
    if (value === null) return current;
    const next = (current ?? 0) + value;
    // Beyond 2^53 sums stop being exact; clamp rather than emit a wrong number.
    return Number.isSafeInteger(next) ? next : MAX_VALUE;
  };

  for (const info of entries) {
    if (!info) continue;
    upload = add(upload, info.upload);
    download = add(download, info.download);
    total = add(total, info.total);
    if (info.expire !== null && info.expire > 0) {
      expire = expire === null ? info.expire : Math.min(expire, info.expire);
    }
  }

  const result: SubscriptionUserInfo = { upload, download, total, expire };
  return hasUserInfo(result) ? result : null;
}
