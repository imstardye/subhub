<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Subscription preview: pick a user and a target, render the export server-side
 * via POST /api/admin/preview and show the body.
 *
 * The preview bypasses the public /s/:token path: no token needed for a
 * disabled user, no rate limit, no access log line. Bodies above ~200 KiB come
 * back truncated (`truncated: true`).
 */
definePageMeta({ layout: 'admin' });

import type { AdminUser } from '~/server/utils/admin-users';
import { EXPORT_TARGETS, type ExportTarget } from '~/server/utils/targets';

interface PreviewResponse {
  userId: number;
  name: string;
  enabled: boolean;
  target: ExportTarget;
  status: number;
  contentType: string;
  body: string;
  truncated?: boolean;
}

const users = ref<AdminUser[]>([]);
const loadingUsers = ref(false);
const generating = ref(false);
const error = ref('');
const notice = ref('');

const selectedUserId = ref<string>('');
const target = ref<ExportTarget>('mihomo');
const result = ref<PreviewResponse | null>(null);

const targetOptions = [...EXPORT_TARGETS];

function errorMessage(err: unknown): string {
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error) return data.error;
  return '请求失败，请稍后再试';
}

async function loadUsers() {
  loadingUsers.value = true;
  error.value = '';
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
    if (selectedUserId.value === '' && res.items.length > 0) {
      selectedUserId.value = String(res.items[0]!.id);
    }
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loadingUsers.value = false;
  }
}

async function generate() {
  if (generating.value) return;
  error.value = '';
  notice.value = '';
  if (!selectedUserId.value) {
    error.value = '请选择用户';
    return;
  }
  generating.value = true;
  try {
    const res = await $fetch<PreviewResponse>('/api/admin/preview', {
      method: 'POST',
      body: { userId: Number(selectedUserId.value), target: target.value },
    });
    result.value = res;
    notice.value = res.truncated ? '预览内容过大，已截断到约 200KB' : '预览已生成';
  } catch (err) {
    result.value = null;
    error.value = errorMessage(err);
  } finally {
    generating.value = false;
  }
}

onMounted(loadUsers);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>预览</h1>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form class="card form" @submit.prevent="generate">
      <label>
        用户
        <select v-model="selectedUserId" :disabled="loadingUsers || generating">
          <option v-if="users.length === 0" value="" disabled>
            {{ loadingUsers ? '加载中…' : '暂无用户' }}
          </option>
          <option v-for="user in users" :key="user.id" :value="String(user.id)">
            #{{ user.id }} {{ user.name }}{{ user.enabled ? '' : '（已停用）' }}
          </option>
        </select>
      </label>
      <label>
        输出目标
        <select v-model="target" :disabled="generating">
          <option v-for="item in targetOptions" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <div class="actions">
        <button class="primary" type="submit" :disabled="generating || loadingUsers">
          {{ generating ? '生成中…' : '生成' }}
        </button>
      </div>
    </form>

    <div v-if="result" class="card result">
      <div class="result-head">
        <h2>用户 #{{ result.userId }} · {{ result.name }}</h2>
        <span :class="['badge', result.enabled ? 'on' : 'off']">
          {{ result.enabled ? '启用' : '停用' }}
        </span>
        <span class="meta">target: {{ result.target }}</span>
        <span class="meta">status: {{ result.status }}</span>
        <span class="meta">{{ result.contentType }}</span>
        <span v-if="result.truncated" class="badge warn">已截断</span>
      </div>
      <pre class="body"><code>{{ result.body }}</code></pre>
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
h2 {
  margin: 0;
  font-size: 1rem;
}
.card {
  padding: 1rem;
  background: #fff;
  border: 1px solid #e1e6ec;
  border-radius: 10px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  max-width: 32rem;
}
.form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.9rem;
}
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
.result {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.result-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.meta {
  color: #6b7785;
  font-size: 0.85rem;
}
.body {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  padding: 0.75rem;
  background: #f6f8fa;
  border: 1px solid #e1e6ec;
  border-radius: 8px;
  font-size: 0.8rem;
  line-height: 1.45;
  white-space: pre;
}
.badge {
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.8rem;
}
.badge.on {
  background: #e6f4ea;
  color: #1e7a3c;
}
.badge.off {
  background: #f0f0f0;
  color: #6b7785;
}
.badge.warn {
  background: #fff4e5;
  color: #9a5b00;
}
.error {
  margin: 0;
  color: #c0392b;
  font-size: 0.9rem;
}
.notice {
  margin: 0;
  color: #1e7a3c;
  font-size: 0.9rem;
}
</style>
