// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Self-service user center (`/my/<token>` + `/api/user/<token>/*`).
 *
 * The token in the URL *is* the credential: there are no accounts and no
 * passwords. Everything here is scoped to the owner of that token, and every id
 * a request carries (source id) is validated against that owner before it is
 * touched.
 *
 * Hard rules implemented here:
 * - **Write-only URLs.** A saved source URL is never serialised by this feature:
 *   no DTO in this file carries `sources.url` (not even masked). The add form
 *   accepts a URL, the edit form only replaces it when a non-empty URL is
 *   submitted. Encryption at rest stays in `server/db/crypto.ts`.
 * - **Traffic cards** are exactly the user's DEDICATED sources, each with its own
 *   `subscription-userinfo`; the summary aggregates only those. Public/shared
 *   sources appear only as *names* in the inclusion list.
 * - **Raw subscription info wins.** A card reports what the subscription says
 *   about *itself*: a field the `subscription-userinfo` header carries is used
 *   as is, and only the fields the header is missing are filled from the
 *   source's own info pseudo-nodes (`剩余流量：579.45 GB`, `套餐到期：长期有效`;
 *   see `core/rules/raw-info.ts`). Fields the provider never reported stay
 *   empty — nothing is invented. Exports are untouched: they keep dropping
 *   those pseudo-nodes (built-in info filter).
 * - **Inclusion choice** (`user_source_choices`) applies to public/shared sources
 *   only, defaults to included, and an explicit `false` removes the source from
 *   that user's exports (see `loadUserSourceCaches` in `export-nodes.ts`).
 *
 * Source writes reuse the admin service layer (`createSource` / `updateSource`
 * in `admin-sources.ts`) so validation, encryption and the access-model
 * consistency rules are identical to the console; the owner is forced to the
 * token's user, the mode to dedicated, and the type to `remote` (the refresh
 * task is what gives a self-service source its cache).
 */
