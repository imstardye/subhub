// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers behind the redesigned admin pages (ease-of-operation pass).
 *
 * The pages do the fetching and rendering; everything that decides *what* to
 * show — how a source's status is labelled, how its 归属 is summarised, which
 * sources are unhealthy, how a shared/专属 payload is built from the radio
 * group state, time formatting, log status classes — lives here so it can be
 * unit-tested without a DOM (no jsdom/happy-dom is installed).
 *
 * Nothing here imports Nuxt or the database: only plain data in, plain data
 * out, so the same helpers work during SSR and in tests.
 */
// Relative imports (not `~/…`): the root `tsc --noEmit` runs without the Nuxt
// alias table, and type-only imports still resolve at build time.
import { decodeBase64 } from './index';
import type { AdminSource } from '../../server/utils/admin-sources';
import type { AdminAccessLog } from '../../server/utils/admin-logs';
import type { AdminUser } from '../../server/utils/admin-users';
import type { SourceAccessMode } from '../../server/utils/admin-validation';

/** The three source kinds of access model v2, in group-display order. */
export const SOURCE_KINDS = ['public', 'shared', 'dedicated'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Which kind a source belongs to (owner wins, then accessMode). */
export function sourceKind(
  source: Pick<AdminSource, 'ownerUserId' | 'accessMode'>,
): SourceKind {
  if (source.ownerUserId !== null && source.ownerUserId !== undefined) return 'dedicated';
  return source.accessMode === 'restricted' ? 'shared' : 'public';
}

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  public: '公共源',
  shared: '共享源',
  dedicated: '专属源',
};

/** Group sources by kind, each group ordered by source id. */
export function groupSources<T extends Pick<AdminSource, 'id' | 'ownerUserId' | 'accessMode'>>(
  sources: readonly T[],
): Record<SourceKind, T[]> {
  const groups: Record<SourceKind, T[]> = { public: [], shared: [], dedicated: [] };
  for (const source of [...sources].sort((a, b) => a.id - b.id)) {
    groups[sourceKind(source)].push(source);
  }
  return groups;
}

/** One-line 归属 summary: 公共 / 共享·N 人 / 专属·用户名. */
export function accessSummary(
  source: Pick<AdminSource, 'ownerUserId' | 'accessMode'> & { allowedUserIds?: number[] },
  userName: (id: number) => string | undefined,
): string {
  const kind = sourceKind(source);
  if (kind === 'dedicated') return `专属·${userName(source.ownerUserId!) ?? `用户 #${source.ownerUserId}`}`;
  if (kind === 'shared') {
    const count = source.allowedUserIds?.length ?? 0;
    return `共享·${count} 人`;
  }
  return '公共';
}

/** Allowlist names, for the row's tooltip/subtext. */
export function allowedUserNames(
  source: Pick<AdminSource, 'allowedUserIds'>,
  userName: (id: number) => string | undefined,
): string[] {
  return (source.allowedUserIds ?? []).map((id) => userName(id) ?? `用户 #${id}`);
}

export type SourceHealth = 'ok' | 'failed' | 'never';

/**
 * Status at a glance:
 * - 'failed': the last refresh recorded an error (red),
 * - 'ok': a refresh succeeded and left no error (green),
 * - 'never': no successful refresh yet and no error (grey).
 */
export function sourceHealth(
  source: Pick<AdminSource, 'lastOkAt' | 'lastError'>,
): SourceHealth {
  if (source.lastError) return 'failed';
  return source.lastOkAt ? 'ok' : 'never';
}

export const SOURCE_HEALTH_LABELS: Record<SourceHealth, string> = {
  ok: '正常',
  failed: '失败',
  never: '未刷新',
};

/** Sources the dashboard's 源健康 card lists: failed or never refreshed. */
export function unhealthySources<T extends Pick<AdminSource, 'id' | 'name' | 'lastOkAt' | 'lastError'>>(
  sources: readonly T[],
): T[] {
  return sources
    .filter((source) => sourceHealth(source) !== 'ok')
    .sort((a, b) => Number(!a.lastError) - Number(!b.lastError) || a.id - b.id);
}

