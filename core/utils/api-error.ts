// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Helpers for the admin pages' `$fetch` calls.
 *
 * Every admin page shows a Chinese error banner when a request fails, and the
 * server answers failures with `{ error: '<message>' }`. Reading that field is
 * the only reliable way to tell the admin *why* a request failed, so it lives
 * here instead of being duplicated (and subtly mis-implemented) per page.
 */

/**
 * Extract a display message from anything thrown by `$fetch`.
 *
 * Handles the shapes that actually occur:
 * - `FetchError` with a JSON body: `{ data: { error } }`
 * - a non-JSON error body: `data` is a string, `message` is the status line
 * - a plain `Error` thrown before any request is made
 * - a non-error value (string, object, undefined)
 */
export function apiErrorMessage(err: unknown): string {
  const serverMessage =
    err && typeof err === 'object'
      ? (err as { data?: { error?: unknown } }).data?.error
      : undefined;
  if (typeof serverMessage === 'string' && serverMessage.trim()) return serverMessage;

  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof err === 'string' && err.trim()) return err;
  return '请求失败，请稍后再试';
}
