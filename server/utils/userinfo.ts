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
 *
 * `mergeUserInfo` is the one place where a source's incomplete header is
 * completed from its own info pseudo-nodes (`剩余流量：579.45 GB`, see
 * `core/rules/raw-info.ts`). The user center and the export both call it, so
 * the numbers they show can never drift apart.
 */
import { parseSubscription } from '../../core/parsers/clash';
import {
  hasRawTrafficInfo,
  parseRawTrafficInfo,
  type RawTrafficInfo,
} from '../../core/rules/raw-info';

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
 * Info nodes of a cached subscription, or `null` when the cache is empty or
 * does not parse. Only the *read* path inspects them; nothing is filtered or
 * written here.
 */
export function rawTrafficInfoFromCache(
  blob: string | null | undefined,
): RawTrafficInfo | null {
  const text = blob?.trim();
  if (!text) return null;
  try {
    const info = parseRawTrafficInfo(parseSubscription(text));
    return hasRawTrafficInfo(info) ? info : null;
  } catch {
    return null;
  }
}

/**
 * Remaining traffic the header can tell us: `total - upload - download`.
 *
 * `null` when the header has no total, and also when it has *only* a total: a
 * provider that reports the quota but no usage is exactly the xxcloud case,
 * where `total - 0 - 0 = total` would hide the real figure its info node
 * carries (`剩余流量：579.45 GB`). A total plus usage is real arithmetic.
 */
function remainingFromHeader(info: SubscriptionUserInfo | null): number | null {
  if (!info || info.total === null) return null;
  if (info.upload === null && info.download === null) return null;
  return Math.max(0, info.total - (info.upload ?? 0) - (info.download ?? 0));
}

/** Result of completing a header with its subscription's own info nodes. */
export interface MergedUserInfo {
  userinfo: SubscriptionUserInfo | null;
  remaining: number | null;
  expireText: string | null;
  rawFields: Array<'remaining' | 'expire'>;
}

/**
 * Merge the header userinfo with the source's own info nodes.
 *
 * The header wins per field; only the fields it is missing are filled from
 * `剩余流量` / `套餐到期`. When the header has a total but **both** usage fields
 * are missing, the info node's remaining is turned into used (total −
 * remaining, clamped at 0) and recorded as `download` with `upload = 0` — the
 * convention clients use to compute 已用 as upload + download. A header that
 * carries real upload/download stays untouched, even when they are 0. `total`
 * is header-only; the info nodes have no quota to invent it from.
 */
export function mergeUserInfo(
  header: SubscriptionUserInfo | null,
  raw: RawTrafficInfo | null,
): MergedUserInfo {
  const userinfo: SubscriptionUserInfo | null = header ? { ...header } : null;
  const rawFields: Array<'remaining' | 'expire'> = [];

  let remaining = remainingFromHeader(header);
  if (remaining === null && raw?.remaining !== null && raw?.remaining !== undefined) {
    remaining = raw.remaining;
    rawFields.push('remaining');
  }

  let expireText: string | null = null;
  const headerHasExpire = userinfo?.expire !== null && userinfo?.expire !== undefined;
  if (!headerHasExpire && raw) {
    if (raw.expire !== null) {
      if (userinfo) {
        userinfo.expire = raw.expire;
      } else {
        // No header at all: never synthesize one from raw nodes alone (the
        // export must not invent a header), but the date still surfaces as
        // display text for the user center. (Guarded: this branch used to
        // write through a non-null assertion and crash on headerless
        // sources whose expiry node is a date.)
        expireText = new Date(raw.expire * 1000).toISOString().slice(0, 10);
      }
      rawFields.push('expire');
    } else if (raw.expireText) {
      expireText = raw.expireText;
      rawFields.push('expire');
    }
  }

  // Usage derivation only for a total whose usage is completely absent. One
  // real usage field (even 0) means the provider is reporting usage itself.
  if (
    userinfo &&
    userinfo.upload === null &&
    userinfo.download === null &&
    userinfo.total !== null &&
    remaining !== null
  ) {
    const used = Math.max(0, userinfo.total - remaining);
    userinfo.upload = 0;
    userinfo.download = used;
  }

  return { userinfo: userinfo && hasUserInfo(userinfo) ? userinfo : null, remaining, expireText, rawFields };
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