/**
 * What the dashboard's 源健康 card shows.
 *
 * `loading` and `error` are distinct from `healthy`: an empty `sources` list
 * before the request resolved (SSR renders `setup()` state!) is *not* "all
 * sources are healthy", which is exactly the false-positive the card showed
 * live while 16 sources had `lastError` set. Only a successfully loaded,
 * non-empty list with zero unhealthy entries is `healthy`.
 */
export type SourceHealthCard =
  | { state: 'loading'; count: 0; sources: [] }
  | { state: 'error'; count: 0; sources: []; error: string }
  | { state: 'empty'; count: 0; sources: [] }
  | { state: 'healthy'; count: 0; sources: [] }
  | { state: 'unhealthy'; count: number; sources: Array<{ id: number; name: string; lastError: string | null }> };

export function sourceHealthCard(
  sources: readonly Pick<AdminSource, 'id' | 'name' | 'lastOkAt' | 'lastError'>[] | null | undefined,
  options: { loading?: boolean; error?: string | null } = {},
): SourceHealthCard {
  const error = options.error?.trim();
  if (error) return { state: 'error', count: 0, sources: [], error };
  if (!sources) return { state: 'loading', count: 0, sources: [] };
  // Data wins over the loading flag: a refetch must not flash "loading" (or
  // "healthy") while the last known failures are still on screen.
  if (sources.length === 0) {
    return options.loading
      ? { state: 'loading', count: 0, sources: [] }
      : { state: 'empty', count: 0, sources: [] };
  }
  const sick = unhealthySources(sources);
  if (sick.length === 0) return { state: 'healthy', count: 0, sources: [] };
  return {
    state: 'unhealthy',
    count: sick.length,
    sources: sick.map((source) => ({
      id: source.id,
      name: source.name,
      lastError: source.lastError ?? null,
    })),
  };
}

/** `2026-10-24 09:05` in local time; `—` for null/invalid. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Relative "x 分钟前" label; falls back to the absolute time past a day. */
export function relativeTime(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return formatDateTime(value);
}

