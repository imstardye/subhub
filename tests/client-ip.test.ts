// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client IP resolution (SUBHUB_TRUSTED_IP_HEADER) and its use by the login
 * throttle and the subscription export handler.
 *
 * All addresses are RFC 5737 documentation ranges; no real clients involved.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import adminLoginHandler from '../server/api/admin/login.post';
import {
  getClientIp,
  getClientIpOrNull,
  MAX_CLIENT_IP_LENGTH,
  normalizeClientIp,
  TRUSTED_IP_HEADER_ENV,
  trustedIpHeader,
} from '../server/utils/client-ip';
import { requestFromEvent } from '../server/utils/export-handler';
import { createLoginThrottle, LOGIN_MAX_FAILURES_PER_IP } from '../server/utils/login-throttle';

const PASSWORD = 'correct-horse-battery';
const ENV_KEYS = ['SUBHUB_ADMIN_PASSWORD', 'SUBHUB_SECRET', 'NODE_ENV', TRUSTED_IP_HEADER_ENV] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBHUB_ADMIN_PASSWORD = PASSWORD;
  process.env.SUBHUB_SECRET = 'test-signing-secret';
  delete process.env.NODE_ENV;
  delete process.env[TRUSTED_IP_HEADER_ENV];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function eventWith(
  headers: Record<string, string | string[] | undefined> = {},
  remoteAddress?: string,
) {
  return {
    node: {
      req: {
        headers,
        socket: remoteAddress ? { remoteAddress } : undefined,
      },
    },
  };
}

describe('normalizeClientIp', () => {
  it('accepts IPv4 and IPv6, trims and takes the first list value', () => {
    expect(normalizeClientIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeClientIp('203.0.113.7, 198.51.100.1')).toBe('203.0.113.7');
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeClientIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
    expect(normalizeClientIp('2001:db8::1%eth0')).toBe('2001:db8::1%eth0');
  });

  it('rejects empty, non-string, oversized, malformed and injected values', () => {
    expect(normalizeClientIp(undefined)).toBe('');
    expect(normalizeClientIp(null)).toBe('');
    expect(normalizeClientIp(42)).toBe('');
    expect(normalizeClientIp('')).toBe('');
    expect(normalizeClientIp('   ')).toBe('');
    expect(normalizeClientIp('1'.repeat(MAX_CLIENT_IP_LENGTH + 1))).toBe('');
    expect(normalizeClientIp('999.0.113.7')).toBe('');
    expect(normalizeClientIp('not-an-ip')).toBe('');
    expect(normalizeClientIp('203.0.113.7\r\nx-evil: 1')).toBe('');
    expect(normalizeClientIp('203.0.113.7 x')).toBe('');
  });
});

describe('trustedIpHeader', () => {
  it('is disabled unless the env var names a header', () => {
    expect(trustedIpHeader({})).toBeNull();
    expect(trustedIpHeader({ [TRUSTED_IP_HEADER_ENV]: '' })).toBeNull();
    expect(trustedIpHeader({ [TRUSTED_IP_HEADER_ENV]: '   ' })).toBeNull();
    expect(trustedIpHeader({ [TRUSTED_IP_HEADER_ENV]: ' CF-Connecting-IP ' })).toBe(
      'cf-connecting-ip',
    );
  });
});

describe('getClientIp', () => {
  it('uses only the socket when no header is configured', () => {
    const event = eventWith(
      { 'x-forwarded-for': '198.51.100.1', 'cf-connecting-ip': '198.51.100.2' },
      '203.0.113.7',
    );
    expect(getClientIp(event, {})).toBe('203.0.113.7');
  });

  it('ignores the socket peer when the configured header is valid', () => {
    const event = eventWith({ 'cf-connecting-ip': ' 198.51.100.2 ' }, '203.0.113.7');
    expect(getClientIp(event, { [TRUSTED_IP_HEADER_ENV]: 'cf-connecting-ip' })).toBe(
      '198.51.100.2',
    );
  });

  it('takes the first value and trims it', () => {
    const event = eventWith({ 'cf-connecting-ip': [' 198.51.100.2 ', '203.0.113.9'] });
    expect(getClientIp(event, { [TRUSTED_IP_HEADER_ENV]: 'cf-connecting-ip' })).toBe(
      '198.51.100.2',
    );
  });

  it('falls back to the socket when the header is missing or invalid', () => {
    const env = { [TRUSTED_IP_HEADER_ENV]: 'cf-connecting-ip' };
    expect(getClientIp(eventWith({}, '203.0.113.7'), env)).toBe('203.0.113.7');
    expect(getClientIp(eventWith({ 'cf-connecting-ip': '' }, '203.0.113.7'), env)).toBe(
      '203.0.113.7',
    );
    expect(
      getClientIp(eventWith({ 'cf-connecting-ip': 'not-an-ip' }, '203.0.113.7'), env),
    ).toBe('203.0.113.7');
    expect(getClientIp(eventWith({ 'cf-connecting-ip': '203.0.113.7\r\nx: 1' }), env)).toBe('');
  });

  it('does not read Nitro context.clientAddress (only socket/header count)', () => {
    const event = { ...eventWith({}, '203.0.113.7'), context: { clientAddress: '198.51.100.9' } };
    expect(getClientIp(event, {})).toBe('203.0.113.7');
  });

  it('returns null via getClientIpOrNull when nothing is available', () => {
    expect(getClientIpOrNull(eventWith(), {})).toBeNull();
    expect(getClientIpOrNull(eventWith({}, '203.0.113.7'), {})).toBe('203.0.113.7');
  });
});

