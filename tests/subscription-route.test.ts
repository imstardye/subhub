// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { openDb, type SubhubDb } from '../server/db';
import { accessLogs, sources, userSources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import {
  detectTargetFromUserAgent,
  exportRateLimiterSize,
  handleSubscriptionExport,
  resetExportRateLimiter,
  resolveTarget,
} from '../server/utils/subscription';
import { RATE_LIMIT_MAX } from '../server/utils/rate-limit';

/** Test-only token; every fixture host below is example.com. */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DISABLED_TOKEN = 'f'.repeat(32);

const dirs: string[] = [];
let db: SubhubDb;
let userId: number;
let disabledUserId: number;

beforeEach(() => {
  resetExportRateLimiter();
  const dir = mkdtempSync(join(tmpdir(), 'subhub-export-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });

  const inserted = db
    .insert(users)
    .values({ name: 'fixture-user', token: TOKEN, enabled: true })
    .returning({ id: users.id })
    .get();
  userId = inserted!.id;

  const disabled = db
    .insert(users)
    .values({ name: 'disabled-user', token: DISABLED_TOKEN, enabled: false })
    .returning({ id: users.id })
    .get();
  disabledUserId = disabled!.id;
});

afterEach(() => {
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function call(token: string, target?: string | null, userAgent?: string | null, ip = '127.0.0.1') {
  return handleSubscriptionExport(
    { token, target, userAgent: userAgent ?? 'clash-verge/v2.0', ip },
    { db },
  );
}

function attachSource(cacheBlob: string | null, ownerId = userId): number {
  const source = db
    .insert(sources)
    .values({
      name: 'fixture-source',
      // Never a real URL: encrypted placeholder text only.
      url: encrypt('placeholder-source-not-a-real-subscription'),
      type: 'local',
      cacheBlob,
    })
    .returning({ id: sources.id })
    .get();
  db.insert(userSources).values({ userId: ownerId, sourceId: source!.id, sort: 0 }).run();
  return source!.id;
}

describe('GET /s/:token rate limiting', () => {
  it('returns 200 for the first 30 requests and 429 afterwards', () => {
    for (let i = 0; i < 30; i += 1) {
      expect(call(TOKEN).status).toBe(200);
    }
    const blocked = call(TOKEN);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTypeOf('string');
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('counts each token separately', () => {
    for (let i = 0; i < 30; i += 1) call(TOKEN);
    expect(call(TOKEN).status).toBe(429);
    // A different (disabled) token is still rate limited on its own budget and
    // answered with 404, not 429.
    expect(call(DISABLED_TOKEN).status).toBe(404);
  });

});

describe('GET /s/:token unknown tokens', () => {
  it('does not create one limiter entry per made-up token', () => {
    // Each request uses a fresh random token: a per-token map would grow by
    // one entry per request. Requests beyond the IP budget are 429, never a
    // new map entry.
    for (let i = 0; i < 500; i += 1) {
      expect([404, 429]).toContain(call(`fake-${i}-${'x'.repeat(16)}`).status);
    }
    expect(exportRateLimiterSize()).toBe(1);
  });

  it('rate limits unknown tokens per IP instead of per token', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) {
      expect(call(`fake-${i}`).status).toBe(404);
    }
    expect(call('another-fake-token').status).toBe(429);
    // A different client IP still gets its own budget.
    expect(call('another-fake-token', null, null, '198.51.100.7').status).toBe(404);
    // The map stays at one entry per IP seen, regardless of token count.
    expect(exportRateLimiterSize()).toBe(2);
  });

  it('never exceeds a bounded map under a large token flood', () => {
    let blocked = 0;
    for (let i = 0; i < 2_000; i += 1) {
      const status = call(`flood-${i}-${'y'.repeat(24)}`, null, null, `192.0.2.${i % 8}`).status;
      if (status === 429) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
    // Bounded by the number of distinct IPs (8), not by the 2k tokens.
    expect(exportRateLimiterSize()).toBeLessThanOrEqual(8);
  });

  it('still applies the per-token limit to known users', () => {
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) call(TOKEN);
    expect(call(TOKEN).status).toBe(429);
    // The disabled user is tracked in the IP bucket, not the token bucket.
    expect(call(DISABLED_TOKEN).status).toBe(404);
    expect(exportRateLimiterSize()).toBe(2);
  });
});

describe('GET /s/:token user lookup', () => {
  it('returns 404 for an unknown token', () => {
    const response = call('0'.repeat(32));
    expect(response.status).toBe(404);
    expect(response.body).toContain('Not Found');
  });

  it('returns 404 for a disabled user', () => {
    expect(call(DISABLED_TOKEN).status).toBe(404);
  });

  it('returns 404 for an empty token without touching the database', () => {
    expect(call('').status).toBe(404);
  });

  it('logs 404 and 200 responses to access_logs', () => {
    call('0'.repeat(32));
    expect(call(TOKEN).status).toBe(200);

    const logs = db.select().from(accessLogs).all();
    expect(logs.some((log) => log.status === 404 && log.userId === null)).toBe(true);
    const ok = logs.find((log) => log.status === 200);
    expect(ok).toMatchObject({ userId, target: 'clash', ip: '127.0.0.1' });
    expect(ok?.ms).toBeTypeOf('number');
    expect(db.select().from(accessLogs).where(eq(accessLogs.userId, disabledUserId)).all()).toEqual([]);
  });
});

describe('GET /s/:token valid export', () => {
  it('returns 200 with an empty proxies list when the user has no sources', () => {
    const response = call(TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/yaml');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="subhub-${userId}-clash.yaml"`,
    );
    expect(response.headers['subscription-userinfo']).toBe(
      'upload=0; download=0; total=0; expire=0',
    );
    expect(parseYaml(response.body)).toEqual({ proxies: [] });
  });

  it('sends cache-control: no-store and the security headers on 200', () => {
    attachSource(null);
    for (const target of [undefined, 'clash', 'mihomo']) {
      const response = call(TOKEN, target);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('returns 200 with an empty proxies list when the source cache is empty', () => {
    attachSource(null);
    attachSource('   ');
    const response = call(TOKEN, 'mihomo');
    expect(response.status).toBe(200);
    expect(parseYaml(response.body)).toEqual({ proxies: [] });
  });

  it('falls back to mihomo YAML for targets that are not implemented yet (P4)', () => {
    attachSource('proxies:\n  - {name: "fixture-ss", type: ss, server: example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}\n');
    for (const target of ['mihomo', 'shadowrocket', 'singbox', 'surge', 'loon', 'uri']) {
      const response = call(TOKEN, target);
      expect(response.status).toBe(200);
      const yaml = parseYaml(response.body) as { proxies: Array<{ name: string }> };
      expect(yaml.proxies.map((proxy) => proxy.name)).toEqual(['fixture-ss']);
      expect(response.headers['content-disposition']).toContain(`-${target}.yaml`);
    }
  });

  it('rejects an unknown explicit target without disclosing anything', () => {
    const response = call(TOKEN, 'not-a-target');
    expect(response.status).toBe(400);
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});

describe('target detection', () => {
  it('guesses from the User-Agent and defaults to mihomo', () => {
    expect(detectTargetFromUserAgent('Shadowrocket/1.0 CFNetwork')).toBe('shadowrocket');
    expect(detectTargetFromUserAgent('sing-box 1.10')).toBe('singbox');
    expect(detectTargetFromUserAgent('Surge/5 iOS')).toBe('surge');
    expect(detectTargetFromUserAgent('Loon/3')).toBe('loon');
    expect(detectTargetFromUserAgent('clash-verge/v2')).toBe('clash');
    expect(detectTargetFromUserAgent('curl/8')).toBe('mihomo');
    expect(detectTargetFromUserAgent(null)).toBe('mihomo');
  });

  it('prefers an explicit target over the User-Agent', () => {
    expect(resolveTarget('mihomo', 'Shadowrocket/1.0')).toBe('mihomo');
    expect(resolveTarget('', 'Shadowrocket/1.0')).toBe('shadowrocket');
    expect(resolveTarget('MIHOMO', null)).toBe('mihomo');
    expect(resolveTarget('bogus', null)).toBeNull();
  });
});
