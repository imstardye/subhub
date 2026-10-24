<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Dashboard: real counters from GET /api/admin/stats.
 *
 * Shows users / sources / rule profiles and the access-log volume of the last
 * 24 hours. Values render as `…` while loading; a failed request shows an
 * error line but keeps the cards (with `—`) so the layout stays stable.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' });

import type { AdminStats } from '~/server/utils/admin-stats';

const stats = ref<AdminStats | null>(null);
const loading = ref(true);
const error = ref('');

type CardKey = keyof AdminStats;

const cards: Array<{ key: CardKey; label: string; hint: string; to: string }> = [
  { key: 'users', label: '用户', hint: '查看用户列表', to: '/users' },
  { key: 'sources', label: '订阅源', hint: '管理订阅源', to: '/sources' },
  { key: 'profiles', label: '规则档', hint: '管理规则档', to: '/profiles' },
  { key: 'accessLogs24h', label: '24h 访问', hint: '查看访问日志', to: '/logs' },
];

function errorMessage(err: unknown): string {
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error) return data.error;
  return '请求失败，请稍后再试';
}

function display(key: CardKey): string {
  if (loading.value) return '…';
  if (error.value) return '—';
  return String(stats.value?.[key] ?? 0);
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    stats.value = await $fetch<AdminStats>('/api/admin/stats');
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <h1>仪表盘</h1>
    <p v-if="error" class="error" role="alert">统计数据加载失败：{{ error }}</p>
    <div class="cards">
      <article v-for="card in cards" :key="card.key" class="card">
        <div class="label">{{ card.label }}</div>
        <div class="value">{{ display(card.key) }}</div>
        <NuxtLink class="hint" :to="card.to">{{ card.hint }} →</NuxtLink>
      </article>
    </div>
  </section>
</template>

<style scoped>
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.4rem;
}
.error {
  margin: 0 0 1rem;
  color: #b42318;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 1rem;
}
.card {
  padding: 1rem;
  background: #fff;
  border: 1px solid #e1e6ec;
  border-radius: 8px;
}
.label {
  font-size: 0.85rem;
  color: #6b7785;
}
.value {
  margin: 0.25rem 0;
  font-size: 1.5rem;
  font-weight: 600;
}
.hint {
  font-size: 0.8rem;
  color: #6b7785;
}
.hint:hover {
  color: #1d4ed8;
}
</style>