import { and, eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import {
  profiles,
  sourceAllowedUsers,
  sources,
  userSourceChoices,
  type Source,
  type SourceAccessMode,
  type User,
} from '../db/schema';
import { createSource, deleteSource, updateSource } from './admin-sources';
import {
  UA_MAX_LENGTH,
  ValidationError,
  parseEnabled,
  parseName,
  parseOptionalText,
  parseSourceUrl,
} from './admin-validation';
import {
  filterInfoNodes,
  parseSubscription,
} from '../../core';
import { isSourceDisabled } from './export-nodes';
import { refreshSource, type Fetcher } from '../tasks/refresh-sources';
import { mergeUserInfo, rawTrafficInfoFromCache, type SubscriptionUserInfo } from './userinfo';
import { findUserByToken, rotateUserToken } from './user-token';
import {
  USER_CENTER_EXPORT_TARGETS,
  buildSubscriptionUrl,
  resolveSubPrefix,
} from './sub-prefix';
import type { ExportTarget } from './targets';

/**
 * Kind of a public/shared source as the inclusion list spells it: `shared` is
 * the `restricted` access mode (allowlist), anything else is public.
 */
export function availableSourceKind(
  accessMode: SourceAccessMode | null | undefined,
): 'public' | 'shared' {
  return accessMode === 'restricted' ? 'shared' : 'public';
}

/** Only a PUBLIC/SHARED source (no owner) can appear in the inclusion list. */
export function isChoosableSource(row: { ownerUserId: number | null }): boolean {
  return row.ownerUserId === null || row.ownerUserId === undefined;
}

/** Health of a dedicated source as the user center reports it. */
export type SourceHealthState = 'ok' | 'failed' | 'never';

export interface UserCenterHealth {
  state: SourceHealthState;
  /** Short upstream error of the last failed refresh. */
  error: string | null;
  /** ISO timestamp of the last successful refresh. */
  lastOkAt: string | null;
}

interface SourceRowSubset {
  lastOkAt: Date | null;
  lastError: string | null;
}

/** Keep the error readable in a mobile card (the stored value is ≤500 chars). */
export function truncateError(message: string, max = 160): string {
  const text = message.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Health of one source: `failed` when the last refresh left an error, `ok` when
 * it succeeded and nothing newer failed, `never` when it never succeeded.
 * A source that succeeded once and failed later is `failed` (the cache is
 * stale), matching the dashboard's 源健康 card.
 */
export function sourceHealth(row: SourceRowSubset): UserCenterHealth {
  const error = row.lastError ? row.lastError.trim() : '';
  const lastOkAt = row.lastOkAt ? row.lastOkAt.toISOString() : null;
  if (error) return { state: 'failed', error: truncateError(error), lastOkAt };
  if (!row.lastOkAt) return { state: 'never', error: null, lastOkAt: null };
  return { state: 'ok', error: null, lastOkAt };
}

/**
 * Number of nodes a cache blob parses to; `null` when it does not parse.
 *
 * Counts the nodes an export would actually carry: the built-in info/ads
 * pseudo-node set (`剩余流量：…`, `套餐到期：…` — see `core/rules/info-nodes.ts`)
 * is filtered out here too, so the user center's "N 个节点" matches the export.
 * The cache itself keeps the raw payload; only the count/filter path drops them.
 * The rule profile's `exclude_remarks` is deliberately NOT applied here — it is
 * per-profile, while this is a per-source figure.
 */
export function countCachedNodes(blob: string | null): number | null {
  const text = blob?.trim();
  if (!text) return null;
  try {
    return filterInfoNodes(parseSubscription(text)).length;
  } catch {
    return null;
  }
}

/** Dedicated source as exposed by the user center. Never carries the URL. */
export interface UserCenterOwnSource {
  id: number;
  name: string;
  enabled: boolean;
  userAgent: string | null;
  health: UserCenterHealth;
  /** Parsed nodes of the current cache, or `null` when it has none/unreadable. */
  nodeCount: number | null;
  hasCache: boolean;
}

/** Traffic card data of one dedicated source. `null` = no userinfo at all. */
export interface UserCenterTrafficSource {
  id: number;
  name: string;
  enabled: boolean;
  health: UserCenterHealth;
  userinfo: SubscriptionUserInfo | null;
  /** ISO timestamp of the refresh that captured `userinfo`. */
  userinfoRefreshedAt: string | null;
  /**
   * 套餐到期 exactly as the subscription writes it when it is not a date
   * (`长期有效`). Displayed instead of a date; `userinfo.expire` then stays
   * `null` so no fake epoch leaks into the summary.
   */
  expireText: string | null;
  /**
   * Remaining traffic in bytes, from the header when it can be derived
   * (`total - upload - download`) or from the info nodes (`剩余流量`). `null`
   * when neither reported it; `0` is a real (exhausted) value.
   */
  remaining: number | null;
  /** Fields taken from the source's own info nodes (not from the header). */
  rawFields: Array<'remaining' | 'expire'>;
}

/**
 * Summary of the dedicated sources only (public/shared are never in it).
 * Every part stays `null` when no dedicated source reported it, so the page can
 * say 暂无流量数据 instead of inventing 0.
 */
export interface UserCenterTrafficSummary {
  upload: number | null;
  download: number | null;
  total: number | null;
  /** upload + download when either is known. */
  used: number | null;
  /** total − used when both are known (never negative). */
  remaining: number | null;
  /** Unix epoch seconds, earliest expiry among the dedicated sources. */
  expire: number | null;
  /**
   * Earliest 套餐到期 wording when the expiry is open-ended (`长期有效`), used
   * only when no source reported a real date.
   */
  expireText: string | null;
  /** How many dedicated sources contributed userinfo. */
  sourcesWithUserinfo: number;
  dedicatedCount: number;
}

/** A public/shared source the user may include or exclude. */
export interface UserCenterAvailableSource {
  id: number;
  name: string;
  kind: 'public' | 'shared';
  /** Current choice; `true` when the user never chose (the default). */
  included: boolean;
}

export interface UserCenterProfileInfo {
  /** The assigned rule profile's name, or null when none is assigned. */
  assignedProfile: string | null;
  /** Every profile name (the link switcher), ascending by id. */
  profileNames: string[];
}

export interface UserCenterData {
  user: {
    name: string;
    note: string | null;
    enabled: boolean;
    /** The token the page was opened with (used for link building). */
    token: string;
  };
  profile: UserCenterProfileInfo;
  traffic: {
    summary: UserCenterTrafficSummary;
    sources: UserCenterTrafficSource[];
  };
  ownSources: UserCenterOwnSource[];
  availableSources: UserCenterAvailableSource[];
  /** Subscription prefix the links are built with (seam: feat/sub-path). */
  subPrefix: string;
  /** Export targets in display order (the page lists all of them). */
  targets: string[];
  /** Pre-built main link (before any profile suffix). */
  mainLink: string;
}

/** Disabled users get this instead of their data: nothing actionable. */
export interface UserCenterDisabledData {
  user: { enabled: false };
}

export function isDisabledPayload(data: unknown): data is UserCenterDisabledData {
  const user = (data as { user?: { enabled?: unknown } } | null)?.user;
  return !!user && user.enabled === false;
}

/** Unknown/empty token: 404 without any detail. */
export function requireUserByToken(db: SubhubDb, token: string | null | undefined): User {
  const user = findUserByToken(db, token, { includeDisabled: true });
  if (!user) throw new ValidationError('not found', 404);
  return user;
}

/** The token owner *and* their management rights (disabled users have none). */
export function requireEnabledUserByToken(db: SubhubDb, token: string | null | undefined): User {
  const user = requireUserByToken(db, token);
  if (!user.enabled) throw new ValidationError('user disabled', 403);
  return user;
}

/** Sum helper that keeps "unknown" as `null` (like `aggregateUserInfo`). */
function addAmount(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  const next = (current ?? 0) + value;
  return Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
}

/** Aggregate the dedicated cards into the summary header. */
export function summarizeTraffic(
  cards: ReadonlyArray<Pick<UserCenterTrafficSource, 'userinfo'> & Partial<Pick<UserCenterTrafficSource, 'remaining' | 'expireText'>>>,
  dedicatedCount = cards.length,
): UserCenterTrafficSummary {
  let upload: number | null = null;
  let download: number | null = null;
  let total: number | null = null;
  let expire: number | null = null;
  let remaining: number | null = null;
  let expireText: string | null = null;
  let contributing = 0;
  for (const card of cards) {
    const info = card.userinfo;
    if (!info) continue;
    contributing += 1;
    upload = addAmount(upload, info.upload);
    download = addAmount(download, info.download);
    total = addAmount(total, info.total);
    remaining = addAmount(remaining, card.remaining ?? null);
    if (info.expire !== null && info.expire > 0) {
      expire = expire === null ? info.expire : Math.min(expire, info.expire);
    } else if (!expireText && card.expireText) {
      expireText = card.expireText;
    }
  }
  const used = upload === null && download === null ? null : (upload ?? 0) + (download ?? 0);
  // Remaining is reported (header or info node) when available; otherwise it is
  // total − used. Neither is invented when the total is unknown.
  if (remaining === null) {
    remaining = total !== null && used !== null ? Math.max(0, total - used) : null;
  }
  return {
    upload,
    download,
    total,
    used,
    remaining,
    expire,
    expireText: expire === null ? expireText : null,
    sourcesWithUserinfo: contributing,
    dedicatedCount,
  };
}

function storedUserinfo(row: Source): SubscriptionUserInfo | null {
  const info: SubscriptionUserInfo = {
    upload: row.userinfoUpload ?? null,
    download: row.userinfoDownload ?? null,
    total: row.userinfoTotal ?? null,
    expire: row.userinfoExpire ?? null,
  };
  const any = info.upload !== null || info.download !== null || info.total !== null || info.expire !== null;
  return any ? info : null;
}

function toTrafficSource(row: Source): UserCenterTrafficSource {
  const merged = mergeUserInfo(storedUserinfo(row), rawTrafficInfoFromCache(row.cacheBlob));
  return {
    id: row.id,
    name: row.name,
    enabled: !isSourceDisabled(row),
    health: sourceHealth(row),
    ...merged,
    userinfoRefreshedAt: row.userinfoRefreshedAt ? row.userinfoRefreshedAt.toISOString() : null,
  };
}

function toOwnSource(row: Source): UserCenterOwnSource {
  return {
    id: row.id,
    name: row.name,
    enabled: !isSourceDisabled(row),
    userAgent: row.ua ?? null,
    health: sourceHealth(row),
    nodeCount: countCachedNodes(row.cacheBlob),
    hasCache: Boolean(row.cacheBlob),
  };
}

/** One dedicated source row of this user, or null (no cross-user access). */
function findOwnSource(db: SubhubDb, userId: number, rawId: unknown): Source | null {
  const id = typeof rawId === 'string' && rawId.trim() !== '' ? Number(rawId) : rawId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
  const row = db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.ownerUserId, userId)))
    .get();
  return row ?? null;
}

