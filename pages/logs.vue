<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Access log: paged table over GET /api/admin/logs, newest first.
 *
 * Filters (`userId`, `status`) and paging (`limit` / `offset`) are applied
 * server-side; "上一页"/"下一页" move by one page and the total decides whether
 * "下一页" is offered.
 */
definePageMeta({ layout: 'admin' });

import type { AdminAccessLog } from '~/server/utils/admin-logs';
import type { AdminUser } from '~/server/utils/admin-users';

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
const error = ref('');
const loaded = ref(false);

const filterUserId = ref<string>('');
const filterStatus = ref<string>('');

const hasPrev = computed(() => offset.value > 0);
const hasNext = computed(() => offset.value + PAGE_SIZE < total.value);

function errorMessage(err: unknown): string {
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error) return data.error;
  return '请求失败，请稍后再试';
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function userName(log: AdminAccessLog): string {
  // The log keeps userId after the user is deleted; the name is then null.
  if (log.userId === null) return '—';
  return log.userName ?? `(已删除 #${log.userId})`;
}

async function loadUsers() {
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
  } catch {
    // The filter just offers ids when the list is unavailable.
  }
}

async function load() {
  loading.value = true;
  error.value = '';
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
    error.value = errorMessage(err);
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
    <header class="page-head">
      <h1>访问日志</h1>
      <button type="button" :disabled="loading" @click="load">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form class="card form filters" @submit.prevent="applyFilters">
      <label>
        用户
        <select v-model="filterUserId" :disabled="loading">
          <option value="">全部用户</option>
          <option v-for="user in users" :key="user.id" :value="String(user.id)">
            #{{ user.id }} {{ user.name }}
          </option>
        </select>
      </label>
      <label>
        状态码
        <input v-model="filterStatus" type="number" min="100" max="599" step="1" placeholder="全部" :disabled="loading">
      </label>
      <div class="actions">
        <button class="primary" type="submit" :disabled="loading">筛选</button>
        <button type="button" :disabled="loading" @click="resetFilters">重置</button>
      </div>
    </form>

    <p v-if="loading && !loaded" class="muted empty">加载中…</p>
    <p v-else-if="loaded && items.length === 0" class="muted empty">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 6h13" />
        <path d="M8 12h13" />
        <path d="M8 18h13" />
        <path d="M3 6h.01" />
        <path d="M3 12h.01" />
        <path d="M3 18h.01" />
      </svg>
      暂无日志。
    </p>

    <div v-else-if="items.length > 0" class="table-wrap">
      <table class="list">
        <thead>
          <tr>
            <th>ID</th>
            <th>时间</th>
            <th>用户</th>
            <th>target</th>
            <th>IP</th>
            <th>状态</th>
            <th>耗时</th>
            <th>UA</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in items" :key="log.id">
            <td class="id-cell">{{ log.id }}</td>
            <td class="nowrap log-time">{{ formatTime(log.createdAt) }}</td>
            <td>{{ userName(log) }}</td>
            <td class="mono">{{ log.target ?? '—' }}</td>
            <td class="mono">{{ log.ip ?? '—' }}</td>
            <td class="mono status-cell">{{ log.status ?? '—' }}</td>
            <td class="mono nowrap">{{ log.ms === null ? '—' : `${log.ms} ms` }}</td>
            <td class="ua" :title="log.ua ?? ''">{{ log.ua ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <span class="muted">共 {{ total }} 条 · 第 {{ offset + 1 }}–{{ Math.min(offset + PAGE_SIZE, total) }} 条</span>
      <div class="actions">
        <button type="button" :disabled="!hasPrev || loading" @click="prevPage">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          上一页
        </button>
        <button type="button" :disabled="!hasNext || loading" @click="nextPage">
          下一页
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
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
.filters label {
  width: 12rem;
  align-self: flex-end;
}
.filters .actions {
  padding-bottom: 1px;
}
.id-cell {
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.log-time {
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.status-cell {
  font-variant-numeric: tabular-nums;
}
.ua {
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
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

  .filters label {
    width: 100%;
    align-self: stretch;
  }

  .pager {
    justify-content: flex-start;
  }
}
</style>
