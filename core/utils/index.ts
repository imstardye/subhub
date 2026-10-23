/**
 * Small pure-TS helpers shared by the parsers.
 *
 * The URI parsing approach is adapted from Sub-Store
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

const BASE64_ALPHABET = /^[A-Za-z0-9+/_=-]+$/;

export function normalizeBase64(input: string): string {
  const compact = input.replace(/\s+/g, '');
  return compact.replace(/-/g, '+').replace(/_/g, '/');
}

export function decodeBase64(input: string): string {
  const normalized = normalizeBase64(input);
  if (!normalized) return '';

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(normalized, 'base64').toString('utf8');
  }

  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeBase64(input: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(input, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function tryDecodeBase64(input: string): string | undefined {
  const normalized = normalizeBase64(input);
  if (!normalized || !BASE64_ALPHABET.test(normalized)) return undefined;
  // A base64 string of one or two chars is almost certainly not a payload.
  if (normalized.length < 8) return undefined;
  try {
    const decoded = decodeBase64(normalized);
    return decoded.includes('\uFFFD') ? undefined : decoded;
  } catch {
    return undefined;
  }
}

export function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function splitFragment(raw: string): {
  content: string;
  fragment?: string;
} {
  const hashIndex = raw.indexOf('#');
  if (hashIndex === -1) return { content: raw };
  return {
    content: raw.slice(0, hashIndex),
    fragment: decodeComponent(raw.slice(hashIndex + 1)),
  };
}

export function parseQuery(query: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!query) return result;

  const cleaned = query.replace(/^\?/, '');
  if (!cleaned) return result;

  for (const pair of cleaned.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    result[decodeComponent(key)] = decodeComponent(value);
  }
  return result;
}

/** Split `host:port` while supporting bracketed IPv6 addresses. */
export function parseHostPort(value: string): { host: string; port?: number } {
  const trimmed = value.trim().replace(/\/$/, '');
  if (!trimmed) return { host: '' };

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end !== -1) {
      const host = trimmed.slice(0, end + 1);
      const rest = trimmed.slice(end + 1).replace(/^:/, '');
      const port = rest ? Number.parseInt(rest, 10) : undefined;
      return { host, port: Number.isFinite(port) ? port : undefined };
    }
  }

  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon === -1) return { host: trimmed };
  const port = Number.parseInt(trimmed.slice(lastColon + 1), 10);
  if (!Number.isFinite(port)) return { host: trimmed };
  return { host: trimmed.slice(0, lastColon), port };
}

export function parsePort(value: string | number | undefined, fallback = 443): number {
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(`${value ?? ''}`, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function isFalsyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value === 0;
  if (typeof value !== 'string') return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null) output[key] = entry;
  }
  return output as T;
}

export function parseAlpn(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

export function normalizeVmessSecurity(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'auto';
  if (['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305'].includes(raw)) {
    return raw;
  }
  return 'auto';
}

export function toKebabCase(key: string): string {
  return key.replace(/_/g, '-');
}

export function withoutKeys<T extends Record<string, unknown>>(
  value: T,
  keys: string[],
): T {
  const output = { ...value };
  for (const key of keys) delete output[key];
  return output;
}

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizeLoopbackName(
  name: string | undefined,
  fallback: string,
): string {
  return name && name.trim() ? name.trim() : fallback;
}