/** Public/shared sources this user may toggle, with their current choice. */
export function listAvailableSources(
  db: SubhubDb,
  userId: number,
): UserCenterAvailableSource[] {
  const allowlisted = new Set(
    db
      .select({ sourceId: sourceAllowedUsers.sourceId })
      .from(sourceAllowedUsers)
      .where(eq(sourceAllowedUsers.userId, userId))
      .all()
      .map((row) => row.sourceId),
  );
  const excluded = new Set(
    db
      .select({ sourceId: userSourceChoices.sourceId })
      .from(userSourceChoices)
      .where(and(eq(userSourceChoices.userId, userId), eq(userSourceChoices.included, false)))
      .all()
      .map((row) => row.sourceId),
  );
  const rows = db
    .select({ id: sources.id, name: sources.name, accessMode: sources.accessMode, ownerUserId: sources.ownerUserId })
    .from(sources)
    .orderBy(sources.id)
    .all();

  return rows
    .filter(isChoosableSource)
    .filter((row) => row.accessMode !== 'restricted' || allowlisted.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      kind: availableSourceKind(row.accessMode),
      included: !excluded.has(row.id),
    }));
}

/** Assigned profile name + all profile names (the link switcher). */
export function loadProfileInfo(db: SubhubDb, user: User): UserCenterProfileInfo {
  const rows = db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .orderBy(profiles.id)
    .all();
  const assigned =
    user.profileId === null || user.profileId === undefined
      ? null
      : rows.find((row) => row.id === user.profileId)?.name ?? null;
  return { assignedProfile: assigned, profileNames: rows.map((row) => row.name) };
}

