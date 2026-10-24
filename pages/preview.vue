<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Subscription preview: pick a user BY NAME and a target, render the export
 * server-side via POST /api/admin/preview, copy the result.
 *
 * The preview bypasses the public /s/:token path: no token needed for a
 * disabled user, no rate limit, no access log line. Bodies above ~200 KiB come
 * back truncated (`truncated: true`).
 */
definePageMeta({ layout: 'admin' });

import type { AdminUser } from '~/server/utils/admin-users';
import { apiErrorMessage } from '~/core/utils/api-error';
import { previewBodyText } from '~/core/utils/admin-ui';
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
const copied = ref(false);

/**
 * Shadowrocket bodies are base64 share links; the page shows the decoded link
 * list (copy still uses the raw body, see `copyResult`).
 */
const shown = computed(() =>
  result.value
    ? previewBodyText(result.value.target, result.value.body, result.value.truncated === true)
    : { text: '', decoded: false },
);

const targetOptions = [...EXPORT_TARGETS];

/** Query preselects the user (`/preview?userId=3`), e.g. from the users hub. */
const route = useRoute();

async function loadUsers() {
  loadingUsers.value = true;
  error.value = '';
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
    const requested = String(route.query.userId ?? '');
    const match = res.items.find((user) => String(user.id) === requested);
    if (match) selectedUserId.value = String(match.id);
    else if (selectedUserId.value === '' && res.items.length > 0) {
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
  copied.value = false;
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

async function copyResult() {
  if (!result.value) return;
  try {
    // Always the raw export body, never the decoded preview text.
    await navigator.clipboard.writeText(result.value.body);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    error.value = '复制失败，请手动选择内容';
  }
}

onMounted(loadUsers);
</script>

<template>
  <section class="page">
    <PageTopbar title="预览" subtitle="按用户渲染订阅输出，无需 token" />

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form class="card form inline-form" @submit.prevent="generate">
      <label>
        用户
        <select v-model="selectedUserId" :disabled="loadingUsers || generating">
          <option v-if="users.length === 0" value="" disabled>
            {{ loadingUsers ? '加载中…' : '暂无用户' }}
          </option>
          <option v-for="user in users" :key="user.id" :value="String(user.id)">
            {{ user.name }}{{ user.enabled ? '' : '（已停用）' }}
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
      <div class="card-head">
        <h2>
          {{ result.name }}
          <span :class="['badge', result.enabled ? 'on' : 'off']">
            {{ result.enabled ? '启用' : '停用' }}
          </span>
          <span v-if="result.truncated" class="badge warn">已截断</span>
        </h2>
        <div class="actions">
          <span class="meta">{{ result.target }} · {{ result.status }}</span>
          <span v-if="shown.decoded" class="badge">已解码分享链接</span>
          <button type="button" class="small" @click="copyResult">
            {{ copied ? '已复制' : '复制结果' }}
          </button>
        </div>
      </div>
      <pre class="body"><code>{{ shown.text }}</code></pre>
    </div>
  </section>
</template>

<style scoped>
.inline-form {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-4);
  max-width: none;
}

.inline-form label {
  width: 14rem;
  align-self: flex-end;
}

.inline-form .actions {
  padding-bottom: 1px;
}

.result {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.result .card-head h2 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  border: none;
  padding: 0;
}

.body {
  margin: 0;
  max-height: 65vh;
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

@media (max-width: 640px) {
  .inline-form {
    flex-direction: column;
    align-items: stretch;
  }

  .inline-form label {
    width: 100%;
    align-self: stretch;
  }
}
</style>
