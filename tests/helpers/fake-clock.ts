// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal controllable clock for tests that must observe *real* waiting.
 *
 * `clock.sleep(ms)` never resolves on its own: it records the interval between
 * its `start` and `end` and resolves only when the test calls `clock.tick(ms)`,
 * which advances the virtual time and fires every timer that is due (in order).
 * Nothing is faked globally; the code under test really awaits the promises, so
 * a test can assert that a request is *still pending* before time moves.
 *
 * Not a test file itself (no `.test.ts`), so vitest does not collect it.
 */
export interface SleepInterval {
  /** Start offset in ms on the fake timeline. */
  start: number;
  /** End offset in ms, filled when the timer fires. */
  end?: number;
  duration: number;
}

interface Pending {
  at: number;
  resolve: () => void;
  interval: SleepInterval;
}

export function createFakeClock() {
  let now = 0;
  const pending: Pending[] = [];
  const intervals: SleepInterval[] = [];

  function sleep(ms: number): Promise<void> {
    const interval: SleepInterval = { start: now, duration: ms };
    intervals.push(interval);
    return new Promise<void>((resolve) => {
      pending.push({ at: now + ms, resolve, interval });
    });
  }

  /** Advance virtual time by `ms`, firing due timers in order (ties by queue). */
  function tick(ms: number): void {
    const target = now + ms;
    for (;;) {
      // Stable enough for our purposes: timers that are due together fire in
      // insertion order (modern V8 sorts are stable).
      pending.sort((a, b) => a.at - b.at);
      const next = pending[0];
      if (!next || next.at > target) break;
      pending.shift();
      now = next.at;
      next.interval.end = now;
      next.resolve();
    }
    now = target;
  }

  /** Drop every timer the test no longer awaits (keeps teardown quiet). */
  function clear(): void {
    pending.length = 0;
  }

  return {
    sleep,
    tick,
    clear,
    /** Recorded sleeps (in the order they were requested). */
    intervals,
    /** Sleeps that have not fired yet. */
    pendingCount: () => pending.length,
    now: () => now,
  };
}

/**
 * Let the event loop run without advancing the fake clock: pending
 * microtasks (promise-chain steps) and already-scheduled `setImmediate` /
 * zero-delay timers (e.g. the fake request body in the login tests).
 * Promises resolved by the fake clock are *not* fired — only `clock.tick` does.
 */
export async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
