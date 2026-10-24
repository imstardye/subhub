<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Subscription sources admin page: list, create, edit and delete.
 *
 * The API never returns the plaintext URL — only `urlMasked` — so this page
 * never stores, echoes or caches an entered URL beyond the create/edit form
 * (which is cleared as soon as the request settles). When editing, leaving the
 * URL field empty means "keep the stored URL unchanged".
 *
 * Sharing model: a source is either 公共 (`ownerUserId` null, every user gets
 * it) or 专属 to one user. The form has an 归属 selector for this, the list
 * shows a badge with 公共 or the owner's name, and each row can be refreshed
 * on demand via POST /api/admin/sources/:id/refresh (same path as the
 * scheduled task).
 */
definePageMeta({ layout: 'admin' });

import type { AdminSource } from '~/server/utils/admin-sources';
import type { AdminUser } from '~/server/utils/admin-users';
import type { SourceType } from '~/server/utils/admin-validation';
import { apiErrorMessage } from '~/core/utils/api-error';

type SourceForm = {
  name: string;
  type: SourceType;
  url: string;
  ua: string;
  refreshMinutes: string;
  /** '' = 公共, otherwise the owning user id as a string. */
  ownerUserId: string;
};

const sources = ref<AdminSource[]>([]);
const loading = ref(false);
const saving = ref(false);
const busyId = ref<number | null>(null);
const error = ref('');
const notice = ref('');

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<SourceForm>(emptyForm());

const deleting = ref<AdminSource | null>(null);

/** Users for the 归属 dropdown; a failure only hides 专属 assignment. */
const users = ref<AdminUser[]>([]);
const usersError = ref('');

function emptyForm(): SourceForm {
  return {
    name: '',
    type: 'remote',
    url: '',
    ua: '',
    refreshMinutes: '60',
    ownerUserId: '',
  };
}

const usersById = computed(() => new Map(users.value.map((user) => [user.id, user])));

/** Owner name for the 归属 badge; unknown ids fall back to the raw id. */
function ownerLabel(source: AdminSource): string {
  if (source.ownerUserId === null) return '公共';
  return usersById.value.get(source.ownerUserId)?.name ?? `用户 #${source.ownerUserId}`;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
  } catch {
    users.value = [];
    usersError.value = '用户列表加载失败，暂时无法设置专属归属';
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

function openCreate() {
  editingId.value = null;
  form.value = emptyForm();
  formOpen.value = true;
  error.value = '';
  notice.value = '';
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
    ownerUserId: source.ownerUserId === null ? '' : String(source.ownerUserId),
  };
  formOpen.value = true;
  error.value = '';
  notice.value = '';
}

function closeForm() {
  formOpen.value = false;
  editingId.value = null;
  form.value = emptyForm();
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

  const body: Record<string, unknown> = {
    name,
    type: form.value.type,
    ua: form.value.ua.trim() || null,
    refreshMinutes,
    // '' means 公共 -> null; otherwise the selected user id (the API accepts
    // the numeric string and rejects unknown ids with 400).
    ownerUserId: form.value.ownerUserId || null,
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
 * code path on the server; a `local` source or a failed fetch answers 200 with
 * `outcome: 'failed'` and the source's `lastError`, which is shown as a banner.
 */
async function refreshSource(source: AdminSource) {
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

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>订阅源</h1>
      <button class="primary" type="button" @click="openCreate">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建订阅源
      </button>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form v-if="formOpen" class="card form" @submit.prevent="submitForm">
      <h2>{{ editingId === null ? '新建订阅源' : `编辑订阅源 #${editingId}` }}</h2>
      <label>
        名称
        <input v-model="form.name" type="text" maxlength="100" required :disabled="saving">
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
      <label>
        类型
        <select v-model="form.type" :disabled="saving">
          <option value="remote">remote（定时拉取）</option>
          <option value="local">local（仅用缓存）</option>
        </select>
      </label>
      <label>
        归属
        <select v-model="form.ownerUserId" :disabled="saving || (users.length === 0 && usersError !== '')">
          <option value="">公共（所有用户共享）</option>
          <option v-for="user in users" :key="user.id" :value="String(user.id)">
            专属：{{ user.name }}（#{{ user.id }}）
          </option>
        </select>
        <span v-if="usersError" class="sub">{{ usersError }}</span>
        <span v-else class="hint">
          专属订阅源只出现在该用户的订阅中；公共订阅源对所有用户可见。
        </span>
      </label>
      <label>
        User-Agent（可选）
        <input v-model="form.ua" type="text" maxlength="256" :disabled="saving">
      </label>
      <label>
        刷新间隔（分钟）
        <input
          v-model="form.refreshMinutes"
          type="number"
          min="5"
          max="10080"
          step="1"
          :disabled="saving"
        >
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
      暂无订阅源。
    </p>

    <div v-else class="table-wrap">
      <table class="list">
        <thead>
          <tr>
            <th>ID</th>
            <th>名称</th>
            <th>类型</th>
            <th>归属</th>
            <th>URL（已脱敏）</th>
            <th>刷新</th>
            <th>上次成功</th>
            <th>缓存</th>
            <th>最近错误</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="source in sources" :key="source.id">
            <td class="id-cell">{{ source.id }}</td>
            <td>
              <div>{{ source.name }}</div>
              <div v-if="source.ua" class="sub">UA: {{ source.ua }}</div>
            </td>
            <td>
              <span class="type-tag">{{ source.type }}</span>
            </td>
            <td>
              <span :class="['badge', source.ownerUserId === null ? 'off' : 'on']">
                {{ ownerLabel(source) }}
              </span>
            </td>
            <td class="url-cell"><code>{{ source.urlMasked }}</code></td>
            <td class="nowrap">{{ source.refreshMinutes }} 分钟</td>
            <td class="nowrap">{{ formatTime(source.lastOkAt) }}</td>
            <td>
              <span :class="['badge', source.hasCache ? 'on' : 'off']">
                {{ source.hasCache ? '有' : '无' }}
              </span>
            </td>
            <td class="err">{{ source.lastError ?? '—' }}</td>
            <td class="row-actions">
              <button
                type="button"
                class="small"
                :disabled="busyId !== null"
                :title="source.type === 'local' ? '本地订阅源没有可拉取的 URL，仅更新状态' : '立即拉取并更新缓存'"
                @click="refreshSource(source)"
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
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="deleting" class="overlay" role="dialog" aria-modal="true">
      <div class="card dialog">
        <h2>删除订阅源</h2>
        <p>确定删除「{{ deleting.name }}」？相关缓存将一并移除。</p>
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
.id-cell {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--muted-foreground);
}
.type-tag {
  display: inline-flex;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--muted);
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.url-cell {
  max-width: 16rem;
  word-break: break-all;
}
.err {
  max-width: 16rem;
  word-break: break-word;
  color: var(--warning-text);
  font-size: var(--text-xs);
}
</style>
