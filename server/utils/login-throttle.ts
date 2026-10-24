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
 * attempt that was actually counted is refunded when the password was right
 * (successful logins therefore neither consume the budget nor reset
 * anything, and a correct password still works from an IP with some earlier
 * failures).
 *
 * The delays are *serialized*, not merely applied per request: `awaitThrottle`
 * puts every slowed request behind the previous one for the same IP (and,
 * when the global bucket is exhausted, behind one global chain), so N slowed
 * requests take about N * delay wall-clock time. Without that a burst of
 * concurrent requests would all sleep in parallel and hit `verifyAdminPassword`
 * in the same instant, which would defeat the point of the slowdown.
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

/**
 * Hard cap on the number of per-IP delay chains kept between requests. Only
 * throttled keys get an entry and each is dropped once its queue drains; the
 * cap is a backstop against a flood of made-up (proxied) addresses.
 */
export const LOGIN_MAX_QUEUED_KEYS = 4096;

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
  /** Client IP the decision was made for (the serialization key). */
  ip: string;
  /**
   * True when the global bucket is exhausted, i.e. the request must also wait
   * on the global chain (otherwise IPs that still have budget could flood).
   */
  global: boolean;
  /**
   * True when this decision actually reserved budget in at least one bucket.
   * `refund` is only meaningful then: refunding a request that was over both
   * limits would hand back a slot someone else legitimately used.
   */
  counted: boolean;
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

  function slowed(key: string, result: RateLimitResult): Pick<
    LoginThrottleDecision,
    'throttled' | 'delayMs' | 'retryAfter'
  > {
    const hits = strikes.get(key) ?? 0;
    if (strikes.size >= (options.maxKeys ?? LOGIN_MAX_KEYS) && !strikes.has(key)) {
      // Hard cap: drop the oldest backoff entry.
      const oldest = strikes.keys().next();
      if (!oldest.done) strikes.delete(oldest.value);
    }
    strikes.set(key, hits + 1);
    return {
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
      // A request only counts against the buckets it was actually admitted to,
      // so `refund` keeps them in step.
      const ipCounted = ipResult.allowed;
      const globalCounted = globalResult.allowed;
      if (ipCounted && globalCounted) {
        // Fresh window (or refunded key): the backoff ladder starts over.
        strikes.delete(ipKey);
        strikes.delete(LOGIN_GLOBAL_KEY);
        return {
          allowed: true,
          throttled: false,
          delayMs: 0,
          ip: ipKey,
          global: false,
          counted: true,
        };
      }
      // Pick the bucket that is exhausted; when both are, the per-IP ladder
      // wins (it is the more specific and usually the longer one).
      const exhausted = !ipCounted ? ipKey : LOGIN_GLOBAL_KEY;
      const result = !ipCounted ? ipResult : globalResult;
      return {
        allowed: true,
        ...slowed(exhausted, result),
        ip: ipKey,
        global: !globalCounted,
        counted: ipCounted || globalCounted,
      };
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

/** Real timer; the default `sleep` for `awaitThrottle`. */
export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Per-key promise chain used to serialize the slowdown delays.
 *
 * `enqueue(key, task)` appends `task` to the chain of `key`: the task only
 * starts once every earlier task on the same key has settled, and its own
 * settlement releases the next one. Keys are independent of each other, so
 * two IPs (or an IP and the global chain) never wait for one another unless
 * the caller chains both.
 *
 * The map only holds keys with a pending task; it drains as soon as the last
 * task for a key settles, and is hard-capped so a flood of keys cannot grow it
 * without bound (over the cap the task runs unchained — it is still delayed,
 * just not serialized with its siblings).
 */
export function createKeyedQueue(maxKeys = LOGIN_MAX_QUEUED_KEYS) {
  const tails = new Map<string, Promise<void>>();

  async function enqueue<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const previous = tails.get(key);
    if (previous === undefined && tails.size >= maxKeys) {
      // Backstop: never let the chain map grow without bound.
      return task();
    }
    const run = (async () => {
      if (previous) await previous.catch(() => {});
      return task();
    })();
    // The tail never rejects (the caller sees the rejection via `run`), so one
    // failed task cannot poison the chain for the requests after it.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  }

  return {
    enqueue,
    /** Number of keys with a pending task (tests/diagnostics). */
    size: () => tails.size,
  };
}

/** Delay chains used by the login route: one per exhausted IP plus one global. */
export const adminLoginQueue = createKeyedQueue();

/**
 * Wait out `decision.delayMs` *behind* every other slowed request for the same
 * IP (and behind the global chain when `decision.global`). The returned
 * promise settles once this request's own delay has elapsed; because the chains
 * serialize each other, N slowed requests from one IP take ~N * delay instead
 * of all of them sleeping at the same time.
 *
 * Not throttled: resolves immediately without touching the chains.
 */
export async function awaitThrottle(
  decision: LoginThrottleDecision,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  queue: Pick<ReturnType<typeof createKeyedQueue>, 'enqueue'> = adminLoginQueue,
): Promise<void> {
  if (!decision.throttled || decision.delayMs <= 0) return;
  // A bad clock or a hostile override must not stall the chain for everyone.
  const delayMs = Math.min(Math.max(decision.delayMs, 0), LOGIN_SLOWDOWN_MAX_MS);
  const wait = () => sleep(delayMs);
  // Global first (outer), IP last (inner): a request that is over both waits
  // for the global and the IP chains, and releases the global one too.
  const chained = (key: string, task: () => Promise<void>) =>
    queue.enqueue(key === LOGIN_GLOBAL_KEY ? `global:${key}` : `ip:${key}`, task);
  const inIpChain = () => chained(decision.ip, wait);
  await (decision.global ? chained(LOGIN_GLOBAL_KEY, inIpChain) : inIpChain());
}

/** Process-wide throttle used by the login route. */
export const adminLoginThrottle = createLoginThrottle();

/** Convenience: wait out `decision` on the process-wide queue. */
export function awaitLoginThrottle(
  decision: LoginThrottleDecision,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  return awaitThrottle(decision, sleep, adminLoginQueue);
}
