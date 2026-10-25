<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Dashboard: counters, quick actions, source health and the latest visits.
 *
 * - Stat cards come from GET /api/admin/stats (link targets unchanged).
 * - 快捷操作 jumps to the pages with their create form already open (`?new=1`).
 * - 源健康 lists sources that failed their last refresh or never refreshed
 *   (`lastError` set / no `lastOkAt`), name + error summary, linking to /sources.
 *   The sources are fetched with `useAsyncData`, so they are ready for the
 *   server-rendered HTML and the first client paint (`$fetch` inside
 *   `onMounted` left the card empty — and "所有订阅源状态正常" — until hydration
 *   finished, which is how it showed all-healthy with 16 failing sources).
 *   The fetch goes through `useRequestFetch()` so the SSR request carries the
 *   admin cookie (a bare `$fetch` is anonymous on the server); the client still
 *   refreshes once after hydration for fresh numbers. A client-side error never
 *   blanks an existing list, and loading / error / empty / healthy / unhealthy
 *   come from `sourceHealthCard`, so an empty list is never "all healthy".
 * - 最近访问 shows the latest 5 access log rows (GET /api/admin/logs).
 *
 * Stats and logs are the primary data; sources/logs are best-effort, so a
 * failure there only empties that card instead of breaking the page.
 */
definePageMeta({ layout: 'admin' });

import { NAlert, NButton, NCard, NIcon, NTag } from 'naive-ui';
import type { AdminStats } from '~/server/utils/admin-stats';
import type { AdminSource } from '~/server/utils/admin-sources';
import type { AdminAccessLog } from '~/server/utils/admin-logs';
import { apiErrorMessage } from '~/core/utils/api-error';
import {
  formatDateTime,
  latestLogs,
  logStatusClass,
  logUserName,
  relativeTime,
  sourceHealthCard,
} from '~/core/utils/admin-ui';

const stats = ref<AdminStats | null>(null);
const loading = ref(true);
const error = ref('');

const logs = ref<AdminAccessLog[]>([]);
const logsError = ref('');

type CardKey = keyof AdminStats;

const cards: Array<{ key: CardKey; label: string; hint: string; to: string }> = [
  { key: 'users', label: '用户', hint: '查看用户列表', to: '/users' },
  { key: 'sources', label: '订阅源', hint: '管理订阅源', to: '/sources' },
  { key: 'profiles', label: '规则档', hint: '管理规则档', to: '/profiles' },
  { key: 'accessLogs24h', label: '24h 访问', hint: '查看访问日志', to: '/logs' },
];

function cardIcon(key: CardKey): string {
  if (key === 'users') return 'users';
  if (key === 'sources') return 'rss';
  if (key === 'profiles') return 'layers';
  return 'list';
}

function logType(status: number | null): 'success' | 'warning' | 'error' | 'default' {
  const cls = logStatusClass(status);
  if (cls.includes('bad')) return 'error';
  if (cls.includes('warn')) return 'warning';
  if (cls.includes('on')) return 'success';
  return 'default';
}

const quickActions = [
  { label: '新建用户', to: '/users?new=1' },
  { label: '新建订阅源', to: '/sources?new=1' },
  { label: '新建规则档', to: '/profiles?new=1' },
];

// SSR-fetched: the 源健康 card never starts from an empty list. The server
// render cannot see the admin session cookie, so the client fetches again once
// after hydration.
//
// A *client* failure is deliberately non-destructive: showing a "load failed"
// banner over an empty card is noise (the card must keep saying "loading" until
// it has data), and a stale non-empty list is better than blanking the card.
// Only the SSR-less first load can surface an error, and only if it produced
// no data at all.
// `useRequestFetch()` (not the bare `$fetch`) so the admin session cookie is
// forwarded to the API during the server render; otherwise every SSR request
// is anonymous and the card could only ever start in its loading state.
const requestFetch = useRequestFetch();

const {
  data: sourceData,
  pending: sourcesLoading,
  error: sourcesFetchError,
  refresh: refreshSources,
} = await useAsyncData('dashboard-sources', () =>
  requestFetch<{ items: AdminSource[] }>('/api/admin/sources'),
);

/**
 * A client refresh ran (after hydration). It always decides the final state:
 * before it there is either SSR data or nothing.
 */
const sourcesChecked = ref(false);

const sources = computed<AdminSource[]>(() => sourceData.value?.items ?? []);
const sourcesError = computed(() => {
  // A stale list is shown as-is; a hard failure with no data is reported.
  if (sources.value.length > 0) return '';
  return sourcesFetchError.value ? apiErrorMessage(sourcesFetchError.value) : '';
});

const health = computed(() =>
  sourceHealthCard(sources.value, {
    // Loading until the client has a real answer (SSR data or a refresh).
    loading: sourcesLoading.value || !sourcesChecked.value,
    error: sourcesError.value,
  }),
);

const recent = computed(() => latestLogs(logs.value, 5));

function display(key: CardKey): string {
  if (loading.value) return '…';
  if (error.value) return '—';
  return String(stats.value?.[key] ?? 0);
}

