// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client-side validation for the 自定义令牌 input (`pages/users.vue`).
 *
 * Mirrors the server rule in `server/utils/admin-validation.ts`
 * (`parseCustomToken`: 8–64 chars, /^[a-z0-9][a-z0-9_-]*$/i) so an obviously
 * invalid value is reported without a round trip. The server stays the
 * authority — uniqueness (409) can only be judged there, and the page shows
 * whatever the API answers.
 */

export const CUSTOM_TOKEN_MIN_LENGTH_UI = 8;
export const CUSTOM_TOKEN_MAX_LENGTH_UI = 64;

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export type CustomTokenResult = { ok: true; token: string } | { ok: false; error: string };

export function validateCustomToken(raw: unknown): CustomTokenResult {
  if (typeof raw !== 'string') return { ok: false, error: '请填写令牌' };
  const token = raw.trim();
  if (!token) return { ok: false, error: '请填写令牌' };
  if (token.length < CUSTOM_TOKEN_MIN_LENGTH_UI || token.length > CUSTOM_TOKEN_MAX_LENGTH_UI) {
    return {
      ok: false,
      error: `令牌长度需在 ${CUSTOM_TOKEN_MIN_LENGTH_UI}–${CUSTOM_TOKEN_MAX_LENGTH_UI} 个字符之间`,
    };
  }
  if (!TOKEN_PATTERN.test(token)) {
    return { ok: false, error: '令牌只能包含字母、数字、- 和 _，且不能以 - 或 _ 开头' };
  }
  return { ok: true, token };
}
