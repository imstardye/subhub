// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Password policy for the user center (`/my/<token>`) — pure, no crypto.
 *
 * Deliberately simple: 6–64 characters, no composition rules. The same check
 * runs on the client (instant feedback) and in every server write path
 * (`server/utils/admin-users.ts`, `server/utils/user-center.ts`), so the UI can
 * never drift from what the API accepts.
 *
 * Passwords are used verbatim: no trimming, because spaces are legitimate
 * characters and silently changing them would make a password unrecoverable.
 */

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 64;

export type PasswordCheck =
  | { ok: true; password: string }
  | { ok: false; error: string };

/** Validate a submitted password against the policy. */
export function validatePassword(raw: unknown): PasswordCheck {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: '请填写密码' };
  }
  if (raw.length < PASSWORD_MIN_LENGTH || raw.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      error: `密码长度需在 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符之间`,
    };
  }
  return { ok: true, password: raw };
}

/** Confirmation-field check for the setup/change forms. */
export function confirmPasswordError(password: string, confirmation: string): string | null {
  if (password !== confirmation) return '两次输入的密码不一致';
  return null;
}
