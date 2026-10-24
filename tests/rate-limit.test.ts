// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  createRateLimiter,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_KEYS,
  RATE_LIMIT_WINDOW_MS,
} from '../server/utils/rate-limit';

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
    expect(() => createRateLimiter({ maxKeys: 0 })).toThrow();
  });
});

describe('rate limiter hard cap', () => {
  it('never tracks more than maxKeys entries', () => {
    const limiter = createRateLimiter({ max: 1, maxKeys: 8 });
    // Same clock for every call: nothing expires, so only eviction bounds the map.
    for (let i = 0; i < 10_000; i += 1) limiter.check(`fake-token-${i}`);
    expect(limiter.size()).toBe(8);
  });

  it('evicts the oldest key first and keeps recent ones', () => {
    const limiter = createRateLimiter({ max: 1, maxKeys: 2 });
    expect(limiter.consume('old').allowed).toBe(true);
    expect(limiter.consume('mid').allowed).toBe(true);
    // Third key evicts 'old'; 'mid' is still at its limit.
    expect(limiter.consume('new').allowed).toBe(true);
    expect(limiter.size()).toBe(2);
    expect(limiter.check('mid')).toBe(false);
    // 'old' was forgotten, so it starts a fresh window instead of staying blocked.
    expect(limiter.consume('old').allowed).toBe(true);
    expect(limiter.size()).toBe(2);
  });

  it('defaults to a 4096-key cap', () => {
    expect(RATE_LIMIT_MAX_KEYS).toBe(4096);
    const limiter = createRateLimiter({ max: 1 });
    for (let i = 0; i < RATE_LIMIT_MAX_KEYS + 1_000; i += 1) limiter.check(`t${i}`);
    expect(limiter.size()).toBe(RATE_LIMIT_MAX_KEYS);
  });
});

describe('rate limiter defaults', () => {
  it('defaults to 30 requests per 60 seconds', () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 30; i += 1) expect(limiter.check('defaults')).toBe(true);
    expect(limiter.check('defaults')).toBe(false);
  });
});

describe('rate limiter refund', () => {
  it('gives back the most recent counted request', () => {
    const limiter = createRateLimiter({ max: 2 });
    expect(limiter.consume('k').remaining).toBe(1);
    limiter.refund('k');
    expect(limiter.consume('k').remaining).toBe(1);
    expect(limiter.consume('k').remaining).toBe(0);
    expect(limiter.check('k')).toBe(false);
  });

  it('never refunds below zero and ignores unseen keys', () => {
    const limiter = createRateLimiter({ max: 2 });
    limiter.refund('missing');
    limiter.refund('missing');
    expect(limiter.size()).toBe(0);
    limiter.check('k');
    limiter.refund('k');
    limiter.refund('k');
    expect(limiter.consume('k')).toMatchObject({ allowed: true, remaining: 1 });
  });
});
