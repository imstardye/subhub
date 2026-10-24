// SPDX-License-Identifier: AGPL-3.0-only
/**
 * User center — page logic, QR code and gate scope.
 *
 * There is no DOM test environment, so `pages/my/[token].vue` is kept thin and
 * every decision it makes (which link a profile selection produces, what a
 * traffic card shows, what a form submits, what the page does while loading) is
 * a pure helper in `core/utils/user-center.ts` and tested here directly. The QR
 * code is the `qrcode` package behind `core/utils/qr.ts`: what is tested is the
 * link that goes *into* it (and that it renders at all), never the pixels.
 */
import { describe, expect, it } from 'vitest';
import {
  HEALTH_LABELS,
  TARGET_LABELS,
  URL_WRITE_ONLY_HINT,
  applyInclusion,
  editFormFromSource,
  formatBytes,
  formatExpire,
  groupAvailableSources,
  isDisabledPayload,
  lastRefreshLabel,
  mainLink,
  maskUserToken,
  ownSourceStats,
  profileChoices,
  sourceCreatePayload,
  sourcePatchPayload,
  summaryBar,
  targetLink,
  targetLinks,
  trafficBar,
  trafficCard,
  userCenterApiPath,
  userCenterPath,
  userCenterView,
} from '../core/utils/user-center';
import { qrModules, qrSvgPath } from '../core/utils/qr';
import { gateScope } from '../core/utils/admin-entrance';
import { subscriptionUrl } from '../core/utils/admin-ui';
import { buildSubscriptionUrl, normalizeSubPrefix, resolveSubPrefix } from '../server/utils/sub-prefix';
import type {
  UserCenterAvailableSource,
  UserCenterData,
  UserCenterOwnSource,
  UserCenterTrafficSource,
} from '../server/utils/user-center';

const TOKEN = 'a'.repeat(32);

/** Minimal `ready` payload; tests override only what they assert. */
function payload(overrides: Partial<UserCenterData> = {}): UserCenterData {
  return {
    user: { name: 'alice', note: null, enabled: true, token: TOKEN },
    profile: { assignedProfile: null, profileNames: [] },
    traffic: {
      summary: {
        upload: null,
        download: null,
        total: null,
        used: null,
        remaining: null,
        expire: null,
        sourcesWithUserinfo: 0,
        dedicatedCount: 0,
      },
      sources: [],
    },
    ownSources: [],
    availableSources: [],
    subPrefix: 's',
    targets: [...Object.keys(TARGET_LABELS)],
    mainLink: `https://hub.example.com/s/${TOKEN}`,
    ...overrides,
  };
}

describe('page state', () => {
  it('distinguishes loading, error, disabled and ready', () => {
    expect(userCenterView({ pending: true })).toEqual({ kind: 'loading' });
    expect(userCenterView({ error: 'network down' })).toEqual({ kind: 'error', message: 'network down' });
    expect(userCenterView({})).toEqual({ kind: 'error', message: '加载失败，请稍后再试' });
    expect(userCenterView({ data: { user: { enabled: false } } })).toEqual({
      kind: 'disabled',
      title: '账号已停用',
      message: '已停用，请联系管理员。',
    });
    expect(userCenterView({ data: payload(), pending: true }).kind).toBe('ready');
    expect(isDisabledPayload({ user: { enabled: false } })).toBe(true);
    expect(isDisabledPayload(payload())).toBe(false);
    expect(isDisabledPayload(null)).toBe(false);
  });
});

