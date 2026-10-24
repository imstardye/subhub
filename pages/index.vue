<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Dashboard: real counters from GET /api/admin/stats.
 *
 * Shows users / sources / rule profiles and the access-log volume of the last
 * 24 hours. Values render as `…` while loading; a failed request shows an
 * error line but keeps the cards (with `—`) so the layout stays stable.
 */
definePageMeta({ layout: 'admin' });

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
  <section class="page">
    <header class="page-head">
      <h1>仪表盘</h1>
    </header>
    <p v-if="error" class="error" role="alert">统计数据加载失败：{{ error }}</p>
    <div class="cards">
      <article v-for="card in cards" :key="card.key" class="card stat">
        <div class="stat-head">
          <span class="stat-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <template v-if="card.key === 'users'">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </template>
              <template v-else-if="card.key === 'sources'">
                <path d="M4 11a9 9 0 0 1 9 9" />
                <path d="M4 4a16 16 0 0 1 16 16" />
                <circle cx="5" cy="19" r="1" />
              </template>
              <template v-else-if="card.key === 'profiles'">
                <path d="m12 2 9 5-9 5-9-5 9-5Z" />
                <path d="m3 12 9 5 9-5" />
                <path d="m3 17 9 5 9-5" />
              </template>
              <template v-else>
                <path d="M3 3v16a2 2 0 0 0 2 2h16" />
                <path d="m7 15 4-4 3 3 5-6" />
              </template>
            </svg>
          </span>
          <span class="label">{{ card.label }}</span>
        </div>
        <div class="value">{{ display(card.key) }}</div>
        <NuxtLink class="hint" :to="card.to">
          {{ card.hint }}
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14" />
            <path d="m12 5 7 7-7 7" />
          </svg>
        </NuxtLink>
      </article>
    </div>
  </section>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
  gap: var(--space-4);
}
.stat {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
  transition:
    border-color var(--transition),
    box-shadow var(--transition),
    transform var(--transition);
}
.stat:hover {
  border-color: var(--muted-foreground);
  box-shadow: var(--shadow-md);
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
.stat-icon svg {
  width: 1rem;
  height: 1rem;
  stroke: currentColor;
  stroke-width: 1.75;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
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
  text-decoration: none;
  cursor: pointer;
  transition: color var(--transition-fast);
}
.hint svg {
  width: 0.85rem;
  height: 0.85rem;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform var(--transition-fast);
}
.hint:hover {
  color: var(--primary);
}
.hint:hover svg {
  transform: translateX(2px);
}
</style>
