// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure page logic for the self-service user center (`pages/my/[token].vue`).
 *
 * No Vue/Nuxt imports and no DOM: the page only wires these results into its
 * template, so the decisions (which links, which traffic card state, how a
 * choice toggle behaves, what the write-only URL hint says) are unit-tested
 * here instead of by mounting components (there is no DOM test environment).
 */
import type {
  UserCenterAvailableSource,
  UserCenterData,
  UserCenterDisabledData,
  UserCenterOwnSource,
  UserCenterTrafficSource,
  UserCenterTrafficSummary,
} from '../../server/utils/user-center';
import { buildSubscriptionUrl, DEFAULT_SUB_PREFIX } from './sub-prefix';
import { EXPORT_TARGETS, type ExportTarget } from '../../server/utils/targets';

export type UserCenterPayload = UserCenterData | UserCenterDisabledData;

/** Chinese labels of the seven export targets, in the page's order. */
export const TARGET_LABELS: Record<ExportTarget, string> = {
  mihomo: 'Mihomo',
  clash: 'Clash',
  shadowrocket: 'Shadowrocket',
  singbox: 'sing-box',
  surge: 'Surge',
  loon: 'Loon',
  uri: '通用链接',
};

/** Targets the page renders, in a stable order. */
export const USER_CENTER_TARGETS: readonly ExportTarget[] = EXPORT_TARGETS;

export function isDisabledPayload(payload: UserCenterPayload | null): boolean {
  const user = (payload as UserCenterDisabledData | null)?.user;
  return !!user && (user as { enabled?: unknown }).enabled === false;
}

/** Write-only URL rule, spelled once so the page cannot drift from it. */
export const URL_WRITE_ONLY_HINT = '已保存链接（不可查看），填入新链接即替换，留空保持不变';

export interface LinkSwitchOptions {
  assignedProfile: string | null;
  /** Profile names offered by the switcher (assigned profile included). */
  profileNames: readonly string[];
  /** Currently selected profile name ('' = no suffix / the assigned one). */
  selected: string | null;
}

/**
 * Profile switcher entries: the assigned profile means "no suffix"; any other
 * profile name is appended to the links (`/<target>/<profile>`, or
 * `/<profile>` without a target).
 *
 * Selecting a profile only changes the links the page shows — it never writes
 * `users.profileId` (this feature has no endpoint for that).
 */
export function profileChoices(
  profileNames: readonly string[],
  assignedProfile: string | null,
): Array<{ name: string | null; label: string }> {
  const options: Array<{ name: string | null; label: string }> = [
    {
      name: assignedProfile,
      label: assignedProfile ? `${assignedProfile}（当前规则档）` : '默认（无规则档）',
    },
  ];
  for (const name of profileNames) {
    if (name === assignedProfile) continue;
    options.push({ name, label: name });
  }
  return options;
}

/** Build one subscription link for the current selection. */
export function targetLink(
  options: {
    origin: string;
    token: string;
    target?: string | null;
    profile?: string | null;
    assignedProfile?: string | null;
    subPrefix?: string | null;
  },
): string {
  // The assigned profile is the default composition: no suffix.
  const profile =
    options.profile && options.profile !== options.assignedProfile ? options.profile : null;
  return buildSubscriptionUrl({
    origin: options.origin,
    token: options.token,
    target: options.target ?? null,
    profile,
    prefix: options.subPrefix ?? DEFAULT_SUB_PREFIX,
  });
}

export interface TargetLinkRow {
  target: ExportTarget;
  label: string;
  url: string;
}

/** All seven links for the selected profile (the link table). */
export function targetLinks(options: {
  origin: string;
  token: string;
  profile?: string | null;
  assignedProfile?: string | null;
  subPrefix?: string | null;
}): TargetLinkRow[] {
  return USER_CENTER_TARGETS.map((target) => ({
    target,
    label: TARGET_LABELS[target],
    url: targetLink({ ...options, target }),
  }));
}

