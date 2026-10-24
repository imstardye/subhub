// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, parseHostPort } from '../core/utils';

describe('host and port parsing', () => {
  it.each([
    ['[2001:db8::1]:443', { host: '2001:db8::1', port: 443 }],
    ['[2001:db8::1]', { host: '2001:db8::1', port: undefined }],
    [' [2001:db8::1]:8388/ ', { host: '2001:db8::1', port: 8388 }],
    ['example.com:443', { host: 'example.com', port: 443 }],
    ['example.com', { host: 'example.com' }],
    ['192.0.2.1:8388', { host: '192.0.2.1', port: 8388 }],
  ])('parses %s without IPv6 brackets', (input, expected) => {
    expect(parseHostPort(input)).toEqual(expected);
  });
});

describe.each(['Buffer', 'atob'])('base64 decoding with %s', (decoder) => {
  beforeEach(() => {
    if (decoder === 'atob') vi.stubGlobal('Buffer', undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['', ''],
    ['YSBi', 'a b'],
    ['YyBk', 'c d'],
    ['YQ', 'a'],
    ['YQ==', 'a'],
    ['YWI', 'ab'],
    ['YWI=', 'ab'],
    ['8J-YgCDwn5i_IGE', '😀 😿 a'],
    ['8J-YgCDwn5i_IGE=', '😀 😿 a'],
    ['8J+YgCDwn5i/IGE=', '😀 😿 a'],
  ])('decodes %j as %j', (encoded, decoded) => {
    expect(decodeBase64(encoded)).toBe(decoded);
  });

  it.each(['!!!', 'YQ!!', 'A', 'AAAAA', '=YQ=', 'Y=Q=', 'YQ==AAAA', 'YQ===', 'YWI=='])(
    'rejects malformed base64: %s',
    (encoded) => {
      expect(() => decodeBase64(encoded)).toThrow();
    },
  );
});