/** Mask a token for display in a dense row: first 8 + … + last 4. */
export function maskToken(token: string): string {
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/** Public subscription URL for a token; `origin` from `window.location.origin`. */
export function subscriptionUrl(origin: string, token: string, target?: string): string {
  return subscriptionUrlWithPrefix(origin, SUB_PATH_DEFAULT_UI, token, target);
}

/**
 * Prefix used when the payload carries none (older server, offline fixture).
 * The built-in default of the `sub_path` setting (server/utils/settings.ts).
 */
export const SUB_PATH_DEFAULT_UI = 's';

/** Normalise a prefix segment list for URL building (`/dl/`, `dl` -> `dl`). */
export function normalizeSubPathForUrl(prefix: string | null | undefined): string {
  const value = (prefix ?? '')
    .trim()
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  return value || SUB_PATH_DEFAULT_UI;
}

/**
 * Subscription URL under the *effective* prefix (`/dl/<token>/clash`).
 *
 * Every copy-link / quick-open button goes through this: the prefix is the
 * `sub_path` site setting, exposed as `settings.subPath` on the stats payload
 * (`/api/admin/me` carries it too, see the layout). A missing prefix falls back
 * to `s`, which is what the built-in default serves.
 */
export function subscriptionUrlWithPrefix(
  origin: string,
  prefix: string | null | undefined,
  token: string,
  target?: string,
): string {
  const base = origin.replace(/\/+$/, '');
  const root = `${base}/${normalizeSubPathForUrl(prefix)}`;
  return target ? `${root}/${token}/${target}` : `${root}/${token}`;
}

/**
 * Display form of a user's subscription path, e.g. `/dl/ab12c3d4…89ef`
 * (the token is masked — the row/dialog shows it, the real value is only ever
 * copied via `subscriptionUrlWithPrefix`).
 */
export function subscriptionPathLabel(prefix: string | null | undefined, token: string): string {
  return `/${normalizeSubPathForUrl(prefix)}/${maskToken(token)}`;
}

/** Quick-open targets offered next to the subscription link. */
export const SUBSCRIPTION_QUICK_TARGETS = [
  { target: 'mihomo', label: 'mihomo' },
  { target: 'clash', label: 'clash' },
] as const;

/** Per-user source counts shown in the users hub. */
export interface UserSourceCounts {
  dedicated: number;
  shared: number;
}

/**
 * Count the sources a user's export reaches, by kind:
 * 专属 = owned by them, 共享 = shared sources whose allowlist contains them
 * (public sources are the same for everyone and are not "their" shared ones).
 */
export function userSourceCounts(
  sources: readonly Pick<AdminSource, 'ownerUserId' | 'accessMode' | 'allowedUserIds'>[],
  userId: number,
): UserSourceCounts {
  let dedicated = 0;
  let shared = 0;
  for (const source of sources) {
    if (source.ownerUserId === userId) dedicated += 1;
    else if (
      (source.ownerUserId === null || source.ownerUserId === undefined) &&
      source.accessMode === 'restricted' &&
      (source.allowedUserIds ?? []).includes(userId)
    ) {
      shared += 1;
    }
  }
  return { dedicated, shared };
}

/** Name resolver over a user list (for 专属·名称 and allowlist tooltips). */
export function userNameResolver(
  users: readonly Pick<AdminUser, 'id' | 'name'>[],
): (id: number) => string | undefined {
  const byId = new Map(users.map((user) => [user.id, user.name]));
  return (id) => byId.get(id);
}

/* --------------------------------------------------------------- forms -- */

/** The 归属 radio group of the source form. */
export type SourceOwnership = SourceKind;

/** Body fragments the source form sends for each 归属. */
export interface OwnershipPayload {
  ownerUserId: number | null;
  accessMode: SourceAccessMode;
  allowedUserIds: number[];
}

export type OwnershipResult = { ok: true; payload: OwnershipPayload } | { ok: false; error: string };

/**
 * Build the access fields of a source create/update body from the form state.
 *
 * - 公共: no owner, accessMode 'all', no list;
 * - 共享: no owner, accessMode 'restricted', the checked user ids;
 * - 专属: the selected owner, accessMode 'all' (the server ignores it anyway).
 *
 * The form only ever holds ids chosen in a `<select>` / checkbox list, never a
 * typed number, so the only failure is "no user selected" for 专属.
 */
export function buildOwnershipPayload(
  ownership: SourceOwnership,
  ownerUserId: string,
  allowedUserIds: readonly (number | string)[],
): OwnershipResult {
  if (ownership === 'dedicated') {
    const id = Number(ownerUserId);
    if (!ownerUserId || !Number.isInteger(id) || id <= 0) {
      return { ok: false, error: '请选择专属用户' };
    }
    return { ok: true, payload: { ownerUserId: id, accessMode: 'all', allowedUserIds: [] } };
  }
  if (ownership === 'shared') {
    const ids = [...new Set(allowedUserIds.map((value) => Number(value)))]
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
    return { ok: true, payload: { ownerUserId: null, accessMode: 'restricted', allowedUserIds: ids } };
  }
  return { ok: true, payload: { ownerUserId: null, accessMode: 'all', allowedUserIds: [] } };
}

/** Seed the 归属 radio group from a listed source. */
export function ownershipFromSource(
  source: Pick<AdminSource, 'ownerUserId' | 'accessMode'>,
): SourceOwnership {
  return sourceKind(source);
}

/* ----------------------------------------------------------------- logs -- */

/** Chip class for a log status code (5xx red, 4xx amber, 2xx green). */
export function logStatusClass(status: number | null): string {
  if (status === null) return 'badge off';
  if (status >= 500) return 'badge bad';
  if (status >= 400) return 'badge warn';
  if (status >= 200 && status < 300) return 'badge on';
  return 'badge off';
}

/** Latest N access log rows, newest first (the dashboard's 最近访问 card). */
export function latestLogs<T extends Pick<AdminAccessLog, 'createdAt' | 'id'>>(
  logs: readonly T[],
  count = 5,
): T[] {
  return [...logs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b.id - a.id)
    .slice(0, count);
}

/** Log row label for the user column (deleted users keep their id). */
export function logUserName(log: Pick<AdminAccessLog, 'userId' | 'userName'>): string {
  if (log.userId === null) return '—';
  return log.userName ?? `(已删除 #${log.userId})`;
}

/* -------------------------------------------------------------- profiles -- */

/** One-line INI source summary: URL, or 内联 N 字符; both joined with `+`. */
export function iniSummary(profile: { iniUrl?: string | null; iniText?: string | null }): string {
  const parts: string[] = [];
  if (profile.iniUrl) parts.push(profile.iniUrl);
  if (profile.iniText) parts.push(`内联 ${profile.iniText.length} 字符`);
  return parts.length > 0 ? parts.join(' + ') : '—';
}

/** Users that reference a profile, by name. */
export function profileUsers(
  users: readonly Pick<AdminUser, 'id' | 'name' | 'profileId'>[],
  profileId: number,
): Array<Pick<AdminUser, 'id' | 'name' | 'profileId'>> {
  return users.filter((user) => user.profileId === profileId);
}

/** A profile field truncated for a dense card (keeps the head readable). */
export function truncate(value: string, max = 60): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The targets whose body is a base64 share-link list instead of YAML/text. */
const BASE64_LINK_TARGETS = new Set(['shadowrocket']);

/**
 * What the preview should show for a rendered body.
 *
 * Surge/Loon/Clash bodies are already readable config text, so they are shown
 * verbatim. A Shadowrocket subscription is base64 of newline-joined share
 * links: showing the base64 alone tells an admin nothing, so it is decoded to
 * one link per line (undecodable base64 falls back to the raw body). The raw
 * body stays available for copying either way — the page copies
 * `previewBodyText`.
 */
export function previewBodyText(
  target: string,
  body: string,
  truncated = false,
): { text: string; decoded: boolean } {
  if (!BASE64_LINK_TARGETS.has(target) || body === '') return { text: body, decoded: false };
  // A cut-off payload cannot be decoded (and a partial line would be a lie).
  if (truncated) return { text: body, decoded: false };
  let decoded: string;
  try {
    decoded = decodeBase64(body);
  } catch {
    return { text: body, decoded: false };
  }
  if (!decoded || decoded.includes('\u0000')) return { text: body, decoded: false };
  return { text: decoded, decoded: true };
}

/* -------------------------------------------------------------- settings -- */

/** Settings payload as returned by GET/PUT /api/admin/settings. */
export interface SettingsView {
  subPath: string;
  defaultSubPath: string;
  reservedRoots: string[];
  adminPath: string;
}

/**
 * Client-side check of a 订阅链接前缀 before saving. The server repeats every
 * rule (it is the authority); this only spares the admin a round trip for the
 * obvious mistakes. Mirrors `validateSubPath` in `server/utils/settings.ts`:
 * normalised, 1–4 segments of /^[a-z0-9][a-z0-9_-]*$/, not the admin path and
 * not a reserved root.
 */
export function validateSubPathInput(
  raw: string,
  settings: Pick<SettingsView, 'reservedRoots' | 'adminPath'>,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = (raw ?? '')
    .trim()
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/')
    .toLowerCase();
  if (!value) return { ok: false, error: '订阅链接前缀不能为空' };
  if (value.length > 64) return { ok: false, error: '订阅链接前缀最长 64 个字符' };
  const segments = value.split('/');
  if (segments.length > 4) return { ok: false, error: '订阅链接前缀最多 4 段' };
  for (const segment of segments) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(segment)) {
      return { ok: false, error: '只能使用小写字母、数字、- 和 _，且每段以字母或数字开头' };
    }
  }
  const admin = (settings.adminPath ?? 'login').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (value === admin || segments[0] === admin) {
    return { ok: false, error: `不能与后台入口路径「${admin}」相同` };
  }
  if (settings.reservedRoots.includes(segments[0]!)) {
    return { ok: false, error: `不能使用系统保留路径「${segments[0]}」` };
  }
  return { ok: true, value };
}