/** The "main" link (no target) shown with the QR code. */
export function mainLink(options: {
  origin: string;
  token: string;
  profile?: string | null;
  assignedProfile?: string | null;
  subPrefix?: string | null;
}): string {
  return targetLink({ ...options, target: null });
}

/** Byte amounts for the cards: `1.5 GB`, `—` when unknown. */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

/** `2026-10-01` from Unix epoch seconds; `—` when unknown/zero. */
export function formatExpire(epochSeconds: number | null | undefined): string {
  if (!epochSeconds || epochSeconds <= 0) return '—';
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Relative "last refresh" label for a health row. */
export function lastRefreshLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '从未成功刷新';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '从未成功刷新';
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return '刚刚刷新';
  if (minutes < 60) return `${minutes} 分钟前刷新`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前刷新`;
  return `${Math.round(hours / 24)} 天前刷新`;
}

export const HEALTH_LABELS: Record<'ok' | 'failed' | 'never', string> = {
  ok: '正常',
  failed: '刷新失败',
  never: '尚未刷新',
};

/** Progress + numbers of a traffic card (and of the summary header). */
export interface TrafficBar {
  used: number | null;
  total: number | null;
  remaining: number | null;
  /** 0..100, `null` when the total is unknown (render no bar). */
  percent: number | null;
  /** True when the card must show 暂无流量数据 instead of numbers. */
  empty: boolean;
  usedLabel: string;
  totalLabel: string;
  remainingLabel: string;
  expireLabel: string;
}

export function trafficBar(info: {
  upload: number | null;
  download: number | null;
  total: number | null;
  expire: number | null;
} | null, options: {
  /** Remaining reported by the subscription itself (header or info node). */
  remaining?: number | null;
  /** 套餐到期 wording when it is not a date (`长期有效`). */
  expireText?: string | null;
  /** 已用 already computed by the server (summary), instead of upload+download. */
  used?: number | null;
} = {}): TrafficBar {
  const reportedRemaining =
    options.remaining === null || options.remaining === undefined ? null : Math.max(0, options.remaining);
  if (!info) {
    // No header numbers at all, but the subscription's own node reported how
    // much is left: show that one figure instead of 暂无流量数据.
    if (reportedRemaining === null && !options.expireText) {
      return {
        used: null,
        total: null,
        remaining: null,
        percent: null,
        empty: true,
        usedLabel: '—',
        totalLabel: '—',
        remainingLabel: '—',
        expireLabel: '—',
      };
    }
    return {
      used: null,
      total: null,
      remaining: reportedRemaining,
      percent: null,
      empty: false,
      usedLabel: '—',
      totalLabel: '—',
      remainingLabel: formatBytes(reportedRemaining),
      expireLabel: options.expireText || '—',
    };
  }
  const used =
    options.used !== null && options.used !== undefined
      ? options.used
      : info.upload === null && info.download === null
        ? null
        : (info.upload ?? 0) + (info.download ?? 0);
  const total = info.total;
  // The subscription's own "remaining" is used as is; `total - used` is only the
  // derived fallback. An unknown total with a known remaining still shows it.
  const remaining =
    reportedRemaining ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
  // 已用 = 总量 − 剩余 when the total and the remaining are both known (a total
  // from the header plus a remaining from an info node is fine); otherwise the
  // upload+download sum, else unknown. Never invented.
  const derivedUsed =
    used ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null);
  const percent = total !== null && total > 0 && derivedUsed !== null
    ? Math.min(100, Math.max(0, (derivedUsed / total) * 100))
    : null;
  return {
    used: derivedUsed,
    total,
    remaining,
    percent,
    empty: false,
    usedLabel: formatBytes(derivedUsed),
    totalLabel: formatBytes(total),
    remainingLabel: formatBytes(remaining),
    expireLabel: options.expireText || formatExpire(info.expire),
  };
}

/** Summary header of the traffic section (dedicated sources only). */
export function summaryBar(summary: UserCenterTrafficSummary | null | undefined): TrafficBar {
  if (!summary || summary.sourcesWithUserinfo === 0) return trafficBar(null);
  return trafficBar(
    {
      upload: summary.upload,
      download: summary.download,
      total: summary.total,
      expire: summary.expire === null ? null : summary.expire,
    },
    { remaining: summary.remaining, expireText: summary.expireText ?? null, used: summary.used },
  );
}

/** What a dedicated card shows: numbers, or 暂无流量数据 when it has none. */
export function trafficCard(card: UserCenterTrafficSource): TrafficBar & {
  name: string;
  healthLabel: string;
  healthError: string | null;
  healthState: 'ok' | 'failed' | 'never';
  lastRefresh: string;
  /** Which fields are the subscription's own report (not the header). */
  rawFields: Array<'remaining' | 'expire'>;
} {
  const bar = trafficBar(card.userinfo, {
    remaining: card.remaining ?? null,
    expireText: card.expireText ?? null,
  });
  return {
    ...bar,
    name: card.name,
    healthLabel: HEALTH_LABELS[card.health.state],
    healthError: card.health.error,
    healthState: card.health.state,
    lastRefresh: lastRefreshLabel(card.health.lastOkAt),
    rawFields: card.rawFields ?? [],
  };
}

/**
 * Apply a successful inclusion toggle locally so the checkbox reflects the
 * server without re-fetching the whole page.
 */
export function applyInclusion(
  available: readonly UserCenterAvailableSource[],
  sourceId: number,
  included: boolean,
): UserCenterAvailableSource[] {
  return available.map((source) => (source.id === sourceId ? { ...source, included } : source));
}

/** Grouping of the inclusion list: public sources first, then shared. */
export function groupAvailableSources(
  available: readonly UserCenterAvailableSource[],
): Array<{ kind: 'public' | 'shared'; label: string; items: UserCenterAvailableSource[] }> {
  const groups: Array<{ kind: 'public' | 'shared'; label: string; items: UserCenterAvailableSource[] }> = [
    { kind: 'public', label: '公共订阅源', items: [] },
    { kind: 'shared', label: '共享订阅源', items: [] },
  ];
  for (const source of available) {
    groups.find((group) => group.kind === source.kind)?.items.push(source);
  }
  return groups.filter((group) => group.items.length > 0);
}

/** Counts shown in the own-source list header. */
export function ownSourceStats(own: readonly UserCenterOwnSource[]): {
  total: number;
  healthy: number;
  failing: number;
  nodes: number;
} {
  let healthy = 0;
  let failing = 0;
  let nodes = 0;
  for (const source of own) {
    if (source.health.state === 'ok') healthy += 1;
    else failing += 1;
    nodes += source.nodeCount ?? 0;
  }
  return { total: own.length, healthy, failing, nodes };
}

/** Confirmation text before deleting an own source (the name must be visible). */
export function deleteSourceConfirmText(name: string): string {
  return `确定删除订阅源「${name}」吗？删除后其订阅链接将不再包含该源，且无法恢复。`;
}

/**
 * Apply a successful delete locally: drop the source from every list the page
 * keeps, so the cards and the traffic summary update without waiting for a
 * refetch (the page also refreshes from the server afterwards).
 */
export function applySourceDelete(data: UserCenterData, sourceId: number): {
  ownSources: UserCenterOwnSource[];
  trafficSources: UserCenterTrafficSource[];
} {
  return {
    ownSources: data.ownSources.filter((source) => source.id !== sourceId),
    trafficSources: data.traffic.sources.filter((source) => source.id !== sourceId),
  };
}

/** Payload for `PATCH /api/user/:token/sources/:id` (URL only when non-empty). */
export function sourcePatchPayload(form: {
  name: string;
  enabled: boolean;
  userAgent: string;
  url: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    enabled: form.enabled,
    userAgent: form.userAgent.trim(),
  };
  // Blank = keep the saved (write-only) URL; only a real value replaces it.
  const url = form.url.trim();
  if (url) payload.url = url;
  return payload;
}

/** Payload for `POST /api/user/:token/sources`. */
export function sourceCreatePayload(form: {
  name: string;
  url: string;
  userAgent: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    url: form.url.trim(),
  };
  const ua = form.userAgent.trim();
  if (ua) payload.userAgent = ua;
  return payload;
}

/** Empty edit form: the URL field starts blank by rule, never pre-filled. */
export function editFormFromSource(source: UserCenterOwnSource): {
  name: string;
  enabled: boolean;
  userAgent: string;
  url: string;
} {
  return { name: source.name, enabled: source.enabled, userAgent: source.userAgent ?? '', url: '' };
}

/** What the page shows for a first paint: one of six explicit states. */
export type UserCenterView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'locked'; lock: UserCenterLock }
  | { kind: 'disabled'; title: string; message: string }
  | { kind: 'ready'; data: UserCenterData };

/** The two password-gate forms the page can render. */
export type UserCenterLock = 'needs-setup' | 'needs-password';

/**
 * Extract the gate state from a failed `/api/user/:token` request.
 *
 * The server answers 401 `{ error, status: 'needs-setup' | 'needs-password' }`;
 * `$fetch` exposes the JSON body as `err.data`. Anything else (404, network,
 * 500) is not a password state and must stay an ordinary error.
 */
export function userCenterLockFromError(error: unknown): UserCenterLock | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    data?: { status?: unknown };
    response?: { _data?: { status?: unknown } };
  };
  const status = candidate.data?.status ?? candidate.response?._data?.status;
  return status === 'needs-setup' || status === 'needs-password' ? status : null;
}

/**
 * Decide the page state from the fetch result. Kept pure so the (bug-prone)
 * "blank page while loading vs. disabled vs. locked" branches are unit-tested
 * instead of being re-derived inline in the template.
 */
export function userCenterView(input: {
  data?: UserCenterPayload | null;
  error?: string | null;
  pending?: boolean;
  lock?: UserCenterLock | null;
}): UserCenterView {
  if (input.lock) return { kind: 'locked', lock: input.lock };
  if (input.error) return { kind: 'error', message: input.error };
  if (input.pending && !input.data) return { kind: 'loading' };
  if (!input.data) return { kind: 'error', message: '加载失败，请稍后再试' };
  if (isDisabledPayload(input.data)) {
    return { kind: 'disabled', title: '账号已停用', message: '已停用，请联系管理员。' };
  }
  return { kind: 'ready', data: input.data as UserCenterData };
}

/** Origin of the running app (`https://host`), used to build absolute links. */
export function originFromLocation(
  location: { origin?: string; protocol?: string; host?: string } | null | undefined,
): string {
  if (!location) return '';
  if (typeof location.origin === 'string' && location.origin && location.origin !== 'null') {
    return location.origin.replace(/\/+$/, '');
  }
  const protocol = typeof location.protocol === 'string' ? location.protocol : '';
  const host = typeof location.host === 'string' ? location.host : '';
  return protocol && host ? `${protocol}//${host}` : '';
}

/** Where the page navigates after a token rotation. */
export function userCenterPath(token: string): string {
  return `/my/${encodeURIComponent(token)}`;
}

/** Client path of one user-center API resource. */
export function userCenterApiPath(token: string, resource = ''): string {
  const base = `/api/user/${encodeURIComponent(token)}`;
  const rest = resource.replace(/^\/+/, '');
  return rest ? `${base}/${rest}` : base;
}

/**
 * Short token for display (the full one is in the link / QR code).
 */
export function maskUserToken(token: string): string {
  if (token.length <= 10) return token;
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
