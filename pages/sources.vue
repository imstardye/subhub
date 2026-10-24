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
 * - 专属（单个用户）: only the selected owner (a `<select>`, never typed ids).
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
const error = ref('');
const notice = ref('');

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<SourceForm>(emptyForm());

const deleting = ref<AdminSource | null>(null);

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

function summary(source: AdminSource): string {
  return accessSummary(source, userName.value);
}

function healthLabel(source: AdminSource): string {
  return SOURCE_HEALTH_LABELS[sourceHealth(source)];
}

function healthClass(source: AdminSource): string {
  const health = sourceHealth(source);
  if (health === 'ok') return 'badge on';
  if (health === 'failed') return 'badge bad';
  return 'badge off';
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
  error.value = '';
  try {
    const res = await $fetch<{ items: AdminSource[] }>('/api/admin/sources');
    sources.value = res.items;
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
  await loadUsers();
}

function openCreate(ownership: SourceOwnership = 'public') {
  editingId.value = null;
  form.value = { ...emptyForm(), ownership };
  formOpen.value = true;
  error.value = '';
  notice.value = '';
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
  error.value = '';
  notice.value = '';
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
  error.value = '';
  notice.value = '';
  const name = form.value.name.trim();
  const url = form.value.url.trim();
  if (!name) {
    error.value = '请填写名称';
    return;
  }
  if (editingId.value === null && !url) {
    error.value = '新建订阅源必须填写 URL';
    return;
  }
  if (url && !validUrl(url)) {
    error.value = 'URL 必须是 http 或 https 地址';
    return;
  }
  const refreshMinutes = Number(form.value.refreshMinutes);
  if (!Number.isInteger(refreshMinutes)) {
    error.value = '刷新间隔必须是整数分钟';
    return;
  }

  const ownership = buildOwnershipPayload(
    form.value.ownership,
    form.value.ownerUserId,
    form.value.allowedUserIds,
  );
  if (!ownership.ok) {
    error.value = ownership.error;
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
      notice.value = '订阅源已创建';
    } else {
      const res = await $fetch<{ item: AdminSource }>(`/api/admin/sources/${editingId.value}`, {
        method: 'PATCH',
        body,
      });
      sources.value = sources.value.map((s) => (s.id === res.item.id ? res.item : s));
      notice.value = '订阅源已更新';
    }
    closeForm();
  } catch (err) {
    error.value = apiErrorMessage(err);
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
  error.value = '';
  notice.value = '';
  try {
    const res = await $fetch<{
      item: AdminSource;
      outcome: 'refreshed' | 'skipped' | 'failed';
      error?: string;
    }>(`/api/admin/sources/${source.id}/refresh`, { method: 'POST' });
    sources.value = sources.value.map((s) => (s.id === res.item.id ? res.item : s));
    if (res.outcome === 'refreshed' && !res.item.lastError) {
      notice.value = `已刷新订阅源「${res.item.name}」`;
    } else {
      error.value = `「${res.item.name}」刷新失败：${res.item.lastError ?? res.error ?? '未知原因'}`;
    }
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busyId.value = null;
  }
}

async function confirmDelete() {
  const source = deleting.value;
  if (!source || busyId.value !== null) return;
  busyId.value = source.id;
  error.value = '';
  notice.value = '';
  try {
    await $fetch(`/api/admin/sources/${source.id}`, { method: 'DELETE' });
    sources.value = sources.value.filter((s) => s.id !== source.id);
    notice.value = `已删除订阅源「${source.name}」`;
    if (editingId.value === source.id) closeForm();
    deleting.value = null;
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busyId.value = null;
  }
}

onMounted(() => {
  if (route.query.new !== undefined) openCreate();
  load();
});
</script>

<template>
  <section class="page">
    <PageTopbar title="订阅源" subtitle="按公共 / 共享 / 专属分组，状态一眼可见">
      <button class="primary" type="button" @click="openCreate()">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建订阅源
      </button>
    </PageTopbar>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form
      v-if="formOpen"
      id="source-form"
      class="card form"
      @submit.prevent="submitForm"
    >
      <h2>{{ editingId === null ? '新建订阅源' : `编辑订阅源「${sources.find((s) => s.id === editingId)?.name ?? ''}」` }}</h2>
      <label>
        名称
        <input
          v-model="form.name"
          type="text"
          maxlength="100"
          required
          autocomplete="off"
          :disabled="saving"
        >
      </label>
      <label>
        URL
        <input
          v-model="form.url"
          type="url"
          inputmode="url"
          autocomplete="off"
          :required="editingId === null"
          :placeholder="editingId === null ? 'https://example.com/sub?token=…' : '留空表示不修改'"
          :disabled="saving"
        >
      </label>

      <fieldset class="radio-group">
        <legend>归属</legend>
        <label
          v-for="option in ownershipOptions"
          :key="option.value"
          class="radio-option"
        >
          <input
            v-model="form.ownership"
            type="radio"
            name="ownership"
            :value="option.value"
            :disabled="saving"
          >
          {{ option.label }}
        </label>
      </fieldset>

      <div v-if="form.ownership === 'shared'" class="ownership-panel">
        <label class="inline">
          <span>允许访问的用户（{{ form.allowedUserIds.length }} 人）</span>
        </label>
        <p v-if="usersError" class="sub">{{ usersError }}</p>
        <p v-else-if="users.length === 0" class="sub">暂无用户，请先在「用户」页创建。</p>
        <div v-else class="check-list">
          <label v-for="user in users" :key="user.id">
            <input
              type="checkbox"
              :checked="form.allowedUserIds.includes(user.id)"
              :disabled="saving"
              @change="toggleAllowed(user.id, ($event.target as HTMLInputElement).checked)"
            >
            {{ user.name }}
            <span v-if="!user.enabled" class="sub">（已停用）</span>
          </label>
        </div>
      </div>

      <label v-if="form.ownership === 'dedicated'">
        专属用户
        <select v-model="form.ownerUserId" :disabled="saving || users.length === 0">
          <option value="" disabled>请选择用户</option>
          <option v-for="user in users" :key="user.id" :value="String(user.id)">
            {{ user.name }}
          </option>
        </select>
        <span v-if="usersError" class="sub">{{ usersError }}</span>
      </label>

      <p class="hint">{{ ownershipHint }}</p>

      <label>
        类型
        <select v-model="form.type" :disabled="saving">
          <option value="remote">remote（定时拉取）</option>
          <option value="local">local（仅用缓存）</option>
        </select>
      </label>
      <label>
        刷新间隔（分钟）
        <select v-model="form.refreshMinutes" :disabled="saving">
          <option value="5">5 分钟</option>
          <option value="15">15 分钟</option>
          <option value="30">30 分钟</option>
          <option value="60">1 小时</option>
          <option value="180">3 小时</option>
          <option value="720">12 小时</option>
          <option value="1440">1 天</option>
          <option v-if="!refreshPreset" :value="form.refreshMinutes">
            {{ form.refreshMinutes }} 分钟（当前）
          </option>
        </select>
      </label>
      <label>
        User-Agent（可选）
        <input v-model="form.ua" type="text" maxlength="256" :disabled="saving">
      </label>
      <div class="actions">
        <button class="primary" type="submit" :disabled="saving">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button type="button" :disabled="saving" @click="closeForm">取消</button>
      </div>
    </form>

    <p v-if="loading" class="muted empty">加载中…</p>
    <p v-else-if="sources.length === 0" class="muted empty">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 11a9 9 0 0 1 9 9" />
        <path d="M4 4a16 16 0 0 1 16 16" />
        <circle cx="5" cy="19" r="1" />
      </svg>
      暂无订阅源，点击右上角「新建订阅源」开始。
    </p>

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
            <span class="chip-count">{{ groups[kind as SourceKind].length }}</span>
          </h2>
          <span class="sub kind-hint">
            <template v-if="kind === 'public'">所有用户都会获得</template>
            <template v-else-if="kind === 'shared'">仅名单内的用户会获得</template>
            <template v-else>仅专属用户会获得</template>
          </span>
        </div>

        <p v-if="groups[kind as SourceKind].length === 0" class="muted sub empty-row">
          暂无{{ SOURCE_KIND_LABELS[kind as SourceKind] }}。
        </p>

        <div v-else class="rows">
          <article
            v-for="source in groups[kind as SourceKind]"
            :key="source.id"
            class="entity"
          >
            <div class="entity-identity">
              <div class="entity-name">
                <span :title="source.name">{{ source.name }}</span>
                <span :class="healthClass(source)">
                  {{ healthLabel(source) }}
                </span>
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
              <span
                :class="['badge', kind === 'public' ? 'off' : 'info']"
                :title="kind === 'shared' ? allowlistTitle(source) : summary(source)"
              >
                {{ summary(source) }}
              </span>
            </div>

            <div class="entity-actions">
              <button
                type="button"
                class="small"
                :disabled="busyId !== null"
                :title="source.type === 'local' ? '本地订阅源没有可拉取的 URL，仅更新状态' : '立即拉取并更新缓存'"
                @click="refreshOne(source)"
              >
                {{ busyId === source.id ? '刷新中…' : '刷新' }}
              </button>
              <button type="button" class="small" :disabled="busyId !== null" @click="openEdit(source)">
                编辑
              </button>
              <button
                type="button"
                class="small danger"
                :disabled="busyId !== null"
                @click="deleting = source"
              >
                删除
              </button>
            </div>
          </article>
        </div>
      </section>
    </template>

    <div v-if="deleting" class="overlay" role="dialog" aria-modal="true" aria-labelledby="delete-source-title">
      <div class="card dialog">
        <h2 id="delete-source-title">删除订阅源</h2>
        <p>确定删除「{{ deleting.name }}」？相关缓存与允许名单将一并移除。</p>
        <div class="actions">
          <button class="danger" type="button" :disabled="busyId !== null" @click="confirmDelete">
            {{ busyId === deleting.id ? '删除中…' : '确认删除' }}
          </button>
          <button type="button" :disabled="busyId !== null" @click="deleting = null">取消</button>
        </div>
      </div>
    </div>
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
  margin: 0;
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

.ownership-panel > label.inline {
  font-size: var(--text-sm);
}

@media (max-width: 640px) {
  .kind-hint {
    text-align: left;
  }

  .url,
  .err {
    max-width: 100%;
  }
}
</style>
