<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Users admin page: list, create, edit, delete and token reset.
 *
 * Talks to /api/admin/users. The token is read-only here (the server generates
 * it) and feeds the public subscription URL /s/:token. Pages are demo-editable
 * only through the real API — there is no client-side fake store.
 */
definePageMeta({ layout: 'admin' });

import type { AdminUser } from '~/server/utils/admin-users';

interface UserForm {
  name: string;
  enabled: boolean;
  note: string;
  profileId: string;
}

const users = ref<AdminUser[]>([]);
const loading = ref(false);
const saving = ref(false);
const busyId = ref<number | null>(null);
const error = ref('');
const notice = ref('');

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<UserForm>(emptyForm());

const deleting = ref<AdminUser | null>(null);

const copiedToken = ref('');

function emptyForm(): UserForm {
  return { name: '', enabled: true, note: '', profileId: '' };
}

function subscriptionUrl(user: Pick<AdminUser, 'token'>): string {
  // Client-only: copyLink runs in the browser after mount.
  return `${window.location.origin}/s/${user.token}`;
}

function errorMessage(err: unknown): string {
  const data = (err as { data?: { error?: string } }).data;
  if (data?.error) return data.error;
  return '请求失败，请稍后再试';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  form.value = emptyForm();
  formOpen.value = true;
  error.value = '';
  notice.value = '';
}

function openEdit(user: AdminUser) {
  editingId.value = user.id;
  form.value = {
    name: user.name,
    enabled: user.enabled,
    note: user.note ?? '',
    profileId: user.profileId === null ? '' : String(user.profileId),
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
  if (!form.value.name.trim()) {
    error.value = '请填写名称';
    return;
  }
  const body: Record<string, unknown> = {
    name: form.value.name.trim(),
    enabled: form.value.enabled,
    note: form.value.note.trim() || null,
    profileId: form.value.profileId.trim() || null,
  };
  saving.value = true;
  try {
    if (editingId.value === null) {
      const res = await $fetch<{ item: AdminUser }>('/api/admin/users', { method: 'POST', body });
      users.value = [...users.value, res.item];
      notice.value = '用户已创建';
    } else {
      const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${editingId.value}`, {
        method: 'PATCH',
        body,
      });
      users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
      notice.value = '用户已更新';
    }
    closeForm();
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}

async function confirmDelete() {
  const user = deleting.value;
  if (!user || busyId.value !== null) return;
  busyId.value = user.id;
  error.value = '';
  notice.value = '';
  try {
    await $fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    users.value = users.value.filter((u) => u.id !== user.id);
    notice.value = `已删除用户「${user.name}」`;
    if (editingId.value === user.id) closeForm();
    deleting.value = null;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busyId.value = null;
  }
}

async function resetToken(user: AdminUser) {
  if (busyId.value !== null) return;
  if (!confirm(`重置「${user.name}」的订阅 token？旧链接将立即失效。`)) return;
  busyId.value = user.id;
  error.value = '';
  notice.value = '';
  try {
    const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}/reset-token`, {
      method: 'POST',
    });
    users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
    notice.value = `「${user.name}」的订阅 token 已重置`;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    busyId.value = null;
  }
}

async function copyLink(user: AdminUser) {
  const url = subscriptionUrl(user);
  try {
    await navigator.clipboard.writeText(url);
    copiedToken.value = user.token;
    notice.value = '订阅链接已复制';
    window.setTimeout(() => {
      if (copiedToken.value === user.token) copiedToken.value = '';
    }, 2000);
  } catch {
    error.value = '复制失败，请手动复制链接';
  }
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>用户</h1>
      <button class="primary" type="button" @click="openCreate">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建用户
      </button>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form v-if="formOpen" class="card form" @submit.prevent="submitForm">
      <h2>{{ editingId === null ? '新建用户' : `编辑用户 #${editingId}` }}</h2>
      <label>
        名称
        <input v-model="form.name" type="text" maxlength="100" required :disabled="saving">
      </label>
      <label class="inline">
        <input v-model="form.enabled" type="checkbox" :disabled="saving">
        启用
      </label>
      <label>
        备注
        <textarea v-model="form.note" rows="2" maxlength="500" :disabled="saving" />
      </label>
      <label>
        规则档 ID（可选）
        <input v-model="form.profileId" type="number" min="1" step="1" :disabled="saving">
      </label>
      <div class="actions">
        <button class="primary" type="submit" :disabled="saving">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button type="button" :disabled="saving" @click="closeForm">取消</button>
      </div>
    </form>

    <p v-if="loading" class="muted empty">加载中…</p>
    <p v-else-if="users.length === 0" class="muted empty">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
      </svg>
      暂无用户。
    </p>

    <div v-else class="table-wrap">
      <table class="list">
        <thead>
          <tr>
            <th>ID</th>
            <th>名称</th>
            <th>状态</th>
            <th>规则档</th>
            <th>备注</th>
            <th>订阅链接</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td class="id-cell">{{ user.id }}</td>
            <td>{{ user.name }}</td>
            <td>
              <span :class="['badge', user.enabled ? 'on' : 'off']">
                {{ user.enabled ? '启用' : '停用' }}
              </span>
            </td>
            <td class="mono">{{ user.profileId ?? '—' }}</td>
            <td class="note">{{ user.note ?? '—' }}</td>
            <td class="token">
              <code>{{ user.token }}</code>
              <button type="button" class="small" @click="copyLink(user)">
                {{ copiedToken === user.token ? '已复制' : '复制链接' }}
              </button>
            </td>
            <td class="row-actions">
              <button type="button" class="small" :disabled="busyId !== null" @click="openEdit(user)">
                编辑
              </button>
              <button
                type="button"
                class="small"
                :disabled="busyId !== null"
                @click="resetToken(user)"
              >
                {{ busyId === user.id ? '处理中…' : '重置 token' }}
              </button>
              <button
                type="button"
                class="small danger"
                :disabled="busyId !== null"
                @click="deleting = user"
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
        <h2>删除用户</h2>
        <p>确定删除「{{ deleting.name }}」？该用户的订阅链接将立即失效。</p>
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
.note {
  max-width: 14rem;
  white-space: pre-wrap;
  word-break: break-word;
}
.id-cell {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--muted-foreground);
}
.token {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.token code {
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-foreground);
}
.token button {
  flex-shrink: 0;
}
</style>
