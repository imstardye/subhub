<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Subscription sources admin page: three groups (公共源 / 共享源 / 专属源).
 *
 * The API never returns the plaintext URL — only `urlMasked` — so this page
 * never stores, echoes or caches an entered URL beyond the create/edit form
 * (cleared as soon as the request settles). When editing, leaving the URL field
 * empty means "keep the stored URL unchanged".
 *
 * Access model v2:
 * - 公共（所有用户）: every user gets it;
 * - 共享（指定用户）: only the checked users (a checkbox list, never typed ids);
 * - 专属（单个用户）: only the selected owner (a select, never typed ids).
 *
 * Each row shows status at a glance (正常 / 失败 + lastError / 未刷新), the last
 * successful refresh and a 归属 summary, plus 刷新 / 编辑 / 删除.
 *
 * `?new=1` opens the create form (dashboard 快捷操作).
 */
definePageMeta({ layout: 'admin' });

import type { AdminSource } from '~/server/utils/admin-sources';
import type { AdminUser } from '~/server/utils/admin-users';
import type { SourceType } from '~/server/utils/admin-validation';
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NForm, NFormItem, NIcon, NInput, NRadio, NRadioGroup, NSelect, NSpin, NTag, useDialog, useMessage } from 'naive-ui';
import { apiErrorMessage } from '~/core/utils/api-error';
import {
  accessSummary,
  allowedUserNames,
  buildOwnershipPayload,
  formatDateTime,
  groupSources,
  ownershipFromSource,
  SOURCE_HEALTH_LABELS,
  SOURCE_KIND_LABELS,
  SOURCE_KINDS,
  sourceHealth,
  userNameResolver,
  type SourceKind,
  type SourceOwnership,
} from '~/core/utils/admin-ui';

type SourceForm = {
  name: string;
  type: SourceType;
  url: string;
  ua: string;
  refreshMinutes: string;
  ownership: SourceOwnership;
  /** Owner id as a string ('' = not chosen); only for 专属. */
  ownerUserId: string;
  /** Checked user ids; only for 共享. */
  allowedUserIds: number[];
};

const route = useRoute();
const sources = ref<AdminSource[]>([]);
const users = ref<AdminUser[]>([]);
const usersError = ref('');
const loading = ref(false);
const saving = ref(false);
const busyId = ref<number | null>(null);
const loadError = ref('');
const message = useMessage();
const dialog = useDialog();

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<SourceForm>(emptyForm());

function emptyForm(): SourceForm {
  return {
    name: '',
    type: 'remote',
    url: '',
    ua: '',
    refreshMinutes: '60',
    ownership: 'public',
    ownerUserId: '',
    allowedUserIds: [],
  };
}

const userName = computed(() => userNameResolver(users.value));
const groups = computed(() => groupSources(sources.value));

const ownershipOptions: Array<{ value: SourceOwnership; label: string; hint: string }> = [
  { value: 'public', label: '公共（所有用户）', hint: '所有用户的订阅都会包含此源。' },
  { value: 'shared', label: '共享（指定用户）', hint: '只有勾选的用户会获得此源。' },
  { value: 'dedicated', label: '专属（单个用户）', hint: '只有该用户的订阅包含此源。' },
];

/** The select offers presets; an existing custom interval is shown as-is. */
const refreshPreset = computed(() =>
  ['5', '15', '30', '60', '180', '720', '1440'].includes(form.value.refreshMinutes),
);

const ownershipHint = computed(
  () => ownershipOptions.find((option) => option.value === form.value.ownership)?.hint ?? '',
);

const refreshOptions = computed(() => {
  const options = [
    { label: '5 分钟', value: '5' },
    { label: '15 分钟', value: '15' },
    { label: '30 分钟', value: '30' },
    { label: '1 小时', value: '60' },
    { label: '3 小时', value: '180' },
    { label: '12 小时', value: '720' },
    { label: '1 天', value: '1440' },
  ];
  if (!refreshPreset.value) {
    options.push({ label: `${form.value.refreshMinutes} 分钟（当前）`, value: form.value.refreshMinutes });
  }
  return options;
});

const typeOptions = [
  { label: 'remote（定时拉取）', value: 'remote' },
  { label: 'local（仅用缓存）', value: 'local' },
];

const userOptions = computed(() =>
  users.value.map((user) => ({ label: user.name, value: String(user.id) })),
);

function summary(source: AdminSource): string {
  return accessSummary(source, userName.value);
}

function healthLabel(source: AdminSource): string {
  return SOURCE_HEALTH_LABELS[sourceHealth(source)];
}