describe('links', () => {
  const base = { origin: 'https://hub.example.com', token: TOKEN };

  it('builds the main link and all seven target links', () => {
    expect(mainLink(base)).toBe(`https://hub.example.com/s/${TOKEN}`);
    const rows = targetLinks(base);
    expect(rows.map((row) => row.target)).toEqual(Object.keys(TARGET_LABELS));
    expect(rows.map((row) => row.label)).toEqual(Object.values(TARGET_LABELS));
    expect(rows.find((row) => row.target === 'clash')!.url).toBe(
      `https://hub.example.com/s/${TOKEN}/clash`,
    );
    expect(rows.every((row) => row.url.startsWith(`https://hub.example.com/s/${TOKEN}`))).toBe(true);
  });

  it('appends the selected profile name, and omits it for the assigned one', () => {
    const options = { ...base, assignedProfile: 'v2' };
    // No selection = assigned profile = no suffix.
    expect(mainLink(options)).toBe(`https://hub.example.com/s/${TOKEN}`);
    expect(targetLink({ ...options, target: 'clash' })).toBe(`https://hub.example.com/s/${TOKEN}/clash`);
    // Selecting the assigned profile explicitly is the default composition.
    expect(targetLink({ ...options, target: 'clash', profile: 'v2' })).toBe(
      `https://hub.example.com/s/${TOKEN}/clash`,
    );
    // Another profile is a suffix.
    expect(targetLink({ ...options, target: 'clash', profile: 'v2o' })).toBe(
      `https://hub.example.com/s/${TOKEN}/clash/v2o`,
    );
    // The 2nd-segment form for the main link.
    expect(mainLink({ ...options, profile: 'v2o' })).toBe(`https://hub.example.com/s/${TOKEN}/v2o`);
    expect(
      targetLinks({ ...options, profile: 'v2o' }).find((row) => row.target === 'mihomo')!.url,
    ).toBe(`https://hub.example.com/s/${TOKEN}/mihomo/v2o`);
  });

  it('honours a configured sub prefix', () => {
    expect(mainLink({ ...base, subPrefix: 'sub' })).toBe(`https://hub.example.com/sub/${TOKEN}`);
    expect(targetLink({ ...base, subPrefix: 'sub', target: 'surge' })).toBe(
      `https://hub.example.com/sub/${TOKEN}/surge`,
    );
  });

  it('offers the assigned profile first, then every other name once', () => {
    expect(profileChoices(['v2', 'v2o'], 'v2')).toEqual([
      { name: 'v2', label: 'v2（当前规则档）' },
      { name: 'v2o', label: 'v2o' },
    ]);
    expect(profileChoices([], null)).toEqual([{ name: null, label: '默认（无规则档）' }]);
    expect(profileChoices(['a', 'b'], null).map((option) => option.name)).toEqual([null, 'a', 'b']);
  });

  it('builds the page/API paths for a token', () => {
    expect(userCenterPath(TOKEN)).toBe(`/my/${TOKEN}`);
    expect(userCenterApiPath(TOKEN)).toBe(`/api/user/${TOKEN}`);
    expect(userCenterApiPath(TOKEN, 'sources/12')).toBe(`/api/user/${TOKEN}/sources/12`);
    expect(maskUserToken(TOKEN)).toBe('aaaaaa…aaaa');
    expect(maskUserToken('short')).toBe('short');
  });
});

describe('traffic presentation', () => {
  it('formats bytes and expiry dates', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(1024 ** 3 * 1.5)).toBe('1.50 GB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatExpire(null)).toBe('—');
    expect(formatExpire(0)).toBe('—');
    expect(formatExpire(1_700_000_000)).toBe('2023-11-14');
  });

  it('renders 暂无流量数据 (empty) for a source without userinfo', () => {
    const bar = trafficBar(null);
    expect(bar).toMatchObject({ empty: true, percent: null, usedLabel: '—' });
    expect(summaryBar(null)).toMatchObject({ empty: true });
    expect(
      summaryBar(payload().traffic.summary),
    ).toMatchObject({ empty: true });
  });

  it('computes the progress bar of a card', () => {
    const bar = trafficBar({ upload: 100, download: 400, total: 1000, expire: 1_700_000_000 });
    expect(bar).toMatchObject({
      empty: false,
      used: 500,
      remaining: 500,
      percent: 50,
      usedLabel: '500 B',
      totalLabel: '1000 B',
      expireLabel: '2023-11-14',
    });
    // An unknown total means no bar, but the numbers still show.
    expect(trafficBar({ upload: 1, download: 2, total: null, expire: null })).toMatchObject({
      empty: false,
      percent: null,
      remaining: null,
    });
    // Over-quota never renders a >100% bar or a negative remainder.
    expect(trafficBar({ upload: 900, download: 900, total: 1000, expire: null })).toMatchObject({
      percent: 100,
      remaining: 0,
    });
  });

  it('labels health and the last refresh', () => {
    expect(HEALTH_LABELS).toEqual({ ok: '正常', failed: '刷新失败', never: '尚未刷新' });
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(lastRefreshLabel(null, now)).toBe('从未成功刷新');
    expect(lastRefreshLabel('2026-10-24T11:59:40Z', now)).toBe('刚刚刷新');
    expect(lastRefreshLabel('2026-10-24T11:30:00Z', now)).toBe('30 分钟前刷新');
    expect(lastRefreshLabel('2026-10-24T09:00:00Z', now)).toBe('3 小时前刷新');
    expect(lastRefreshLabel('2026-10-22T12:00:00Z', now)).toBe('2 天前刷新');

    const card: UserCenterTrafficSource = {
      id: 1,
      name: '机场 A',
      enabled: true,
      health: { state: 'failed', error: 'HTTP 502', lastOkAt: '2026-10-24T09:00:00Z' },
      userinfo: null,
      userinfoRefreshedAt: null,
    };
    expect(trafficCard(card)).toMatchObject({
      name: '机场 A',
      empty: true,
      healthLabel: '刷新失败',
      healthError: 'HTTP 502',
      healthState: 'failed',
    });
  });

  it('sums the dedicated own sources for the header', () => {
    expect(
      ownSourceStats([
        { id: 1, name: 'a', enabled: true, userAgent: null, health: { state: 'ok', error: null, lastOkAt: null }, nodeCount: 3, hasCache: true },
        { id: 2, name: 'b', enabled: true, userAgent: null, health: { state: 'never', error: null, lastOkAt: null }, nodeCount: null, hasCache: false },
      ]),
    ).toEqual({ total: 2, healthy: 1, failing: 1, nodes: 3 });
  });
});

