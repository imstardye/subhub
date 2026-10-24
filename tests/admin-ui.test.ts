// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers behind the redesigned admin pages (core/utils/admin-ui.ts).
 *
 * No DOM is installed, so page behaviour that matters (grouping, status,
 * ownership payloads, counts, log chips, time labels) is asserted here on the
 * helpers the pages call.
 */
import { describe, expect, it } from 'vitest';
import {
  accessSummary,
  allowedUserNames,
  buildOwnershipPayload,
  formatDateTime,
  groupSources,
  iniSummary,
  latestLogs,
  logStatusClass,
  logUserName,
  maskToken,
  ownershipFromSource,
  profileUsers,
  relativeTime,
  SOURCE_HEALTH_LABELS,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  sourceHealth,
  sourceHealthCard,
  sourceKind,
  subscriptionUrl,
  truncate,
  unhealthySources,
  userNameResolver,
  userSourceCounts,
} from '../core/utils/admin-ui';

type Source = {
  id: number;
  name: string;
  ownerUserId: number | null;
  accessMode: 'all' | 'restricted';
  allowedUserIds: number[];
  lastOkAt: string | null;
  lastError: string | null;
};

function source(overrides: Partial<Source> & { id: number }): Source {
  return {
    name: `source-${overrides.id}`,
    ownerUserId: null,
    accessMode: 'all',
    allowedUserIds: [],
    lastOkAt: null,
    lastError: null,
    ...overrides,
  };
}

describe('source kind and grouping', () => {
  it('classifies the three kinds (owner wins over accessMode)', () => {
    expect(sourceKind({ ownerUserId: null, accessMode: 'all' })).toBe('public');
    expect(sourceKind({ ownerUserId: null, accessMode: 'restricted' })).toBe('shared');
    expect(sourceKind({ ownerUserId: 3, accessMode: 'all' })).toBe('dedicated');
    // A dedicated source never reports restricted, but the owner still wins.
    expect(sourceKind({ ownerUserId: 3, accessMode: 'restricted' })).toBe('dedicated');
  });

  it('has Chinese labels for every kind, in display order', () => {
    expect(SOURCE_KINDS).toEqual(['public', 'shared', 'dedicated']);
    expect(SOURCE_KIND_LABELS).toEqual({
      public: '公共源',
      shared: '共享源',
      dedicated: '专属源',
    });
  });

  it('groups by kind, ordered by id inside each group', () => {
    const groups = groupSources([
      source({ id: 5 }),
      source({ id: 3, accessMode: 'restricted' }),
      source({ id: 1 }),
      source({ id: 4, ownerUserId: 7 }),
      source({ id: 2, accessMode: 'restricted' }),
    ]);
    expect(groups.public.map((s) => s.id)).toEqual([1, 5]);
    expect(groups.shared.map((s) => s.id)).toEqual([2, 3]);
    expect(groups.dedicated.map((s) => s.id)).toEqual([4]);
  });

  it('summarises 归属 as 公共 / 共享·N 人 / 专属·用户名', () => {
    const name = userNameResolver([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ]);
    expect(accessSummary({ ownerUserId: null, accessMode: 'all' }, name)).toBe('公共');
    expect(
      accessSummary({ ownerUserId: null, accessMode: 'restricted', allowedUserIds: [1, 2] }, name),
    ).toBe('共享·2 人');
    expect(
      accessSummary({ ownerUserId: null, accessMode: 'restricted', allowedUserIds: [] }, name),
    ).toBe('共享·0 人');
    expect(accessSummary({ ownerUserId: 1, accessMode: 'all' }, name)).toBe('专属·alice');
    // Unknown ids fall back to a readable placeholder, never blank.
    expect(accessSummary({ ownerUserId: 9, accessMode: 'all' }, name)).toBe('专属·用户 #9');
  });

  it('resolves allowlist names with a placeholder for unknown ids', () => {
    const name = userNameResolver([{ id: 1, name: 'alice' }]);
    expect(allowedUserNames({ allowedUserIds: [1, 9] }, name)).toEqual(['alice', '用户 #9']);
    expect(allowedUserNames({ allowedUserIds: [] }, name)).toEqual([]);
  });
});

describe('source health', () => {
  it('is failed when lastError is set, ok after a success, never before any refresh', () => {
    expect(sourceHealth({ lastOkAt: null, lastError: null })).toBe('never');
    expect(sourceHealth({ lastOkAt: '2026-01-01T00:00:00.000Z', lastError: null })).toBe('ok');
    expect(sourceHealth({ lastOkAt: '2026-01-01T00:00:00.000Z', lastError: 'boom' })).toBe('failed');
    expect(sourceHealth({ lastOkAt: null, lastError: 'boom' })).toBe('failed');
    expect(SOURCE_HEALTH_LABELS).toEqual({ ok: '正常', failed: '失败', never: '未刷新' });
  });

  it('lists only unhealthy sources, failures first, then by id', () => {
    const list = unhealthySources([
      source({ id: 1, lastOkAt: '2026-01-01T00:00:00.000Z' }),
      source({ id: 4 }),
      source({ id: 3, lastError: 'timeout' }),
      source({ id: 2, lastOkAt: null, lastError: null }),
      source({ id: 5, lastError: 'dns' }),
    ]);
    expect(list.map((s) => s.id)).toEqual([3, 5, 2, 4]);
  });
});