async function loadStats() {
  loading.value = true;
  error.value = '';
  try {
    stats.value = await $fetch<AdminStats>('/api/admin/stats');
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

/** Re-fetch the sources (used by the retry link when the card is in error). */
async function retrySources() {
  await refreshSources();
}

async function loadLogs() {
  logsError.value = '';
  try {
    const res = await $fetch<{ items: AdminAccessLog[] }>('/api/admin/logs', {
      query: { limit: '20', offset: '0' },
    });
    logs.value = res.items;
  } catch (err) {
    logs.value = [];
    logsError.value = apiErrorMessage(err);
  }
}

onMounted(async () => {
  loadStats();
  loadLogs();
  try {
    // Refresh once after hydration so a tab left open overnight shows current
    // health (the SSR payload only reflects the initial render).
    await refreshSources();
  } finally {
    sourcesChecked.value = true;
  }
});
</script>

<template>
  <section class="page">
    <PageTopbar title="仪表盘" subtitle="概览、常见操作与需要关注的订阅源" />
    <n-alert v-if="error" type="error" :bordered="false" role="alert">
      统计数据加载失败：{{ error }}
    </n-alert>

    <div class="cards">
      <NuxtLink v-for="card in cards" :key="card.key" class="stat-link" :to="card.to">
        <n-card class="stat" hoverable>
          <div class="stat-head">
            <span class="stat-icon" aria-hidden="true">
              <NavIcon :name="cardIcon(card.key)" />
            </span>
            <span class="label">{{ card.label }}</span>
          </div>
          <div class="value">{{ display(card.key) }}</div>
          <span class="hint">
            {{ card.hint }}
            <NavIcon name="chevron-right" />
          </span>
        </n-card>
      </NuxtLink>
    </div>

    <div class="panels">
      <n-card class="panel" title="快捷操作">
        <div class="quick-actions">
          <n-button
            v-for="action in quickActions"
            :key="action.to"
            class="quick-action"
            secondary
            block
            @click="navigateTo(action.to)"
          >
            <template #icon>
              <n-icon><NavIcon name="plus" /></n-icon>
            </template>
            {{ action.label }}
          </n-button>
        </div>
      </n-card>

      <n-card class="panel">
        <template #header>
          <div class="panel-title">
            <span>源健康</span>
            <n-tag size="small" :type="health.state === 'unhealthy' ? 'error' : 'default'">
              {{ health.count }}
            </n-tag>
          </div>
        </template>
        <template #header-extra>
          <NuxtLink class="sub" to="/sources">全部订阅源 →</NuxtLink>
        </template>
        <n-alert v-if="health.state === 'error'" type="error" :bordered="false" role="alert">
          <div class="alert-row">
            <span>订阅源加载失败：{{ health.error }}</span>
            <n-button size="small" secondary @click="retrySources">重试</n-button>
          </div>
        </n-alert>
        <p v-else-if="health.state === 'loading'" class="muted sub">正在加载订阅源…</p>
        <p v-else-if="health.state === 'empty'" class="muted sub">暂无订阅源。</p>
        <p v-else-if="health.state === 'healthy'" class="muted sub">所有订阅源状态正常。</p>
        <ul v-else class="health-list">
          <li v-for="source in health.sources" :key="source.id">
            <n-tag size="small" round :type="source.lastError ? 'error' : 'warning'">
              {{ source.lastError ? '失败' : '未刷新' }}
            </n-tag>
            <span class="health-name" :title="source.name">{{ source.name }}</span>
            <span class="sub health-detail" :title="source.lastError ?? '尚未成功刷新过'">
              {{ source.lastError ?? '尚未成功刷新过' }}
            </span>
          </li>
        </ul>
      </n-card>

      <n-card class="panel">
        <template #header>最近访问</template>
        <template #header-extra>
          <NuxtLink class="sub" to="/logs">全部日志 →</NuxtLink>
        </template>
        <n-alert v-if="logsError" type="error" :bordered="false" role="alert">
          日志加载失败：{{ logsError }}
        </n-alert>
        <p v-else-if="recent.length === 0" class="muted sub">暂无访问记录。</p>
        <ul v-else class="visit-list">
          <li v-for="log in recent" :key="log.id">
            <n-tag size="small" round :type="logType(log.status)">{{ log.status ?? '—' }}</n-tag>
            <span class="visit-user" :title="logUserName(log)">{{ logUserName(log) }}</span>
            <span class="sub visit-target">{{ log.target ?? '—' }}</span>
            <span class="sub visit-time" :title="formatDateTime(log.createdAt)">
              {{ relativeTime(log.createdAt) }}
            </span>
          </li>
        </ul>
      </n-card>
    </div>
  </section>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  gap: var(--space-4);
}

.stat-link {
  color: inherit;
  text-decoration: none;
}

.stat-link:hover {
  color: inherit;
}

.stat :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.stat-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.stat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.9rem;
  height: 1.9rem;
  border: 1px solid rgba(37, 99, 235, 0.18);
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--primary);
}

.label {
  font-size: var(--text-sm);
  color: var(--muted-foreground);
  font-weight: 500;
}

.value {
  font-family: var(--font-mono);
  font-size: var(--text-2xl);
  font-weight: 500;
  line-height: 1.2;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}

.hint {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-1);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
  font-size: var(--text-xs);
  color: var(--muted-foreground);
}

.stat:hover .hint {
  color: var(--primary);
}

.panels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: var(--space-4);
  align-items: start;
}

.panel {
  min-width: 0;
}

.panel-title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.alert-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.quick-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.quick-action {
  justify-content: flex-start;
}

.health-list,
.visit-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.health-list li,
.visit-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
}

.health-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.health-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
  text-align: right;
}

.visit-user {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.visit-target {
  margin-left: auto;
  font-family: var(--font-mono);
}

.visit-time {
  white-space: nowrap;
  min-width: 4.5rem;
  text-align: right;
}

@media (max-width: 640px) {
  .health-list li,
  .visit-list li {
    flex-wrap: wrap;
  }

  .health-detail,
  .visit-target {
    margin-left: 0;
    text-align: left;
    width: 100%;
  }
}
</style>