describe('inclusion list', () => {
  const available: UserCenterAvailableSource[] = [
    { id: 1, name: '公共 1', kind: 'public', included: true },
    { id: 2, name: '共享 1', kind: 'shared', included: true },
    { id: 3, name: '公共 2', kind: 'public', included: false },
  ];

  it('groups public before shared, dropping empty groups', () => {
    expect(groupAvailableSources(available).map((group) => [group.kind, group.items.map((item) => item.id)])).toEqual([
      ['public', [1, 3]],
      ['shared', [2]],
    ]);
    expect(groupAvailableSources([])).toEqual([]);
    expect(groupAvailableSources([available[1]!]).map((group) => group.kind)).toEqual(['shared']);
  });

  it('applies a toggle locally without touching other rows', () => {
    const next = applyInclusion(available, 1, false);
    expect(next.map((item) => [item.id, item.included])).toEqual([[1, false], [2, true], [3, false]]);
  });
});

describe('source forms', () => {
  const own: UserCenterOwnSource = {
    id: 7,
    name: '机场 A',
    enabled: true,
    userAgent: 'clash-verge/2.0',
    health: { state: 'ok', error: null, lastOkAt: null },
    nodeCount: 10,
    hasCache: true,
  };

  it('never pre-fills the edit URL field, and says why', () => {
    expect(editFormFromSource(own)).toEqual({
      name: '机场 A',
      enabled: true,
      userAgent: 'clash-verge/2.0',
      url: '',
    });
    expect(URL_WRITE_ONLY_HINT).toBe('已保存链接（不可查看），填入新链接即替换，留空保持不变');
    // No property of the server DTO carries a URL at all.
    expect(Object.keys(own)).not.toContain('url');
  });

  it('sends the URL on edit only when it is non-empty', () => {
    expect(sourcePatchPayload({ name: ' A ', enabled: false, userAgent: ' ua ', url: '' })).toEqual({
      name: 'A',
      enabled: false,
      userAgent: 'ua',
    });
    expect(sourcePatchPayload({ name: 'A', enabled: true, userAgent: '', url: '   ' })).not.toHaveProperty('url');
    expect(sourcePatchPayload({ name: 'A', enabled: true, userAgent: '', url: ' https://x.example.com/s ' })).toEqual({
      name: 'A',
      enabled: true,
      userAgent: '',
      url: 'https://x.example.com/s',
    });
  });

  it('always sends name + URL on add (and the UA only when set)', () => {
    expect(sourceCreatePayload({ name: ' 新 ', url: ' https://x.example.com/s ', userAgent: '' })).toEqual({
      name: '新',
      url: 'https://x.example.com/s',
    });
    expect(sourceCreatePayload({ name: 'x', url: 'https://x.example.com/s', userAgent: 'ua/1' })).toEqual({
      name: 'x',
      url: 'https://x.example.com/s',
      userAgent: 'ua/1',
    });
  });
});

