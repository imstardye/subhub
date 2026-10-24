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
import { apiErrorMessage } from '~/core/utils/api-error';
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
    error.value = apiErrorMessage(err);
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
    error.value = apiErrorMessage(err);
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
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m5 3 14 9-14 9V3Z" />
          </svg>
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
.form {
  max-width: 32rem;
}
.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}
.result > h2 {
  padding-bottom: 0;
  border-bottom: none;
}
.result-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}
.body {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  padding: var(--space-4);
  background: var(--subtle);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
  white-space: pre;
  tab-size: 2;
}
</style>
