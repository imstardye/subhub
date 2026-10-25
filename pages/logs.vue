<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Access log: dense paged table over GET /api/admin/logs, newest first.
 *
 * Filters (`userId`, `status`) and paging (`limit` / `offset`) are applied
 * server-side; "上一页"/"下一页" move by one page and the total decides whether
 * "下一页" is offered. Users are picked by name and the status by a select —
 * no typed ids/codes. Status codes render as coloured chips
 * (2xx green / 4xx amber / 5xx red).
 */
definePageMeta({ layout: 'admin' });

import { NAlert, NButton, NDataTable, NEmpty, NForm, NFormItem, NIcon, NSelect, NSpin, NTag, type DataTableColumns } from 'naive-ui';
import { h } from 'vue';
import type { AdminAccessLog } from '~/server/utils/admin-logs';
import { apiErrorMessage } from '~/core/utils/api-error';
import type { AdminUser } from '~/server/utils/admin-users';
import { formatDateTime, logStatusClass, logUserName } from '~/core/utils/admin-ui';

interface LogsResponse {
  items: AdminAccessLog[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 50;

const users = ref<AdminUser[]>([]);
const items = ref<AdminAccessLog[]>([]);
const total = ref(0);
const offset = ref(0);
const loading = ref(false);
const loadError = ref('');
const loaded = ref(false);

const filterUserId = ref<string>('');
const filterStatus = ref<string>('');

const hasPrev = computed(() => offset.value > 0);
const hasNext = computed(() => offset.value + PAGE_SIZE < total.value);

/** Status filter choices (the API takes the numeric code). */
const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: '200', label: '200 成功' },
  { value: '400', label: '400 未知目标' },
  { value: '404', label: '404 未找到' },
  { value: '429', label: '429 限流' },
  { value: '500', label: '500 服务器错误' },
];

async function loadUsers() {
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
  } catch {
    // The filter just offers ids when the list is unavailable.
  }
}

const userOptions = computed(() => [
  { label: '全部用户', value: '' },
  ...users.value.map((user) => ({ label: user.name, value: String(user.id) })),
]);

const statusOptions = STATUS_FILTERS;

function statusType(status: number | null): 'success' | 'warning' | 'error' | 'default' {
  const cls = logStatusClass(status);
  if (cls.includes('bad')) return 'error';
  if (cls.includes('warn')) return 'warning';
  if (cls.includes('on')) return 'success';
  return 'default';
}

const columns = computed<DataTableColumns<AdminAccessLog>>(() => [
  {
    title: 'ID',
    key: 'id',
    render: (row) => h('span', { class: 'mono cell-muted' }, row.id),
  },
  {
    title: '时间',
    key: 'createdAt',
    render: (row) => h('span', { class: 'mono cell-muted nowrap' }, formatDateTime(row.createdAt)),
  },
  {
    title: '用户',
    key: 'userId',
    render: (row) => logUserName(row),
  },
  {
    title: 'target',
    key: 'target',
    render: (row) => h('span', { class: 'mono' }, row.target ?? '—'),
  },
  {
    title: 'IP',
    key: 'ip',
    render: (row) => h('span', { class: 'mono' }, row.ip ?? '—'),
  },
  {
    title: '状态',
    key: 'status',
    render: (row) =>
      h(
        NTag,
        { size: 'small', round: true, type: statusType(row.status) },
        { default: () => row.status ?? '—' },
      ),
  },
  {
    title: '耗时',
    key: 'ms',
    render: (row) => h('span', { class: 'mono nowrap' }, row.ms === null ? '—' : `${row.ms} ms`),
  },
  {
    title: 'UA',
    key: 'ua',
    render: (row) => h('span', { class: 'mono ua', title: row.ua ?? '' }, row.ua ?? '—'),
  },
]);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const query: Record<string, string> = {
      limit: String(PAGE_SIZE),
      offset: String(offset.value),
    };
    if (filterUserId.value) query.userId = filterUserId.value;
    if (filterStatus.value) query.status = filterStatus.value;
    const res = await $fetch<LogsResponse>('/api/admin/logs', { query });
    items.value = res.items;
    total.value = res.total;
    loaded.value = true;
  } catch (err) {
    loadError.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  offset.value = 0;
  load();
}

function resetFilters() {
  filterUserId.value = '';
  filterStatus.value = '';
  applyFilters();
}

function prevPage() {
  if (!hasPrev.value || loading.value) return;
  offset.value = Math.max(0, offset.value - PAGE_SIZE);
  load();
}

function nextPage() {
  if (!hasNext.value || loading.value) return;
  offset.value += PAGE_SIZE;
  load();
}

onMounted(() => {
  loadUsers();
  load();
});
</script>

<template>
  <section class="page">
    <PageTopbar title="访问日志" subtitle="订阅访问记录，最新在前">
      <n-button secondary :loading="loading" @click="load">
        <template #icon>
          <n-icon><NavIcon name="refresh" /></n-icon>
        </template>
        {{ loading ? '刷新中…' : '刷新' }}
      </n-button>
    </PageTopbar>

    <n-alert v-if="loadError" type="error" :bordered="false" role="alert">{{ loadError }}</n-alert>

    <n-form class="card form filters" @submit.prevent="applyFilters">
      <n-form-item label="用户" :show-feedback="false">
        <n-select v-model:value="filterUserId" :options="userOptions" :disabled="loading" />
      </n-form-item>
      <n-form-item label="状态码" :show-feedback="false">
        <n-select v-model:value="filterStatus" :options="statusOptions" :disabled="loading" />
      </n-form-item>
      <div class="actions">
        <n-button type="primary" attr-type="submit" :disabled="loading">筛选</n-button>
        <n-button :disabled="loading" @click="resetFilters">重置</n-button>
      </div>
    </n-form>

    <n-spin v-if="loading && !loaded" size="small" class="loading-state">
      <span class="muted">加载中…</span>
    </n-spin>
    <n-empty v-else-if="loaded && items.length === 0" description="暂无日志。" class="empty" />

    <n-data-table
      v-else-if="items.length > 0"
      :columns="columns"
      :data="items"
      :loading="loading"
      :pagination="false"
      :bordered="false"
      :single-line="false"
      :scroll-x="920"
      size="small"
    />

    <div class="pager">
      <span class="muted">共 {{ total }} 条 · 第 {{ offset + 1 }}–{{ Math.min(offset + PAGE_SIZE, total) }} 条</span>
      <div class="actions">
        <n-button secondary :disabled="!hasPrev || loading" @click="prevPage">
          <template #icon>
            <n-icon><NavIcon name="chevron-left" /></n-icon>
          </template>
          上一页
        </n-button>
        <n-button secondary :disabled="!hasNext || loading" @click="nextPage">
          下一页
          <template #icon>
            <n-icon><NavIcon name="chevron-right" /></n-icon>
          </template>
        </n-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.filters {
  flex-direction: row;
  align-items: flex-end;
  gap: var(--space-4);
  max-width: none;
}

.filters :deep(.n-form-item) {
  width: 12rem;
}

.filters .actions {
  padding-bottom: 1px;
}

.cell-muted {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
}

.ua {
  display: inline-block;
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  vertical-align: bottom;
}

.loading-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.empty {
  padding: var(--space-8) 0;
}

.pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--text-sm);
}

@media (max-width: 640px) {
  .filters {
    flex-direction: column;
    align-items: stretch;
  }

  .filters :deep(.n-form-item) {
    width: 100%;
  }

  .pager {
    justify-content: flex-start;
  }
}
</style>
