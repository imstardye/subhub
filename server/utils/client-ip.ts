// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Single source of truth for the client IP used as a rate-limit bucket key and
 * for access logs (login throttling, subscription export, ...).
 *
 * Default: only the TCP peer (`socket.remoteAddress`) is used. Forwarding
 * headers are ignored, so a client cannot pick its own bucket key.
 *
 * When `SUBHUB_TRUSTED_IP_HEADER` is set (e.g. `cf-connecting-ip`), that request
 * header is read instead: the first value is taken, trimmed and validated. A
 * missing/array-shaped/garbage value falls back to the socket peer.
 *
 * Security: the header is client-controlled unless the origin only accepts
 * connections from the proxy (Cloudflare IP ranges) and the app port is not
 * reachable directly. Only enable it under those conditions — otherwise anyone
 * can bypass per-IP limits by sending arbitrary header values.
 *
 * The header name is read from the process environment on every call (not
 * cached) so tests and short-lived workers always see the current setting.
 */

/** Env var naming the trusted forwarding header; unset disables it. */
export const TRUSTED_IP_HEADER_ENV = 'SUBHUB_TRUSTED_IP_HEADER';

/** Longest accepted address; anything longer is treated as invalid input. */
export const MAX_CLIENT_IP_LENGTH = 64;

/** Minimal event shape; Nitro events and the test doubles both satisfy it. */
export interface ClientIpEvent {
  node: {
    req: {
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string | null } | null;
    };
  };
  /** Nitro's address (honours its own `trustProxy` config; unused by default). */
  context?: { clientAddress?: string };
}

/** Accept IPv4, IPv6 (incl. zone ids and brackets), or a short hostname. */
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_CHARS = /^[0-9a-f:.%[\]a-z-]+$/i;

/** Normalise one candidate address; returns `''` when it is not usable. */
export function normalizeClientIp(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_IP_LENGTH) return '';
  // A header may itself carry a list; the first hop is the client.
  const first = trimmed.split(',')[0]!.trim();
  if (!first || first.length > MAX_CLIENT_IP_LENGTH) return '';
  // Reject anything with control characters or whitespace (header smuggling).
  if (/[\s\u0000-\u001f\u007f]/.test(first)) return '';
  const unbracketed = first.startsWith('[') && first.endsWith(']') ? first.slice(1, -1) : first;
  if (IPV4.test(unbracketed)) {
    return unbracketed.split('.').every((part) => Number(part) <= 255) ? unbracketed : '';
  }
  if (unbracketed.includes(':') && IPV6_CHARS.test(unbracketed)) return unbracketed;
  // Non-address hostnames are tolerated only for the socket peer, never for a
  // header value, so a header cannot inject arbitrary bucket keys.
  return '';
}

/** Header name from `SUBHUB_TRUSTED_IP_HEADER`, or `null` when disabled. */
export function trustedIpHeader(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[TRUSTED_IP_HEADER_ENV];
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return name === '' ? null : name;
}

/** The socket peer as-is (opaque bucket key); `''` when unavailable. */
function socketAddress(event: ClientIpEvent): string {
  const remote = event.node?.req?.socket?.remoteAddress;
  if (typeof remote !== 'string' || remote.trim() === '') return '';
  return remote.trim().slice(0, MAX_CLIENT_IP_LENGTH);
}

/**
 * Client IP for rate limiting/logging: the trusted header when configured and
 * valid, else the socket peer. Returns `''` when no address is available.
 */
export function getClientIp(
  event: ClientIpEvent,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const header = trustedIpHeader(env);
  if (header) {
    const raw = event.node?.req?.headers?.[header];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const fromHeader = normalizeClientIp(value);
    if (fromHeader) return fromHeader;
  }
  return socketAddress(event);
}

/** Like `getClientIp`, but `null` when unknown (access-log friendly). */
export function getClientIpOrNull(
  event: ClientIpEvent,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return getClientIp(event, env) || null;
}