describe('login throttle uses the shared client IP', () => {
  function loginEvent(headers: Record<string, string> = {}, remoteAddress?: string) {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/api/admin/login',
      headers: { 'content-type': 'application/json', ...headers },
      socket: remoteAddress ? { remoteAddress } : undefined,
    });
    const event = {
      node: {
        req,
        res: {
          statusCode: 200,
          setHeader() {
            /* headers are not asserted here */
          },
        },
      },
    };
    const payload = JSON.stringify({ password: 'wrong-password' });
    setImmediate(() => {
      req.emit('data', Buffer.from(payload));
      req.emit('end');
    });
    return event;
  }

  it('keys per-IP failures by the configured header', async () => {
    process.env[TRUSTED_IP_HEADER_ENV] = 'cf-connecting-ip';
    const throttle = createLoginThrottle();
    // Same socket (the proxy), different real clients: each gets its own budget.
    for (const ip of ['198.51.100.1', '198.51.100.2']) {
      for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
        const event = loginEvent({ 'cf-connecting-ip': ip }, '10.0.0.1');
        await adminLoginHandler(event as never, { throttle });
        expect(event.node.res.statusCode).toBe(401);
      }
    }
    expect(throttle.size()).toBe(3); // two IP buckets + the global bucket

    const blocked = loginEvent({ 'cf-connecting-ip': '198.51.100.1' }, '10.0.0.1');
    await adminLoginHandler(blocked as never, { throttle });
    expect(blocked.node.res.statusCode).toBe(429);
  });

  it('ignores the header when the switch is off (all clients share the socket IP)', async () => {
    const throttle = createLoginThrottle();
    for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i += 1) {
      const event = loginEvent({ 'cf-connecting-ip': `198.51.100.${i + 1}` }, '10.0.0.1');
      await adminLoginHandler(event as never, { throttle });
      expect(event.node.res.statusCode).toBe(401);
    }
    const blocked = loginEvent({ 'cf-connecting-ip': '198.51.100.99' }, '10.0.0.1');
    await adminLoginHandler(blocked as never, { throttle });
    expect(blocked.node.res.statusCode).toBe(429);
    expect(throttle.size()).toBe(2); // socket bucket + global
  });
});

describe('subscription export uses the shared client IP', () => {
  function exportEvent(headers: Record<string, string> = {}, remoteAddress?: string) {
    return {
      path: '/s/fixture-token',
      context: {},
      node: {
        req: { headers, socket: remoteAddress ? { remoteAddress } : undefined },
        res: { statusCode: 200, setHeader() {} },
      },
    };
  }

  it('logs the socket peer by default', () => {
    const request = requestFromEvent(
      exportEvent({ 'cf-connecting-ip': '198.51.100.2' }, '203.0.113.7') as never,
    );
    expect(request.ip).toBe('203.0.113.7');
  });

  it('logs the trusted header when enabled and null when nothing is known', () => {
    process.env[TRUSTED_IP_HEADER_ENV] = 'cf-connecting-ip';
    const request = requestFromEvent(
      exportEvent({ 'cf-connecting-ip': '198.51.100.2' }, '203.0.113.7') as never,
    );
    expect(request.ip).toBe('198.51.100.2');

    const unknown = requestFromEvent(exportEvent() as never);
    expect(unknown.ip).toBeNull();
  });
});