function healthType(source: AdminSource): 'success' | 'error' | 'default' {
  const health = sourceHealth(source);
  if (health === 'ok') return 'success';
  if (health === 'failed') return 'error';
  return 'default';
}

function allowlistTitle(source: AdminSource): string {
  const names = allowedUserNames(source, userName.value);
  return names.length > 0 ? names.join('、') : '允许名单为空：当前没有用户能获得此源';
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function loadUsers() {
  usersError.value = '';
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
  } catch (err) {
    users.value = [];
    usersError.value = `用户列表加载失败：${apiErrorMessage(err)}`;
  }
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await $fetch<{ items: AdminSource[] }>('/api/admin/sources');
    sources.value = res.items;
  } catch (err) {
    loadError.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
  await loadUsers();
}

function openCreate(ownership: SourceOwnership = 'public') {
  editingId.value = null;
  form.value = { ...emptyForm(), ownership };
  formOpen.value = true;
  if (import.meta.client) {
    nextTick(() => {
      document.getElementById('source-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function openEdit(source: AdminSource) {
  editingId.value = source.id;
  form.value = {
    name: source.name,
    type: source.type,
    // Never prefill: the plaintext URL is not available to the client.
    url: '',
    ua: source.ua ?? '',
    refreshMinutes: String(source.refreshMinutes),
    ownership: ownershipFromSource(source),
    ownerUserId: source.ownerUserId === null ? '' : String(source.ownerUserId),
    allowedUserIds: [...(source.allowedUserIds ?? [])],
  };
  formOpen.value = true;
  if (import.meta.client) {
    nextTick(() => {
      document.getElementById('source-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function closeForm() {
  formOpen.value = false;
  editingId.value = null;
  form.value = emptyForm();
}

/** Checkbox list binding for the 共享 allowlist. */
function toggleAllowed(userId: number, checked: boolean) {
  const current = new Set(form.value.allowedUserIds);
  if (checked) current.add(userId);
  else current.delete(userId);
  form.value.allowedUserIds = [...current].sort((a, b) => a - b);
}

async function submitForm() {
  if (saving.value) return;
  const name = form.value.name.trim();
  const url = form.value.url.trim();
  if (!name) {
    message.error('请填写名称');
    return;
  }
  if (editingId.value === null && !url) {
    message.error('新建订阅源必须填写 URL');
    return;
  }
  if (url && !validUrl(url)) {
    message.error('URL 必须是 http 或 https 地址');
    return;
  }
  const refreshMinutes = Number(form.value.refreshMinutes);
  if (!Number.isInteger(refreshMinutes)) {
    message.error('刷新间隔必须是整数分钟');
    return;
  }

  const ownership = buildOwnershipPayload(
    form.value.ownership,
    form.value.ownerUserId,
    form.value.allowedUserIds,
  );
  if (!ownership.ok) {
    message.error(ownership.error);
    return;
  }

  const body: Record<string, unknown> = {
    name,
    type: form.value.type,
    ua: form.value.ua.trim() || null,
    refreshMinutes,
    ...ownership.payload,
  };
  // Only send `url` when the user actually typed one; omit it when editing so
  // the stored ciphertext is left untouched.
  if (url) body.url = url;

  saving.value = true;
  try {
    if (editingId.value === null) {
      const res = await $fetch<{ item: AdminSource }>('/api/admin/sources', {
        method: 'POST',
        body,
      });
      sources.value = [...sources.value, res.item];
      message.success('订阅源已创建');
    } else {
      const res = await $fetch<{ item: AdminSource }>(`/api/admin/sources/${editingId.value}`, {
        method: 'PATCH',
        body,
      });
      sources.value = sources.value.map((s) => (s.id === res.item.id ? res.item : s));
      message.success('订阅源已更新');
    }
    closeForm();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    // Drop any URL the user typed, successful or not.
    form.value.url = '';
    saving.value = false;
  }
}

/**
 * Manually refresh one source's cache. Reuses the scheduled task's fetch/parse
 * code path; a `local` source or a failed fetch answers 200 with
 * `outcome: 'failed'` and the source's `lastError`, shown as a banner.
 */
async function refreshOne(source: AdminSource) {
  if (busyId.value !== null) return;
  busyId.value = source.id;
  try {
    const res = await $fetch<{
      item: AdminSource;
      outcome: 'refreshed' | 'skipped' | 'failed';
      error?: string;
    }>(`/api/admin/sources/${source.id}/refresh`, { method: 'POST' });
    sources.value = sources.value.map((s) => (s.id === res.item.id ? res.item : s));
    if (res.outcome === 'refreshed' && !res.item.lastError) {
      message.success(`已刷新订阅源「${res.item.name}」`);
    } else {
      message.error(`「${res.item.name}」刷新失败：${res.item.lastError ?? res.error ?? '未知原因'}`);
    }
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    busyId.value = null;
  }
}

async function confirmDelete(source: AdminSource) {
  if (busyId.value !== null) return;
  busyId.value = source.id;
  try {
    await $fetch(`/api/admin/sources/${source.id}`, { method: 'DELETE' });
    sources.value = sources.value.filter((s) => s.id !== source.id);
    message.success(`已删除订阅源「${source.name}」`);
    if (editingId.value === source.id) closeForm();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    busyId.value = null;
  }
}

function askDelete(source: AdminSource) {
  dialog.warning({
    title: '删除订阅源',
    content: `确定删除「${source.name}」？相关缓存与允许名单将一并移除。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: () => confirmDelete(source),
  });
}

onMounted(() => {
  if (route.query.new !== undefined) openCreate();
  load();
});
</script>

<template>
  <section class="page">
    <PageTopbar title="订阅源" subtitle="按公共 / 共享 / 专属分组，状态一眼可见">
      <n-button type="primary" @click="openCreate()">
        <template #icon>
          <n-icon><NavIcon name="plus" /></n-icon>
        </template>
        新建订阅源
      </n-button>
    </PageTopbar>

    <n-alert v-if="loadError" type="error" :bordered="false" role="alert">{{ loadError }}</n-alert>

    <n-form
      v-if="formOpen"
      id="source-form"
      class="card form"
      @submit.prevent="submitForm"
    >
      <h2>{{ editingId === null ? '新建订阅源' : `编辑订阅源「${sources.find((s) => s.id === editingId)?.name ?? ''}」` }}</h2>
      <n-form-item label="名称" :show-feedback="false">
        <n-input
          v-model:value="form.name"
          maxlength="100"
          autocomplete="off"
          :input-props="{ required: true }"
          :disabled="saving"
        />
      </n-form-item>
      <n-form-item label="URL" :show-feedback="false">
        <n-input
          v-model:value="form.url"
          type="text"
          inputmode="url"
          autocomplete="off"
          :placeholder="editingId === null ? 'https://example.com/sub?token=…' : '留空表示不修改'"
          :disabled="saving"
        />
      </n-form-item>

      <n-form-item label="归属" :show-feedback="false">
        <n-radio-group v-model:value="form.ownership" :disabled="saving">
          <n-radio
            v-for="option in ownershipOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </n-radio>
        </n-radio-group>
      </n-form-item>

      <div v-if="form.ownership === 'shared'" class="ownership-panel">
        <span class="field-label">允许访问的用户（{{ form.allowedUserIds.length }} 人）</span>
        <p v-if="usersError" class="sub">{{ usersError }}</p>
        <p v-else-if="users.length === 0" class="sub">暂无用户，请先在「用户」页创建。</p>
        <div v-else class="check-list">
          <n-checkbox
            v-for="user in users"
            :key="user.id"
            :checked="form.allowedUserIds.includes(user.id)"
            :disabled="saving"
            @update:checked="(checked) => toggleAllowed(user.id, checked)"
          >
            {{ user.name }}
            <span v-if="!user.enabled" class="sub">（已停用）</span>
          </n-checkbox>
        </div>
      </div>

      <n-form-item v-if="form.ownership === 'dedicated'" label="专属用户" :show-feedback="false">
        <n-select
          v-model:value="form.ownerUserId"
          :options="userOptions"
          :disabled="saving || users.length === 0"
          placeholder="请选择用户"
        />
      </n-form-item>
      <p v-if="form.ownership === 'dedicated' && usersError" class="sub">{{ usersError }}</p>

      <p class="hint">{{ ownershipHint }}</p>

      <n-form-item label="类型" :show-feedback="false">
        <n-select v-model:value="form.type" :options="typeOptions" :disabled="saving" />
      </n-form-item>
      <n-form-item label="刷新间隔（分钟）" :show-feedback="false">
        <n-select v-model:value="form.refreshMinutes" :options="refreshOptions" :disabled="saving" />
      </n-form-item>
      <n-form-item label="User-Agent（可选）" :show-feedback="false">
        <n-input v-model:value="form.ua" maxlength="256" :disabled="saving" />
      </n-form-item>
      <div class="actions">
        <n-button type="primary" attr-type="submit" :loading="saving">
          {{ saving ? '保存中…' : '保存' }}
        </n-button>
        <n-button :disabled="saving" @click="closeForm">取消</n-button>
      </div>
    </n-form>

    <div v-if="loading" class="empty">
      <n-spin size="small" />
      <span class="muted">加载中…</span>
    </div>
    <n-empty v-else-if="sources.length === 0" description="暂无订阅源，点击右上角「新建订阅源」开始。" class="empty" />

    <template v-else>
      <section
        v-for="kind in SOURCE_KINDS"
        :key="kind"
        class="source-group"
        :aria-labelledby="`group-${kind}`"
      >
        <div class="card-head">
          <h2 :id="`group-${kind}`">
            {{ SOURCE_KIND_LABELS[kind as SourceKind] }}
            <n-tag size="small">{{ groups[kind as SourceKind].length }}</n-tag>
          </h2>
          <span class="sub kind-hint">
            <template v-if="kind === 'public'">所有用户都会获得</template>
            <template v-else-if="kind === 'shared'">仅名单内的用户会获得</template>
            <template v-else>仅专属用户会获得</template>
          </span>
        </div>

        <n-empty
          v-if="groups[kind as SourceKind].length === 0"
          :description="`暂无${SOURCE_KIND_LABELS[kind as SourceKind]}。`"
          class="empty-row"
        />

        <div v-else class="rows">
          <n-card
            v-for="source in groups[kind as SourceKind]"
            :key="source.id"
            class="entity"
          >
            <div class="entity-layout">
              <div class="entity-identity">
                <div class="entity-name">
                  <span :title="source.name">{{ source.name }}</span>
                  <n-tag size="small" round :type="healthType(source)">
                    {{ healthLabel(source) }}
                  </n-tag>
                </div>
                <code class="mono url" :title="source.urlMasked">{{ source.urlMasked }}</code>
                <span v-if="source.lastError" class="sub err" :title="source.lastError">
                  {{ source.lastError }}
                </span>
              </div>

              <div class="entity-body">
                <span class="sub" :title="`${source.type} · 每 ${source.refreshMinutes} 分钟刷新`">
                  {{ source.type }} · {{ source.refreshMinutes }} 分钟
                </span>
                <span class="sub">上次成功 {{ formatDateTime(source.lastOkAt) }}</span>
                <n-tag
                  size="small"
                  :type="kind === 'public' ? 'default' : 'info'"
                  :title="kind === 'shared' ? allowlistTitle(source) : summary(source)"
                >
                  {{ summary(source) }}
                </n-tag>
              </div>

              <div class="entity-actions">
                <n-button
                  size="small"
                  secondary
                  :disabled="busyId !== null"
                  :title="source.type === 'local' ? '本地订阅源没有可拉取的 URL，仅更新状态' : '立即拉取并更新缓存'"
                  @click="refreshOne(source)"
                >
                  {{ busyId === source.id ? '刷新中…' : '刷新' }}
                </n-button>
                <n-button size="small" secondary :disabled="busyId !== null" @click="openEdit(source)">
                  编辑
                </n-button>
                <n-button
                  size="small"
                  secondary
                  type="error"
                  :disabled="busyId !== null"
                  @click="askDelete(source)"
                >
                  删除
                </n-button>
              </div>
            </div>
          </n-card>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.source-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.kind-hint {
  text-align: right;
}

.empty-row {
  padding: var(--space-3) var(--space-4);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
}

.url {
  display: block;
  max-width: 32rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
}

.err {
  max-width: 32rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--destructive);
}

.ownership-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field-label {
  color: var(--muted-foreground);
  font-size: var(--text-sm);
  font-weight: 500;
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 15rem;
  overflow-y: auto;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--card);
}

.entity-layout {
  display: grid;
  grid-template-columns: minmax(14rem, 1fr) minmax(0, 2fr) auto;
  gap: var(--space-3) var(--space-5);
  align-items: center;
}

.entity-identity {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.entity-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-base);
  font-weight: 600;
}

.entity-name > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entity-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
  min-width: 0;
  color: var(--muted-foreground);
  font-size: var(--text-xs);
}

.entity-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

@media (max-width: 900px) {
  .entity-layout {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .entity-body {
    grid-column: 1 / -1;
  }
}

@media (max-width: 640px) {
  .kind-hint {
    text-align: left;
  }

  .url,
  .err {
    max-width: 100%;
  }

  .entity-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-3);
  }

  .entity-body,
  .entity-actions {
    justify-content: flex-start;
  }

  .entity-actions :deep(.n-button) {
    flex: 1 1 auto;
  }
}
</style>
