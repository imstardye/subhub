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
import { NButton, NCard, NForm, NFormItem, NIcon, NSelect, NTag, useMessage } from 'naive-ui';
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
const message = useMessage();

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

const targetOptions = EXPORT_TARGETS.map((item) => ({ label: item, value: item }));

const userOptions = computed(() =>
  users.value.map((user) => ({
    label: `${user.name}${user.enabled ? '' : '（已停用）'}`,
    value: String(user.id),
  })),
);

/** Query preselects the user (`/preview?userId=3`), e.g. from the users hub. */
const route = useRoute();

async function loadUsers() {
  loadingUsers.value = true;
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
    message.error(apiErrorMessage(err));
  } finally {
    loadingUsers.value = false;
  }
}

async function generate() {
  if (generating.value) return;
  copied.value = false;
  if (!selectedUserId.value) {
    message.error('请选择用户');
    return;
  }
  generating.value = true;
  try {
    const res = await $fetch<PreviewResponse>('/api/admin/preview', {
      method: 'POST',
      body: { userId: Number(selectedUserId.value), target: target.value },
    });
    result.value = res;
    message.success(res.truncated ? '预览内容过大，已截断到约 200KB' : '预览已生成');
  } catch (err) {
    result.value = null;
    message.error(apiErrorMessage(err));
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
    message.error('复制失败，请手动选择内容');
  }
}

onMounted(loadUsers);
</script>

<template>
  <section class="page">
    <PageTopbar title="预览" subtitle="按用户渲染订阅输出，无需 token" />

    <n-form class="card form inline-form" @submit.prevent="generate">
      <n-form-item label="用户" :show-feedback="false">
        <n-select
          v-model:value="selectedUserId"
          :options="userOptions"
          :disabled="loadingUsers || generating"
          :placeholder="loadingUsers ? '加载中…' : '暂无用户'"
        />
      </n-form-item>
      <n-form-item label="输出目标" :show-feedback="false">
        <n-select v-model:value="target" :options="targetOptions" :disabled="generating" />
      </n-form-item>
      <div class="actions">
        <n-button type="primary" attr-type="submit" :loading="generating" :disabled="loadingUsers">
          <template #icon>
            <n-icon><NavIcon name="play" /></n-icon>
          </template>
          {{ generating ? '生成中…' : '生成' }}
        </n-button>
      </div>
    </n-form>

    <n-card v-if="result" class="result">
      <template #header>
        <div class="result-title">
          <span>{{ result.name }}</span>
          <n-tag size="small" round :type="result.enabled ? 'success' : 'default'">
            {{ result.enabled ? '启用' : '停用' }}
          </n-tag>
          <n-tag v-if="result.truncated" size="small" round type="warning">已截断</n-tag>
        </div>
      </template>
      <template #header-extra>
        <div class="actions">
          <span class="meta">{{ result.target }} · {{ result.status }}</span>
          <n-tag v-if="shown.decoded" size="small" round>已解码分享链接</n-tag>
          <n-button size="small" secondary @click="copyResult">
            {{ copied ? '已复制' : '复制结果' }}
          </n-button>
        </div>
      </template>
      <pre class="body"><code>{{ shown.text }}</code></pre>
    </n-card>
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

.inline-form :deep(.n-form-item) {
  width: 14rem;
}

.inline-form .actions {
  padding-bottom: 1px;
}

.result {
  min-width: 0;
}

.result-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-md);
  font-weight: 600;
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

  .inline-form :deep(.n-form-item) {
    width: 100%;
  }
}
</style>