/**
 * Everything `GET /api/user/:token` returns.
 *
 * A disabled user gets the minimal payload (`enabled: false` only): no sources,
 * no links, no traffic, nothing to act on.
 */
export function loadUserCenterData(
  db: SubhubDb,
  token: string,
  options: { origin?: string | null } = {},
): UserCenterData | UserCenterDisabledData {
  const user = requireUserByToken(db, token);
  if (!user.enabled) return { user: { enabled: false } };

  const dedicated = db
    .select()
    .from(sources)
    .where(eq(sources.ownerUserId, user.id))
    .orderBy(sources.id)
    .all();

  const cards = dedicated.map(toTrafficSource);
  const prefix = resolveSubPrefix(db);
  return {
    user: { name: user.name, note: user.note ?? null, enabled: true, token: user.token },
    profile: loadProfileInfo(db, user),
    traffic: { summary: summarizeTraffic(cards, dedicated.length), sources: cards },
    ownSources: dedicated.map(toOwnSource),
    availableSources: listAvailableSources(db, user.id),
    subPrefix: prefix,
    targets: [...USER_CENTER_EXPORT_TARGETS],
    mainLink: buildSubscriptionUrl({
      origin: (options.origin ?? '').replace(/\/+$/, ''),
      token: user.token,
      prefix,
    }),
  };
}

/** One own source as the write endpoints answer (same shape as `ownSources`). */
export function getUserCenterSource(
  db: SubhubDb,
  userId: number,
  rawId: unknown,
): UserCenterOwnSource {
  const row = findOwnSource(db, userId, rawId);
  if (!row) throw new ValidationError('source not found', 404);
  return toOwnSource(row);
}

/** Fields of an add request this feature understands (URL included). */
export interface AddSourceInput {
  name: unknown;
  url: unknown;
  /** Preferred spelling of the User-Agent override. */
  userAgent?: unknown;
  /** Legacy spelling, accepted for symmetry with the admin API. */
  ua?: unknown;
}

export interface AddSourceOptions {
  /** Injected fetcher so tests never hit the network. */
  fetcher?: Fetcher;
  /** Clock override for tests. */
  now?: () => number;
}

export interface AddSourceResult {
  source: UserCenterOwnSource;
  /** `refreshed` / `failed` / `skipped` — the one-off refresh of the new source. */
  refresh: 'refreshed' | 'failed' | 'skipped';
}

/**
 * Create a DEDICATED source owned by the token's user, then run the single
 * source refresh once (same code path as the admin refresh button) so the card
 * has data immediately. A failed first fetch is *not* an error for the caller:
 * the source exists, its health says `failed`/`never`, and the periodic task
 * keeps trying.
 *
 * Only the three user-facing fields are read: owner, access mode, allowlist and
 * type are forced server-side, so nothing else in the body can widen the source.
 */
