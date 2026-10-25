// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Payload codec for the user-center session cookie — pure, no crypto.
 *
 * The signed token is `v1.<userId>.<passwordVersion>.<expiresAtSeconds>.<hmac>`
 * (see `server/utils/user-session.ts`). This module owns the unsigned payload
 * format only, so encoding/decoding and the strict integer checks are unit
 * tested without a clock, a secret or a database.
 *
 * Binding rules:
 * - the cookie is tied to the **user id**, not the subscription token, so
 *   rotating a token never logs the user out;
 * - `passwordVersion` must match the user's current version. Setting,
 *   changing or resetting a password bumps it, which invalidates every older
 *   cookie at once.
 */

export const USER_SESSION_PAYLOAD_VERSION = 'v1';

export interface UserSessionPayload {
  userId: number;
  passwordVersion: number;
  expiresAtMs: number;
}

/** Unsigned form: `v1.<userId>.<passwordVersion>.<expiresAtSeconds>`. */
export function encodeUserSessionPayload(payload: {
  userId: number;
  passwordVersion: number;
  expiresAtSeconds: number;
}): string {
  return [
    USER_SESSION_PAYLOAD_VERSION,
    payload.userId,
    payload.passwordVersion,
    payload.expiresAtSeconds,
  ].join('.');
}

/** Decode the unsigned payload; `null` for anything malformed or out of range. */
export function decodeUserSessionPayload(payload: string): {
  userId: number;
  passwordVersion: number;
  expiresAtSeconds: number;
} | null {
  const parts = payload.split('.');
  if (parts.length !== 4) return null;
  const [version, userIdRaw, passwordVersionRaw, expiresRaw] = parts;
  if (version !== USER_SESSION_PAYLOAD_VERSION) return null;
  if (!/^\d+$/.test(userIdRaw!) || !/^\d+$/.test(passwordVersionRaw!) || !/^\d+$/.test(expiresRaw!)) {
    return null;
  }
  const userId = Number(userIdRaw);
  const passwordVersion = Number(passwordVersionRaw);
  const expiresAtSeconds = Number(expiresRaw);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!Number.isSafeInteger(passwordVersion) || passwordVersion < 0) return null;
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= 0) return null;
  return { userId, passwordVersion, expiresAtSeconds };
}

/** True when the session belongs to this user at the user's current version. */
export function userSessionMatches(
  payload: { userId: number; passwordVersion: number } | null | undefined,
  user: { id: number; passwordVersion?: number | null; passwordHash?: string | null },
): boolean {
  if (!payload) return false;
  if (payload.userId !== user.id) return false;
  // No password = no valid session can exist (setup is the only way in).
  if (!user.passwordHash) return false;
  return payload.passwordVersion === (user.passwordVersion ?? 0);
}