describe('QR code of the current main link', () => {
  it('accepts the exact link the page displays', async () => {
    const link = mainLink({ origin: 'https://hub.example.com', token: TOKEN });
    const svg = await qrSvgPath(link);
    expect(svg).toContain('<svg');
    const modules = await qrModules(link);
    expect(modules).not.toBeNull();
    // Version 1 is 21×21; a 40-char link stays small.
    expect(modules!.length).toBeGreaterThanOrEqual(21);
    expect(modules![0]!.length).toBe(modules!.length);
    // Finder pattern corners are dark, as any valid QR code starts.
    expect(modules![0]![0]).toBe(true);
    // Different links produce different codes (the link is really encoded).
    const other = (await qrModules(`${link}/clash`))!;
    expect(other.map((row) => row.join('')).join('|')).not.toBe(modules!.map((row) => row.join('')).join('|'));
  });

  it('returns null for empty text or text that cannot be encoded (never throws)', async () => {
    expect(await qrSvgPath('')).toBeNull();
    expect(await qrSvgPath('   ')).toBeNull();
    expect(await qrModules(null)).toBeNull();
    // Way beyond any QR capacity: the page hides the card instead of crashing.
    expect(await qrSvgPath('x'.repeat(5000))).toBeNull();
  });
});

describe('gate scope', () => {
  it('never gates /my or /api/user', () => {
    expect(gateScope('/my', '/admin')).toEqual({ kind: 'public' });
    expect(gateScope(`/my/${TOKEN}`, '/admin')).toEqual({ kind: 'public' });
    expect(gateScope(`/my/${TOKEN}/`, '/admin')).toEqual({ kind: 'public' });
    expect(gateScope(`/API/USER/${TOKEN}`, '/admin')).toEqual({ kind: 'public' });
    // The admin surface stays gated (unchanged behaviour).
    expect(gateScope('/users', '/admin')).toEqual({ kind: 'admin-page' });
    expect(gateScope('/api/admin/users', '/admin')).toEqual({ kind: 'admin-api' });
  });
});

describe('sub prefix seam', () => {
  it('is byte-identical to the admin console builder and normalises bad values', () => {
    const base = { origin: 'https://hub.example.com/', token: TOKEN };
    expect(buildSubscriptionUrl(base)).toBe(subscriptionUrl('https://hub.example.com/', TOKEN));
    expect(buildSubscriptionUrl({ ...base, target: 'clash' })).toBe(
      subscriptionUrl('https://hub.example.com/', TOKEN, 'clash'),
    );
    expect(resolveSubPrefix(null)).toBe('s');
    expect(normalizeSubPrefix(' /sub/ ')).toBe('sub');
    // Anything unusable falls back to the default (never to an empty segment).
    for (const value of ['', null, undefined, '/', '..', 'a b', 'a//b']) {
      expect(normalizeSubPrefix(value)).toBe('s');
    }
  });
});

describe('page SFC wiring', () => {
  it('imports every core/utils/user-center name the page uses', async () => {
    // Regression (live, 2026-10-25): the page called originFromLocation()
    // without importing it — SFCs are not type-checked for free identifiers,
    // so the build stayed green while the browser threw a ReferenceError
    // (intermittent Nuxt 500) and the links fell back to a localhost origin.
    // This guard reads the SFC source and fails if a used name is unimported.
    const { readFileSync } = await import('node:fs');
    const vue = readFileSync(new URL('../pages/my/[token].vue', import.meta.url), 'utf8');
    const core = readFileSync(new URL('../core/utils/user-center.ts', import.meta.url), 'utf8');
    const exported = new Set(
      [...core.matchAll(/export (?:function|const|type|interface) (\w+)/g)].map((m) => m[1]!),
    );
    const fromIdx = vue.indexOf("from '~/core/utils/user-center';");
    const startIdx = vue.lastIndexOf('import {', fromIdx);
    const importBlock = fromIdx > startIdx && startIdx >= 0
      ? vue.slice(startIdx + 'import {'.length, vue.lastIndexOf('}', fromIdx))
      : '';
    const imported = new Set(
      importBlock.split(',').map((part) => part.trim().replace(/^type\s+/, '')).filter(Boolean),
    );
    const missing = [...exported].filter(
      (name) => new RegExp(`\\b${name}\\b`).test(vue) && !imported.has(name),
    );
    expect(missing).toEqual([]);
  });
});
