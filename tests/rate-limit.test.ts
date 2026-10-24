// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createRateLimiter, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../server/utils/rate-limit';

describe('rate limiter', () => {
  it('allows 30 requests per token per minute and blocks the 31st', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
      expect(limiter.check('token-a')).toBe(true);
    }
    expect(limiter.check('token-a')).toBe(false);
  });

  it('counts tokens independently', () => {
    const limiter = createRateLimiter({ max: 2 });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    expect(limiter.check('b')).toBe(true);
  });

  it('opens a new window after the interval and reports retry-after', () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({ max: 2, windowMs: 1_000, now: () => clock });

    expect(limiter.consume('t')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('t')).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = limiter.consume('t');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(1);

    clock += 1_000;
    expect(limiter.consume('t')).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('sweeps expired tokens out of the map', () => {
    let clock = 0;
    const limiter = createRateLimiter({ max: 5, windowMs: 1_000, now: () => clock });
    limiter.check('a');
    limiter.check('b');
    expect(limiter.size()).toBe(2);
    clock += RATE_LIMIT_WINDOW_MS;
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
    limiter.check('c');
    expect(limiter.size()).toBe(1);
  });

  it('rejects invalid limits', () => {
    expect(() => createRateLimiter({ max: 0 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 0 })).toThrow();
  });
});

describe('rate limiter defaults', () => {
  it('defaults to 30 requests per 60 seconds', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 30; i += 1) expect(limiter.check('defaults')).toBe(true);
    expect(limiter.check('defaults')).toBe(false);
  });
});
