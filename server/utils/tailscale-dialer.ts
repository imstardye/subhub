// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user Tailscale `dialer-proxy` choice.
 *
 * The stored value is the NAME of one of the user's own policy groups (from
 * the rule profile assigned to them) that the Tailscale outbound's control
 * connection is dialled through; NULL means a direct connection. It is not a
 * secret — unlike the auth key it is read back in /my and in the admin DTO —
 * but it is only ever chosen from a server-derived allowlist:
 *
 * - the allowed set is derived from the user's CURRENT assigned profile (the
 *   `custom_proxy_group=` names of its INI), minus the reserved Tailscale
 *   names (`TAILSCALE_PROXY_NAME` / `TAILSCALE_GROUP_NAME`), minus `relay`
 *   groups (a relay is not a dialer);
 * - a write is validated against that set: an unknown name is a 400, never
 *   silently stored;
 * - the export only emits the field when the name survives that render's group
 *   pruning (`resolveTailscaleDialerProxy` in `core/tailscale.ts`) — an export
 *   must never reference a group that is not in the file.
 *
 * The profile can be a remote URL; the /my read path therefore never fetches
 * it. `loadTailscaleDialerGroups` only uses the inline INI, and a URL-only
 * profile yields an empty set (直连 only). The write path may fetch (the export
 * would need it anyway) so a user can still set the dialer of a URL profile.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { profiles, users, type User } from '../db/schema';
import { TAILSCALE_RESERVED_NAMES, parseIni } from '../../core';
import { ValidationError } from './admin-validation';
import { fetchProfileIni, type ProfileIniResolver } from './export-nodes';

/** Hard cap on a stored group name (matches the JSON column discipline). */
export const TAILSCALE_DIALER_MAX_LENGTH = 128;

/** What the /my Tailscale panel and its select need. */
export interface TailscaleDialerState {
  /** The stored group name, or null for a direct connection. */
  dialerProxy: string | null;
  /** Selectable group names, ascending by declaration order (may be empty). */
  options: string[];
}

/** The stored choice, trimmed; blank/NULL reads as direct. */
export function readUserTailscaleDialerProxy(
  user: Pick<User, 'tailscaleDialerProxy'>,
): string | null {
  const stored = user.tailscaleDialerProxy;
  if (typeof stored !== 'string') return null;
  const trimmed = stored.trim();
  return trimmed || null;
}

/**
 * Group names a user may pick as their Tailscale dialer, in INI declaration
 * order (a repeated name is one group, first position wins). Reserved Tailscale
 * names and `relay` groups are excluded; a profile-less user gets `[]`.
 */
export function tailscaleDialerGroupsFromIni(iniText: string | null | undefined): string[] {
  if (typeof iniText !== 'string' || !iniText.trim()) return [];
  const seen = new Set<string>();
  const options: string[] = [];
  for (const group of parseIni(iniText).groups) {
    const name = group.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (TAILSCALE_RESERVED_NAMES.includes(name)) continue;
    if (group.type === 'relay') continue;
    options.push(name);
  }
  return options;
}

/** The user's assigned profile row fields the derivation needs. */
export function loadTailscaleDialerGroups(
  db: SubhubDb,
  user: Pick<User, 'profileId'>,
): string[] {
  if (user.profileId === null || user.profileId === undefined) return [];
  const row = db
    .select({ iniText: profiles.iniText })
    .from(profiles)
    .where(eq(profiles.id, user.profileId))
    .get();
  return tailscaleDialerGroupsFromIni(row?.iniText ?? null);
}

/**
 * Validate and store (or clear, with `null`) a user's Tailscale dialer.
 *
 * `null` clears. A string must be a member of the user's current allowed set,
 * otherwise 400 — the same answer for an unknown name and for a reserved one.
 * Returns the DTO state only.
 */
export async function setUserTailscaleDialerProxy(
  db: SubhubDb,
  user: Pick<User, 'id' | 'profileId'>,
  rawGroup: unknown,
  resolveIni: ProfileIniResolver = fetchProfileIni,
): Promise<TailscaleDialerState> {
  let choice: string | null;
  if (rawGroup === null || rawGroup === undefined) {
    choice = null;
  } else if (typeof rawGroup !== 'string') {
    throw new ValidationError('group must be a string or null');
  } else {
    const trimmed = rawGroup.trim();
    choice = trimmed || null;
  }
  if (choice !== null && choice.length > TAILSCALE_DIALER_MAX_LENGTH) {
    throw new ValidationError(
      `group must be at most ${TAILSCALE_DIALER_MAX_LENGTH} characters`,
    );
  }

  const options = await loadTailscaleDialerOptions(db, user, resolveIni);
  if (choice !== null && !options.includes(choice)) {
    throw new ValidationError('group is not a policy group of your profile');
  }

  const row = db
    .update(users)
    .set({ tailscaleDialerProxy: choice })
    .where(eq(users.id, user.id))
    .returning({ tailscaleDialerProxy: users.tailscaleDialerProxy })
    .get();
  if (!row) throw new ValidationError('user not found', 404);
  return { dialerProxy: readUserTailscaleDialerProxy(row), options };
}

/**
 * The allowed set for the write path: inline INI without a fetch, the resolved
 * INI (which may fetch a URL) when it can be had. A failing resolver yields the
 * inline-only set rather than an error.
 */
export async function loadTailscaleDialerOptions(
  db: SubhubDb,
  user: Pick<User, 'profileId'>,
  resolveIni: ProfileIniResolver = fetchProfileIni,
): Promise<string[]> {
  if (user.profileId === null || user.profileId === undefined) return [];
  const row = db.select().from(profiles).where(eq(profiles.id, user.profileId)).get();
  if (!row) return [];
  let iniText: string | null = row.iniText ?? null;
  try {
    iniText = await resolveIni({ iniText: row.iniText ?? null, iniUrl: row.iniUrl ?? null });
  } catch {
    // Keep the inline text; an export never fails over the profile either.
  }
  return tailscaleDialerGroupsFromIni(iniText);
}

/**
 * The current stored value for a user row (never throws; an unknown column
 * value reads as direct).
 */
export function tailscaleDialerState(
  user: Pick<User, 'tailscaleDialerProxy'>,
  options: string[],
): TailscaleDialerState {
  return { dialerProxy: readUserTailscaleDialerProxy(user), options };
}
