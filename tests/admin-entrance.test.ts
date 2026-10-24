// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Secret admin entrance: path normalisation (`SUBHUB_ADMIN_PATH`) and request
 * classification.
 *
 * The pure helpers in `core/utils/admin-entrance.ts` are the unit under test;
 * the Nitro middleware only wires them to the h3 event. There is no Nitro
 * runtime, no server and no real secret below — every value is a fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_PATH_ENV,
  DEFAULT_ADMIN_PATH,
  GATE_PAGE_PATHS,
  adminEntrancePath,
  decideGate,
  gateScope,
  normalizeRequestPath,
  parseAdminPath,
} from '../core/utils/admin-entrance';

const ENV_KEYS = [ADMIN_PATH_ENV, 'NODE_ENV', 'SUBHUB_SECRET'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env[ADMIN_PATH_ENV];
  delete process.env.NODE_ENV;
  process.env.SUBHUB_SECRET = 'test-signing-secret';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('parseAdminPath', () => {
  it('falls back to "admin" when the variable is unset', () => {
    expect(parseAdminPath()).toEqual({ path: DEFAULT_ADMIN_PATH, invalid: false });
  });

  it('falls back to "admin" for an empty or blank value', () => {
    expect(parseAdminPath({ value: '' })).toEqual({ path: 'admin', invalid: false });
    expect(parseAdminPath({ value: '   ' })).toEqual({ path: 'admin', invalid: false });
    expect(parseAdminPath({ value: null })).toEqual({ path: 'admin', invalid: false });
    expect(parseAdminPath({ value: '///' })).toEqual({ path: 'admin', invalid: false });
  });

  it('keeps a simple custom path', () => {
    expect(parseAdminPath({ value: 'hx' })).toEqual({ path: 'hx', invalid: false });
    expect(parseAdminPath({ value: '/hx/' })).toEqual({ path: 'hx', invalid: false });
    expect(parseAdminPath({ value: '  hx  ' })).toEqual({ path: 'hx', invalid: false });
  });

  it('collapses repeated and whitespace-padded slashes', () => {
    expect(parseAdminPath({ value: 'hx//panel' })).toEqual({ path: 'hx/panel', invalid: false });
    expect(parseAdminPath({ value: '//hx///panel//' })).toEqual({ path: 'hx/panel', invalid: false });
    expect(parseAdminPath({ value: '/ hx / panel /' })).toEqual({ path: 'hx/panel', invalid: false });
  });

  it('keeps dashes and underscores inside a segment', () => {
    expect(parseAdminPath({ value: 'my-secret_panel' })).toEqual({
      path: 'my-secret_panel',
      invalid: false,
    });
    expect(parseAdminPath({ value: 'hx/2fa' })).toEqual({ path: 'hx/2fa', invalid: false });
  });

  it('rejects uppercase, dots, spaces and weird characters', () => {
    for (const value of ['Admin', 'HX/panel', 'hx panel', 'hx/pa.nel', '-hx', '_hx', 'hx@home', 'hx/中文', 'hx?a=1']) {
      expect(parseAdminPath({ value }).path).toBe('admin');
      expect(parseAdminPath({ value }).invalid).toBe(true);
    }
  });

  it('rejects reserved first segments that would shadow real routes', () => {
    for (const value of ['s', 'api', 'api/admin', '_nuxt', 's/mine']) {
      expect(parseAdminPath({ value })).toEqual({ path: 'admin', invalid: true });
    }
    // Only the FIRST segment is reserved.
    expect(parseAdminPath({ value: 'hx/s' })).toEqual({ path: 'hx/s', invalid: false });
    expect(parseAdminPath({ value: 'hx/api' })).toEqual({ path: 'hx/api', invalid: false });
  });

  it('warns exactly once for an invalid configured value, never for unset/valid', () => {
    const warn = vi.fn();
    parseAdminPath({ value: 'Bad Path', warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(ADMIN_PATH_ENV);

    const quiet = vi.fn();
    parseAdminPath({ value: '', warn: quiet });
    parseAdminPath({ value: 'hx', warn: quiet });
    parseAdminPath({ warn: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });

  it('reads SUBHUB_ADMIN_PATH from the environment', () => {
    process.env[ADMIN_PATH_ENV] = '/hx/panel/';
    expect(parseAdminPath().path).toBe('hx/panel');
    expect(adminEntrancePath()).toBe('/hx/panel');
    process.env[ADMIN_PATH_ENV] = 'api';
    expect(parseAdminPath({ warn: () => {} })).toEqual({ path: 'admin', invalid: true });
  });

  it('builds the entrance with a leading slash', () => {
    expect(adminEntrancePath(parseAdminPath({ value: 'hx' }))).toBe('/hx');
    expect(adminEntrancePath(parseAdminPath({ value: '' }))).toBe('/admin');
  });
});

describe('normalizeRequestPath', () => {
  it('drops the query string, trailing slashes and case', () => {
    expect(normalizeRequestPath('/login?redirect=/users')).toBe('/login');
    expect(normalizeRequestPath('/Users/')).toBe('/users');
    expect(normalizeRequestPath('/')).toBe('/');
    expect(normalizeRequestPath('')).toBe('/');
    expect(normalizeRequestPath('//hx//panel')).toBe('/hx/panel');
  });

  it('decodes percent escapes but survives malformed ones', () => {
    expect(normalizeRequestPath('/hx%2Fpanel')).toBe('/hx/panel');
    expect(normalizeRequestPath('/%2e%2e/login')).toBe('/../login');
    expect(normalizeRequestPath('/%E0%A4%A')).toBe('/%e0%a4%a');
  });
});

describe('gateScope', () => {
  const entrance = '/admin';

  it('recognises the entrance exactly, without trailing segments', () => {
    expect(gateScope('/admin', entrance)).toEqual({ kind: 'knock' });
    expect(gateScope('/admin?x=1', entrance)).toEqual({ kind: 'knock' });
    expect(gateScope('/admin/', entrance)).toEqual({ kind: 'knock' });
    expect(gateScope('/ADMIN', entrance)).toEqual({ kind: 'knock' });
    expect(gateScope('/admin/users', entrance)).toEqual({ kind: 'admin-page' });
    expect(gateScope('/administrator', entrance)).toEqual({ kind: 'admin-page' });
  });

  it('matches a multi-segment entrance', () => {
    expect(gateScope('/hx/panel', '/hx/panel')).toEqual({ kind: 'knock' });
    expect(gateScope('/hx/panel/', '/hx/panel')).toEqual({ kind: 'knock' });
    expect(gateScope('/hx', '/hx/panel')).toEqual({ kind: 'admin-page' });
  });

  it('treats every admin page and the root as admin surface', () => {
    for (const path of GATE_PAGE_PATHS) {
      expect(gateScope(path, entrance)).toEqual({ kind: 'admin-page' });
    }
    // Unknown top-level pages are gated too (no shell leaks before login).
    expect(gateScope('/future-page', entrance)).toEqual({ kind: 'admin-page' });
  });

  it('gates /api/admin/* only', () => {
    expect(gateScope('/api/admin/stats', entrance)).toEqual({ kind: 'admin-api' });
    expect(gateScope('/api/admin/users', entrance)).toEqual({ kind: 'admin-api' });
    expect(gateScope('/api/tasks/refresh-sources', entrance)).toEqual({ kind: 'public' });
    expect(gateScope('/api', entrance)).toEqual({ kind: 'public' });
  });

  it('leaves the login/logout endpoints reachable without the gate cookie', () => {
    // A browser that just knocked is sent to /login, whose form posts here.
    expect(gateScope('/api/admin/login', entrance)).toEqual({ kind: 'public' });
    expect(gateScope('/api/admin/logout', entrance)).toEqual({ kind: 'public' });
    expect(gateScope('/api/admin/login/', entrance)).toEqual({ kind: 'public' });
    // Look-alikes are still gated.
    expect(gateScope('/api/admin/login/extra', entrance)).toEqual({ kind: 'admin-api' });
    expect(gateScope('/api/admin/loginx', entrance)).toEqual({ kind: 'admin-api' });
  });

  it('never gates subscription exports', () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(gateScope(`/s/${token}`, entrance)).toEqual({ kind: 'public' });
    expect(gateScope(`/s/${token}/clash`, entrance)).toEqual({ kind: 'public' });
    expect(gateScope('/s', entrance)).toEqual({ kind: 'public' });
  });

  it('classifies /_nuxt as assets', () => {
    expect(gateScope('/_nuxt/entry.js', entrance)).toEqual({ kind: 'assets' });
  });
});

describe('decideGate', () => {
  const base = { entrance: '/admin' };

  it('blanks admin pages without the cookie (never redirects)', () => {
    expect(decideGate({ ...base, path: '/', hasGateCookie: false })).toEqual({ action: 'blank' });
    expect(decideGate({ ...base, path: '/login', hasGateCookie: false })).toEqual({ action: 'blank' });
    expect(decideGate({ ...base, path: '/api/admin/stats', hasGateCookie: false })).toEqual({
      action: 'blank',
    });
  });

  it('allows the login endpoint without the cookie (it is the tail of the knock)', () => {
    expect(decideGate({ ...base, path: '/api/admin/login', hasGateCookie: false })).toEqual({
      action: 'allow',
      reason: 'not-admin-surface',
    });
  });

  it('knocks with the issued cookie and the login redirect', () => {
    expect(decideGate({ ...base, path: '/admin', hasGateCookie: false }, 'cookie-value')).toEqual({
      action: 'knock',
      cookie: 'cookie-value',
      redirect: '/login',
    });
  });

  it('allows surface and assets with a valid gate cookie', () => {
    expect(decideGate({ ...base, path: '/login', hasGateCookie: true })).toEqual({
      action: 'allow',
      reason: 'has-gate-cookie',
    });
    expect(decideGate({ ...base, path: '/_nuxt/entry.js', hasGateCookie: true })).toEqual({
      action: 'allow',
      reason: 'asset',
    });
  });

  it('allows public routes with or without the cookie', () => {
    expect(decideGate({ ...base, path: '/s/abc/clash', hasGateCookie: false })).toEqual({
      action: 'allow',
      reason: 'not-admin-surface',
    });
    expect(decideGate({ ...base, path: '/api/tasks/refresh-sources', hasGateCookie: false })).toEqual({
      action: 'allow',
      reason: 'not-admin-surface',
    });
  });

  it('serves nothing for assets without the cookie', () => {
    expect(decideGate({ ...base, path: '/_nuxt/entry.js', hasGateCookie: false })).toEqual({
      action: 'not-found',
    });
  });
});