describe('dashboard source-health card', () => {
  it('is never "healthy" before the source list has loaded', () => {
    // Regression: the card rendered from an empty list while the request was
    // still in flight (and in the server-rendered HTML) and claimed
    // "所有订阅源状态正常。" while 16 sources had lastError set.
    expect(sourceHealthCard([], { loading: true })).toEqual({ state: 'loading', count: 0, sources: [] });
    expect(sourceHealthCard(null, { loading: true })).toEqual({ state: 'loading', count: 0, sources: [] });
    // Not loading, but no data either (SSR default / not yet assigned).
    expect(sourceHealthCard(undefined).state).toBe('loading');
  });

  it('reports a fetch failure instead of an empty healthy list', () => {
    const card = sourceHealthCard([], { error: '订阅源加载失败' });
    expect(card).toEqual({ state: 'error', count: 0, sources: [], error: '订阅源加载失败' });
    // Even a stale, non-empty list is not reported as healthy on error.
    expect(sourceHealthCard([source({ id: 1 })], { error: 'boom' }).state).toBe('error');
    // Whitespace-only errors are not errors.
    expect(sourceHealthCard([], { error: '   ' }).state).toBe('empty');
  });

  it('says "no sources" for a loaded empty list, not "all healthy"', () => {
    expect(sourceHealthCard([])).toEqual({ state: 'empty', count: 0, sources: [] });
    expect(sourceHealthCard([], { loading: false, error: '' })).toEqual({
      state: 'empty',
      count: 0,
      sources: [],
    });
  });

  it('keeps the all-healthy state when nothing is unhealthy', () => {
    const card = sourceHealthCard([
      source({ id: 1, lastOkAt: '2026-01-01T00:00:00.000Z' }),
      source({ id: 2, lastOkAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(card).toEqual({ state: 'healthy', count: 0, sources: [] });
  });

  it('shows the count and the failing sources with their error', () => {
    const failing = Array.from({ length: 16 }, (_, index) =>
      source({ id: index + 1, lastError: 'HTTP 502' }),
    );
    const card = sourceHealthCard([
      ...failing,
      source({ id: 100, lastOkAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(card.state).toBe('unhealthy');
    expect(card.count).toBe(16);
    expect(card.sources).toHaveLength(16);
    expect(card.sources[0]).toEqual({ id: 1, name: 'source-1', lastError: 'HTTP 502' });
  });

  it('counts never-refreshed sources and keeps failures first', () => {
    const card = sourceHealthCard([
      source({ id: 1 }),
      source({ id: 2, lastError: 'timeout' }),
      source({ id: 3, lastOkAt: '2026-01-01T00:00:00.000Z' }),
      source({ id: 4, lastOkAt: '2026-01-01T00:00:00.000Z', lastError: 'still broken' }),
    ]);
    expect(card.state).toBe('unhealthy');
    expect(card.count).toBe(3);
    expect(card.sources).toEqual([
      { id: 2, name: 'source-2', lastError: 'timeout' },
      { id: 4, name: 'source-4', lastError: 'still broken' },
      { id: 1, name: 'source-1', lastError: null },
    ]);
  });

  it('keeps a previously loaded list visible (count + errors) while refreshing', () => {
    // Refetching must not flash "loading"/"healthy": the last known failures
    // stay on screen until new data replaces them.
    const card = sourceHealthCard(
      [source({ id: 1, lastError: 'HTTP 502' }), source({ id: 2, lastError: 'dns' })],
      { loading: true },
    );
    expect(card.state).toBe('unhealthy');
    expect(card.count).toBe(2);
  });
});

describe('time labels', () => {
  it('formats absolute times and degrades gracefully', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('not a date')).toBe('not a date');
    const formatted = formatDateTime(new Date(2026, 9, 24, 9, 5).toISOString());
    expect(formatted).toBe('2026-10-24 09:05');
  });

  it('uses relative labels up to a day, then the absolute time', () => {
    const now = Date.parse('2026-10-24T12:00:00.000Z');
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime(new Date(now - 5_000).toISOString(), now)).toBe('刚刚');
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 分钟前');
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 小时前');
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe(
      formatDateTime(new Date(now - 2 * 86_400_000).toISOString()),
    );
  });
});

describe('subscription link helpers', () => {
  it('masks a token for dense rows without losing the ends', () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(maskToken(token)).toBe('a1b2c3d4…8f90');
    expect(maskToken('short')).toBe('short');
  });

  it('builds the public export URL with and without a target', () => {
    expect(subscriptionUrl('https://hub.example.com', 'tok')).toBe('https://hub.example.com/s/tok');
    expect(subscriptionUrl('https://hub.example.com/', 'tok', 'mihomo')).toBe(
      'https://hub.example.com/s/tok/mihomo',
    );
  });
});

describe('users hub counts', () => {
  const sources: Source[] = [
    source({ id: 1 }), // public: not "theirs"
    source({ id: 2, ownerUserId: 7 }), // alice's dedicated
    source({ id: 3, accessMode: 'restricted', allowedUserIds: [7, 8] }),
    source({ id: 4, accessMode: 'restricted', allowedUserIds: [8] }),
    source({ id: 5, accessMode: 'restricted', allowedUserIds: [] }),
  ];

  it('counts 专属 sources owned and 共享 sources the user is allowlisted for', () => {
    expect(userSourceCounts(sources, 7)).toEqual({ dedicated: 1, shared: 1 });
    expect(userSourceCounts(sources, 8)).toEqual({ dedicated: 0, shared: 2 });
    expect(userSourceCounts(sources, 99)).toEqual({ dedicated: 0, shared: 0 });
  });

  it('does not count a dedicated source as shared for its owner', () => {
    expect(
      userSourceCounts([source({ id: 1, ownerUserId: 7, allowedUserIds: [7] })], 7),
    ).toEqual({ dedicated: 1, shared: 0 });
  });
});

describe('source form ownership payload', () => {
  it('builds 公共: no owner, accessMode all, empty list', () => {
    expect(buildOwnershipPayload('public', '', [])).toEqual({
      ok: true,
      payload: { ownerUserId: null, accessMode: 'all', allowedUserIds: [] },
    });
  });

  it('builds 共享: deduped, sorted allowlist and ignores a stray owner', () => {
    expect(buildOwnershipPayload('shared', '7', [3, '3', 1, 2])).toEqual({
      ok: true,
      payload: { ownerUserId: null, accessMode: 'restricted', allowedUserIds: [1, 2, 3] },
    });
    expect(buildOwnershipPayload('shared', '', [])).toEqual({
      ok: true,
      payload: { ownerUserId: null, accessMode: 'restricted', allowedUserIds: [] },
    });
  });

  it('builds 专属: the selected owner and no allowlist', () => {
    expect(buildOwnershipPayload('dedicated', '7', [1])).toEqual({
      ok: true,
      payload: { ownerUserId: 7, accessMode: 'all', allowedUserIds: [] },
    });
  });

  it('refuses 专属 without a user instead of sending a bad id', () => {
    for (const owner of ['', '0', '-1', 'abc', '1.5']) {
      expect(buildOwnershipPayload('dedicated', owner, [])).toEqual({
        ok: false,
        error: '请选择专属用户',
      });
    }
  });

  it('seeds the radio group from the stored source', () => {
    expect(ownershipFromSource({ ownerUserId: null, accessMode: 'all' })).toBe('public');
    expect(ownershipFromSource({ ownerUserId: null, accessMode: 'restricted' })).toBe('shared');
    expect(ownershipFromSource({ ownerUserId: 4, accessMode: 'all' })).toBe('dedicated');
  });
});

describe('logs', () => {
  it('colours status chips by class', () => {
    expect(logStatusClass(200)).toBe('badge on');
    expect(logStatusClass(204)).toBe('badge on');
    expect(logStatusClass(400)).toBe('badge warn');
    expect(logStatusClass(429)).toBe('badge warn');
    expect(logStatusClass(500)).toBe('badge bad');
    expect(logStatusClass(503)).toBe('badge bad');
    expect(logStatusClass(null)).toBe('badge off');
  });

  it('names deleted users by id and anonymous rows with a dash', () => {
    expect(logUserName({ userId: null, userName: null })).toBe('—');
    expect(logUserName({ userId: 3, userName: null })).toBe('(已删除 #3)');
    expect(logUserName({ userId: 3, userName: 'alice' })).toBe('alice');
  });

  it('takes the latest N rows newest first', () => {
    const logs = [1, 2, 3, 4, 5, 6, 7].map((id) => ({
      id,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, id)).toISOString(),
    }));
    expect(latestLogs(logs, 5).map((log) => log.id)).toEqual([7, 6, 5, 4, 3]);
    expect(latestLogs([], 5)).toEqual([]);
  });
});

describe('profiles', () => {
  it('summarises the INI source', () => {
    expect(iniSummary({ iniUrl: 'https://example.com/r.ini', iniText: null })).toBe(
      'https://example.com/r.ini',
    );
    expect(iniSummary({ iniUrl: null, iniText: 'abcde' })).toBe('内联 5 字符');
    expect(iniSummary({ iniUrl: 'https://example.com/r.ini', iniText: 'abc' })).toBe(
      'https://example.com/r.ini + 内联 3 字符',
    );
    expect(iniSummary({})).toBe('—');
  });

  it('lists users referencing a profile by name', () => {
    const users = [
      { id: 1, name: 'alice', profileId: 2 },
      { id: 2, name: 'bob', profileId: null },
      { id: 3, name: 'carol', profileId: 2 },
    ];
    expect(profileUsers(users, 2).map((u) => u.name)).toEqual(['alice', 'carol']);
    expect(profileUsers(users, 9)).toEqual([]);
  });

  it('truncates long values with an ellipsis', () => {
    expect(truncate('abc', 10)).toBe('abc');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});
