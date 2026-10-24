// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Redirect target validation for the admin login page.
 *
 * Only same-origin absolute paths are followed. Anything a browser may
 * interpret as another origin is rejected: protocol-relative URLs (`//host`),
 * backslash variants (`/\host`, which some browsers normalise to `//host`) and
 * control characters (tab/newline smuggling). Invalid values fall back to `/`.
 *
 * Plain function (no Nuxt auto-imports) so it is unit-testable and usable from
 * `pages/login.vue`.
 */
const FALLBACK = '/';

// Control characters (incl. TAB, CR, LF, DEL) are never legitimate in a path.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeRedirectPath(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw === '') return FALLBACK;
  if (CONTROL_CHARS.test(raw)) return FALLBACK;
  if (raw.includes('\\')) return FALLBACK;
  if (!raw.startsWith('/') || raw.startsWith('//')) return FALLBACK;
  return raw;
}
