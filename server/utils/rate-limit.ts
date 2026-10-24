// SPDX-License-Identifier: AGPL-3.0-only
/**
 * In-memory, per-token fixed-window rate limiter for the subscription export.
 *
 * A single Nuxt/Nitro process keeps the counters in a `Map`; the limiter is not
 * shared across workers or restarts. That is intentional for now — when the
 * service runs behind multiple instances the check must move to a shared store.
 *
 * Window: one minute (aligned to the first request of the window). The map is
 * hard-capped at `RATE_LIMIT_MAX_KEYS`: expired entries are swept lazily and,
 * when the cap is reached anyway (e.g. a flood of made-up tokens), the oldest
 * entry is evicted first so memory cannot grow without bound. The export route
 * additionally keeps unknown tokens out of the limiter (IP bucket instead), so
 * the cap is a backstop and not the primary defence.
 */

/** Requests allowed per token per window. */
export const RATE_LIMIT_MAX = 30;

/** Window length in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Hard cap on tracked keys per limiter; oldest entries are evicted first. */
export const RATE_LIMIT_MAX_KEYS = 4096;

interface WindowState {
  /** Start of the current window (epoch ms). */
  start: number;
  /** Requests counted in the window, including the current one. */
  count: number;
}

export interface RateLimitOptions {
  /** Per-token limit, default `RATE_LIMIT_MAX`. */
  max?: number;
  /** Window length in ms, default `RATE_LIMIT_WINDOW_MS`. */
  windowMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** Hard cap on tracked keys, default `RATE_LIMIT_MAX_KEYS`. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window (0 when blocked). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** `Retry-After` value in whole seconds, if this request was blocked. */
  retryAfter?: number;
}

export interface RateLimiter {
  /** Count one request for `key`; `false` means the limit was exceeded. */
  check(key: string): boolean;
  /** Same as `check` but with the counters needed for response headers. */
  consume(key: string): RateLimitResult;
  /** Forget all counters (tests only). */
  reset(): void;
  /** Current number of tracked keys (tests/diagnostics). */
  size(): number;
}

/** Drop keys whose window ended; called after counting, at most once per window. */
function sweep(map: Map<string, WindowState>, now: number, windowMs: number): void {
  for (const [key, state] of map) {
    if (now - state.start >= windowMs) map.delete(key);
  }
}

export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const max = options.max ?? RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? RATE_LIMIT_MAX_KEYS;
  if (!Number.isFinite(max) || max < 1) throw new RangeError('rate limit max must be >= 1');
  if (!Number.isFinite(windowMs) || windowMs < 1) {
    throw new RangeError('rate limit windowMs must be >= 1');
  }
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError('rate limit maxKeys must be an integer >= 1');
  }

  const windows = new Map<string, WindowState>();
  let lastSweep = 0;

  function consume(key: string): RateLimitResult {
    const at = now();
    let state = windows.get(key);
    if (!state || at - state.start >= windowMs) {
      const expired = state !== undefined;
      if (!expired && windows.size >= maxKeys) {
        // Hard cap: sweep expired windows first, then evict the oldest entry
        // (Map insertion order). Re-inserting a key moves it to the back, so
        // the front is always the oldest window.
        sweep(windows, at, windowMs);
        lastSweep = at;
        if (windows.size >= maxKeys) {
          const oldest = windows.keys().next();
          if (!oldest.done) windows.delete(oldest.value);
        }
      }
      state = { start: at, count: 0 };
      windows.set(key, state);
    }

    const resetAt = state.start + windowMs;
    if (state.count >= max) {
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(1, Math.ceil((resetAt - at) / 1000)),
      };
    }

    state.count += 1;
    if (at - lastSweep >= windowMs) {
      lastSweep = at;
      sweep(windows, at, windowMs);
    }

    return { allowed: true, remaining: max - state.count, resetAt };
  }

  return {
    check: (key) => consume(key).allowed,
    consume,
    reset: () => windows.clear(),
    size: () => windows.size,
  };
}

/**
 * Process-wide limiter used by the subscription route.
 *
 * Nitro keeps one instance per worker, so the counter resets on deploy/restart.
 */
export const subscriptionRateLimiter = createRateLimiter();