export async function addOwnSource(
  db: SubhubDb,
  userId: number,
  input: AddSourceInput,
  options: AddSourceOptions = {},
): Promise<AddSourceResult> {
  const created = createSource(db, {
    name: input.name,
    url: input.url,
    ua: 'userAgent' in input ? input.userAgent : input.ua,
    // Forced: the source belongs to the token owner and is dedicated.
    ownerUserId: userId,
    accessMode: 'all',
    allowedUserIds: [],
    // Self-service sources are fetched by the refresh task (remote only).
    type: 'remote',
  });
  let outcome: AddSourceResult['refresh'] = 'skipped';
  try {
    const result = await refreshSource(db, created.id, {
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    outcome = result.outcome;
  } catch {
    outcome = 'failed';
  }
  return { source: getUserCenterSource(db, userId, created.id), refresh: outcome };
}

/**
 * Update one of the token owner's dedicated sources.
 *
 * - `name` / `enabled` / `userAgent` (`ua`) are normal fields;
 * - `url` replaces the stored URL **only when a non-empty URL is submitted** —
 *   an absent/blank field means "keep what is saved", because the URL can never
 *   be shown back to be confirmed;
 * - anything else (`ownerUserId`, `accessMode`, `type`, `allowedUserIds`) is
 *   ignored: a user cannot turn their source into a public one.
 */
export function updateOwnSource(
  db: SubhubDb,
  userId: number,
  rawId: unknown,
  body: Record<string, unknown>,
): UserCenterOwnSource {
  const existing = findOwnSource(db, userId, rawId);
  if (!existing) throw new ValidationError('source not found', 404);

  const patch: Record<string, unknown> = { ownerUserId: userId };
  if ('name' in body) patch.name = parseName(body.name);
  if ('enabled' in body) patch.enabled = parseEnabled(body.enabled);
  if ('userAgent' in body || 'ua' in body) {
    const raw = 'userAgent' in body ? body.userAgent : body.ua;
    patch.ua = parseOptionalText(raw, 'userAgent', UA_MAX_LENGTH);
  }
  if ('url' in body) {
    const raw = body.url;
    const blank = raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim());
    // Blank = keep the saved (write-only) URL. Only a real value is changed.
    if (!blank) {
      parseSourceUrl(raw); // validated before encryption in updateSource
      patch.url = raw;
    }
  }
  if (!('name' in patch) && !('enabled' in patch) && !('ua' in patch) && !('url' in patch)) {
    return toOwnSource(existing);
  }
  updateSource(db, existing.id, patch);
  return getUserCenterSource(db, userId, existing.id);
}

/**
 * Delete one of the token owner's dedicated sources
 * (`DELETE /api/user/:token/sources/:id`).
 *
 * Same ownership check as the PATCH: an id that is not a DEDICATED source of
 * this user (public/shared, another user's, unknown) is a 404, so ids cannot be
 * probed. The row goes through the admin cascade (`deleteSource`), which drops
 * the allowlist and `user_source_choices` rows too — no orphan choices survive.
 */
export function deleteOwnSource(
  db: SubhubDb,
  userId: number,
  rawId: unknown,
): { ok: true; id: number; name: string } {
  const existing = findOwnSource(db, userId, rawId);
  if (!existing) throw new ValidationError('source not found', 404);
  deleteSource(db, existing.id);
  return { ok: true, id: existing.id, name: existing.name };
}

/**
 * Persist the user's inclusion choice for a public/shared source. The id must be
 * in the user's available set — a dedicated source, another user's source or an
 * unknown id is a 404 (same answer for all, so ids cannot be probed). Public and
 * shared sources can only be *included* by this endpoint (there is no way to
 * resolve a dedicated id through it).
 */
export function setSourceInclusion(
  db: SubhubDb,
  userId: number,
  rawSourceId: unknown,
  included: unknown,
): UserCenterAvailableSource {
  if (typeof included !== 'boolean') {
    throw new ValidationError('included must be a boolean');
  }
  const id = typeof rawSourceId === 'string' && rawSourceId.trim() !== '' ? Number(rawSourceId) : rawSourceId;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new ValidationError('source not found', 404);
  }
  // Only public/shared sources can be chosen. A dedicated source (the caller's
  // own or somebody else's) answers 404, exactly like an unknown id.
  const row = db
    .select({ ownerUserId: sources.ownerUserId })
    .from(sources)
    .where(eq(sources.id, id))
    .get();
  if (!row || !isChoosableSource(row)) throw new ValidationError('source not found', 404);
  const available = listAvailableSources(db, userId).find((item) => item.id === id);
  if (!available) throw new ValidationError('source not found', 404);

  db.insert(userSourceChoices)
    .values({ userId, sourceId: id, included })
    .onConflictDoUpdate({
      target: [userSourceChoices.userId, userSourceChoices.sourceId],
      set: { included },
    })
    .run();
  return { ...available, included };
}

/**
 * Rotate the token of the owner (`POST /api/user/:token/refresh`). The old token
 * stops working everywhere (this API and `/s/<token>`) at once, so the caller
 * answers the new one and the page navigates to `/my/<newToken>`.
 */
export function refreshUserToken(db: SubhubDb, token: string): { token: string; userId: number } {
  const user = requireEnabledUserByToken(db, token);
  const row = rotateUserToken(db, user.id);
  if (!row) throw new ValidationError('not found', 404);
  return { token: row.token, userId: row.id };
}
