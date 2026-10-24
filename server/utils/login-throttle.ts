// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Brute-force protection for POST /api/admin/login.
 *
 * Two bounded fixed-window limiters count *failed* attempts only:
 * - per client IP: `LOGIN_MAX_FAILURES_PER_IP` failures per 15 minutes;
 * - globally: `LOGIN_MAX_FAILURES` failures per 15 minutes across all IPs, so
 *   spreading attempts over many addresses does not help an attacker.
 *
 * A request must be admitted by both buckets before the password is checked;
 * the attempt is counted up front and refunded when the password was right
 * (successful logins therefore neither consume the budget nor reset anything,
 * and a correct password still works from an IP with some earlier failures).
 * Note that a blocked (429) request is not counted, so the window always ends
 * 15 minutes after the first counted failure.
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
  allowed: boolean;
  /** Populated when `allowed` is false. */
  retryAfter?: number;
}

export interface LoginThrottle {
  /**
   * Reserve one failed attempt for `ip`. `allowed: false` means the caller
   * must answer 429 without checking the password.
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

  function blocked(result: RateLimitResult): LoginThrottleDecision {
    return { allowed: false, retryAfter: result.retryAfter };
  }

  return {
    consume(ip) {
      // Count the IP bucket first: a flood of new IPs still hits the global
      // bucket, which is checked before any password work happens.
      const ipResult = perIp.consume(ip || LOGIN_UNKNOWN_IP_KEY);
      if (!ipResult.allowed) return blocked(ipResult);
      const globalResult = global.consume(LOGIN_GLOBAL_KEY);
      if (!globalResult.allowed) {
        // Not admitted: keep the IP bucket in step with the global one.
        perIp.refund(ip || LOGIN_UNKNOWN_IP_KEY);
        return blocked(globalResult);
      }
      return { allowed: true };
    },
    refund(ip) {
      perIp.refund(ip || LOGIN_UNKNOWN_IP_KEY);
      global.refund(LOGIN_GLOBAL_KEY);
    },
    reset() {
      perIp.reset();
      global.reset();
    },
    size: () => perIp.size() + global.size(),
  };
}

/** Process-wide throttle used by the login route. */
export const adminLoginThrottle = createLoginThrottle();
