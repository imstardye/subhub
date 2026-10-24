// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '../server/utils/safe-redirect';

describe('safeRedirectPath', () => {
  it.each(['/', '/admin', '/admin?tab=sources', '/s/token?x=1'])(
    'keeps local path %j',
    (value) => expect(safeRedirectPath(value)).toBe(value),
  );

  it.each([
    undefined,
    null,
    42,
    '',
    'admin',
    'https://evil.example/',
    '//evil.example/',
    '///evil.example/',
    '/\\evil.example',
    '\\\\evil.example',
    '/foo\\bar',
    '/\t/evil.example',
    '/foo\nbar',
    '/\u0000evil',
  ])('falls back to / for %j', (value) => expect(safeRedirectPath(value)).toBe('/'));

  it('takes the first value of a repeated query parameter', () => {
    expect(safeRedirectPath(['/admin', '/other'])).toBe('/admin');
    expect(safeRedirectPath(['//evil.example', '/admin'])).toBe('/');
  });
});
