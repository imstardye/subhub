<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Access log: paged table over GET /api/admin/logs, newest first.
 *
 * Filters (`userId`, `status`) and paging (`limit` / `offset`) are applied
 * server-side; "上一页"/"下一页" move by one page and the total decides whether
 * "下一页" is offered.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' });

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
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <form class="card form" @submit.prevent="applyFilters">
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

    <p v-if="loading && !loaded" class="muted">加载中…</p>
    <p v-else-if="loaded && items.length === 0" class="muted">暂无日志。</p>

    <table v-else-if="items.length > 0" class="list">
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
          <td>{{ log.id }}</td>
          <td class="nowrap">{{ formatTime(log.createdAt) }}</td>
          <td>{{ userName(log) }}</td>
          <td>{{ log.target ?? '—' }}</td>
          <td class="mono">{{ log.ip ?? '—' }}</td>
          <td>{{ log.status ?? '—' }}</td>
          <td>{{ log.ms === null ? '—' : `${log.ms} ms` }}</td>
          <td class="ua" :title="log.ua ?? ''">{{ log.ua ?? '—' }}</td>
        </tr>
      </tbody>
    </table>

    <div class="pager">
      <span class="muted">共 {{ total }} 条 · 第 {{ offset + 1 }}–{{ Math.min(offset + PAGE_SIZE, total) }} 条</span>
      <div class="actions">
        <button type="button" :disabled="!hasPrev || loading" @click="prevPage">上一页</button>
        <button type="button" :disabled="!hasNext || loading" @click="nextPage">下一页</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h1 {
  margin: 0;
  font-size: 1.3rem;
}
.card {
  padding: 1rem;
  background: #fff;
  border: 1px solid #e1e6ec;
  border-radius: 10px;
}
.form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
}
.form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
  min-width: 10rem;
}
input,
select {
  padding: 0.45rem 0.55rem;
  border: 1px solid #cfd7e0;
  border-radius: 6px;
  background: #fff;
  font: inherit;
}
.actions {
  display: flex;
  gap: 0.5rem;
}
button {
  padding: 0.45rem 0.8rem;
  border: 1px solid #d3dae2;
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
button.primary {
  border-color: #2f6feb;
  background: #2f6feb;
  color: #fff;
}
.list {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.list th,
.list td {
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid #e1e6ec;
  text-align: left;
  vertical-align: top;
}
.list th {
  color: #6b7785;
  font-weight: 600;
}
.nowrap {
  white-space: nowrap;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}
.ua {
  max-width: 18rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.error {
  margin: 0;
  color: #c0392b;
  font-size: 0.9rem;
}
.muted {
  margin: 0;
  color: #6b7785;
}
</style>
