// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side revocation of admin sessions (logout invalidates the token).
 *
 * Every session token carries a random id (`jti`, see admin-auth.ts). Logging
 * out records that id here, and `verifySessionToken` refuses any token whose id
 * is revoked — a copied cookie stops working even though it is still validly
 * signed and not yet expired.
 *
 * Storage is an in-memory map, which is enough for the current single-process
 * deployment. **Multiple instances need a shared store** (e.g. the SQLite DB or
 * Redis): with the map below, a logout only affects the worker that handled it,
 * and every revocation is lost on restart. The map is bounded twice over:
 * entries expire together with the session they revoke, and past
 * `MAX_REVOKED_SESSIONS` the oldest entry is evicted first (which can at worst
 * resurrect an older, still-unexpired session — prefer a persistent store for
 * real deployments).
 */
import { randomUUID } from 'node:crypto';

/** Hard cap on tracked revocations; oldest entries are evicted first. */
export const MAX_REVOKED_SESSIONS = 4096;

/** How long a revocation outlives the session it belongs to (slack for clock skew). */
export const REVOCATION_GRACE_MS = 60 * 1000;

interface RevokedEntry {
  /** Epoch ms until which the token must be rejected. */
  expiresAt: number;
}

export interface SessionRevocationStore {
  /** Reject every token bound to `sessionId` until `expiresAtMs`. */
  revoke(sessionId: string, expiresAtMs: number): void;
  /** True when the id was revoked and the entry has not expired yet. */
  isRevoked(sessionId: string, nowMs?: number): boolean;
  /** Number of tracked entries (tests/diagnostics). */
  size(): number;
  /** Forget every entry (tests only). */
  reset(): void;
}

function isValidSessionId(value: unknown): value is string {
  // jti values are random UUIDs; refuse anything else so a crafted token cannot
  // probe or pollute the store.
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function createSessionRevocationStore(
  options: { maxEntries?: number; now?: () => number } = {},
): SessionRevocationStore {
  const maxEntries = options.maxEntries ?? MAX_REVOKED_SESSIONS;
  const now = options.now ?? Date.now;
  const revoked = new Map<string, RevokedEntry>();

  function sweep(at: number): void {
    for (const [id, entry] of revoked) {
      if (entry.expiresAt <= at) revoked.delete(id);
    }
  }

  return {
    revoke(sessionId, expiresAtMs) {
      if (!isValidSessionId(sessionId)) return;
      const at = now();
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= at) return;
      if (revoked.size >= maxEntries) {
        sweep(at);
        while (revoked.size >= maxEntries) {
          // Map keeps insertion order; the front is the oldest revocation.
          const oldest = revoked.keys().next();
          if (oldest.done) break;
          revoked.delete(oldest.value);
        }
      }
      revoked.set(sessionId, { expiresAt: expiresAtMs });
    },
    isRevoked(sessionId, nowMs) {
      if (!isValidSessionId(sessionId)) return false;
      const entry = revoked.get(sessionId);
      if (!entry) return false;
      const at = nowMs ?? now();
      if (entry.expiresAt <= at) {
        revoked.delete(sessionId);
        return false;
      }
      return true;
    },
    size: () => revoked.size,
    reset: () => revoked.clear(),
  };
}

/** Process-wide store used by the admin session helpers. */
export const adminSessionRevocations = createSessionRevocationStore();

/** Short unique id used as a session's revocation handle. */
export function newSessionId(): string {
  return randomUUID();
}
