// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Brute-force protection for POST /api/admin/login.
 *
 * Two bounded fixed-window limiters count *failed* attempts only:
 * - per client IP: `LOGIN_MAX_FAILURES_PER_IP` failures per 15 minutes;
 * - globally: `LOGIN_MAX_FAILURES` failures per 15 minutes across all IPs, so
 *   spreading attempts over many addresses does not help an attacker.
 *
 * The limiters never reject a request: once either bucket is exhausted the
 * caller must *slow down* (see `LOGIN_SLOWDOWN_*` below) before checking the
 * password, so brute force is still not practical while a legitimate operator
 * is never locked out and a correct password always works. Every counted
 * attempt is refunded when the password was right (successful logins
 * therefore neither consume the budget nor reset anything, and a correct
 * password still works from an IP with some earlier failures).
 *
 * Windows are aligned to the first counted failure, like `rate-limit.ts`; the
 * maps are hard-capped there so memory stays bounded. State is per worker and
 * lost on restart, which is acceptable for this single-password skeleton.
 */
import {
  createRateLimiter,
  type RateLimitOptions,
  type RateLimitResult,
} from './rate-limit';

/** Failure window: 15 minutes. */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Failed logins allowed per client IP per window. */
export const LOGIN_MAX_FAILURES_PER_IP = 5;

/** Failed logins allowed in total per window (all clients). */
export const LOGIN_MAX_FAILURES = 100;

/** Map cap for the per-IP buckets; distinct client IPs are untrusted input. */
export const LOGIN_MAX_KEYS = 4096;

/**
 * Delay applied before the password is checked once a bucket is exhausted.
 * The first slowed request waits `LOGIN_SLOWDOWN_BASE_MS`; every further
 * over-limit request on the same bucket doubles the delay, capped at
 * `LOGIN_SLOWDOWN_MAX_MS`, so hammering gets slower and slower without ever
 * becoming a hard lock. The ladder resets when the window ends or on a
 * successful (refunded) login.
 */
export const LOGIN_SLOWDOWN_BASE_MS = 1_000;

/** Upper bound for the slowdown delay (3s). */
export const LOGIN_SLOWDOWN_MAX_MS = 3_000;

/** Bucket key for the global limit. */
export const LOGIN_GLOBAL_KEY = 'global';

/** Fallback key when no client address is available. */
export const LOGIN_UNKNOWN_IP_KEY = 'unknown';

export interface LoginThrottleOptions {
  windowMs?: number;
  maxPerIp?: number;
  maxGlobal?: number;
  maxKeys?: number;
  now?: () => number;
}

export interface LoginThrottleDecision {
  /** Kept for compatibility; a throttle never rejects, so this is always true. */
  allowed: boolean;
  /** True when a bucket is exhausted and the caller must apply `delayMs`. */
  throttled: boolean;
  /** Delay (ms) to wait before checking the password; 0 when not throttled. */
  delayMs: number;
  /** Seconds until the exhausted window resets, when `throttled`. */
  retryAfter?: number;
}

export interface LoginThrottle {
  /**
   * Reserve one failed attempt for `ip`. When `throttled` is true the caller
   * must `await` `delayMs` before checking the password, then carry on.
   */
  consume(ip: string): LoginThrottleDecision;
  /** Forget a reserved attempt that turned out to be a successful login. */
  refund(ip: string): void;
  /** Forget every counter (tests only). */
  reset(): void;
  /** Total tracked keys across both limiters (tests/diagnostics). */
  size(): number;
}

export function createLoginThrottle(options: LoginThrottleOptions = {}): LoginThrottle {
  const windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
  const common: RateLimitOptions = {
    windowMs,
    maxKeys: options.maxKeys ?? LOGIN_MAX_KEYS,
    now: options.now,
  };
  const perIp = createRateLimiter({ ...common, max: options.maxPerIp ?? LOGIN_MAX_FAILURES_PER_IP });
  const global = createRateLimiter({ ...common, max: options.maxGlobal ?? LOGIN_MAX_FAILURES });

  /**
   * Over-limit hits per bucket key, so the delay keeps growing while a key is
   * hammered. Bounded like the limiter maps: entries reset when the window of
   * that key rolls over or on a successful (refunded) attempt.
   */
  const strikes = new Map<string, number>();

  /** Exponential backoff: base delay, doubled per earlier over-limit hit, capped. */
  function backoff(hits: number): number {
    const factor = 2 ** Math.min(Math.max(hits, 0), 8);
    return Math.min(LOGIN_SLOWDOWN_MAX_MS, LOGIN_SLOWDOWN_BASE_MS * factor);
  }

  function slowed(key: string, result: RateLimitResult): LoginThrottleDecision {
    const hits = strikes.get(key) ?? 0;
    if (strikes.size >= (options.maxKeys ?? LOGIN_MAX_KEYS) && !strikes.has(key)) {
      // Hard cap: drop the oldest backoff entry.
      const oldest = strikes.keys().next();
      if (!oldest.done) strikes.delete(oldest.value);
    }
    strikes.set(key, hits + 1);
    return {
      allowed: true,
      throttled: true,
      delayMs: backoff(hits),
      retryAfter: result.retryAfter,
    };
  }

  return {
    consume(ip) {
      // Count the IP bucket first: a flood of new IPs still hits the global
      // bucket. Neither bucket ever rejects; an exhausted one only flags a
      // slowdown. Both are always counted so they stay in step.
      const ipKey = ip || LOGIN_UNKNOWN_IP_KEY;
      const ipResult = perIp.consume(ipKey);
      const globalResult = global.consume(LOGIN_GLOBAL_KEY);
      if (!ipResult.allowed) return slowed(ipKey, ipResult);
      if (!globalResult.allowed) return slowed(LOGIN_GLOBAL_KEY, globalResult);
      // Fresh window (or refunded key): the backoff ladder starts over.
      strikes.delete(ipKey);
      strikes.delete(LOGIN_GLOBAL_KEY);
      return { allowed: true, throttled: false, delayMs: 0 };
    },
    refund(ip) {
      const ipKey = ip || LOGIN_UNKNOWN_IP_KEY;
      perIp.refund(ipKey);
      global.refund(LOGIN_GLOBAL_KEY);
      strikes.delete(ipKey);
      strikes.delete(LOGIN_GLOBAL_KEY);
    },
    reset() {
      perIp.reset();
      global.reset();
      strikes.clear();
    },
    size: () => perIp.size() + global.size(),
  };
}

/** Process-wide throttle used by the login route. */
export const adminLoginThrottle = createLoginThrottle();
