// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Global admin gate (`middleware/admin.global.ts`).
 *
 * The Vue/Nuxt middleware only wires Nuxt globals to the decision, so the unit
 * under test is `resolveAdminGate` (core/utils/admin-gate.ts): `/login` is
 * public and never asks the server, every other path redirects to /login with
 * the full path in `?redirect=`, and an authenticated visitor is left alone.
 * All paths and query strings below are fixtures.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_LOGIN_PATH, isPublicPage, resolveAdminGate } from '../core/utils/admin-gate';

describe('resolveAdminGate', () => {
  it('lets /login through without any session check', () => {
    expect(resolveAdminGate({ path: '/login', fullPath: '/login' }, null)).toEqual({
      action: 'allow',
    });
    // Even with a query string / while unauthenticated: still the login page.
    expect(
      resolveAdminGate({ path: '/login', fullPath: '/login?redirect=/users' }, { authenticated: false }),
    ).toEqual({ action: 'allow' });
  });

  it('redirects anonymous visitors to /login with the full path as redirect', () => {
    expect(
      resolveAdminGate(
        { path: '/users', fullPath: '/users?page=2&q=alice' },
        { authenticated: false },
      ),
    ).toEqual({
      action: 'navigate',
      to: { path: ADMIN_LOGIN_PATH, query: { redirect: '/users?page=2&q=alice' } },
    });
    // A failed /api/admin/me (undefined state) counts as unauthenticated.
    expect(resolveAdminGate({ path: '/', fullPath: '/' }, undefined)).toEqual({
      action: 'navigate',
      to: { path: '/login', query: { redirect: '/' } },
    });
  });

  it('leaves an authenticated visitor on the page', () => {
    expect(
      resolveAdminGate({ path: '/sources/42', fullPath: '/sources/42' }, { authenticated: true }),
    ).toEqual({ action: 'allow' });
  });
});

describe('user center is public', () => {
  it('lets /my/<token> through without a session (the token is the credential)', () => {
    const token = 'a'.repeat(32);
    for (const path of ['/my', `/my/${token}`, `/my/${token}/`]) {
      expect(resolveAdminGate({ path, fullPath: path }, { authenticated: false }), path).toEqual({
        action: 'allow',
      });
      expect(isPublicPage(path), path).toBe(true);
    }
  });

  it('still sends anonymous visitors of admin pages to /login', () => {
    expect(isPublicPage('/users')).toBe(false);
    expect(isPublicPage('/my-settings')).toBe(false);
    expect(resolveAdminGate({ path: '/users', fullPath: '/users' }, null)).toEqual({
      action: 'navigate',
      to: { path: ADMIN_LOGIN_PATH, query: { redirect: '/users' } },
    });
  });
});
