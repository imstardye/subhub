// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from '../core/utils';

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
