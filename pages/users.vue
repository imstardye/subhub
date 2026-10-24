<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Users admin page — the operations hub.
 *
 * Every user is a rich row: name, an inline enabled switch, the rule profile
 * BY NAME (inline `<select>`), the subscription link with 复制 and quick
 * mihomo/clash targets, the source counts (专属源 N · 可用共享 M) and the row
 * actions (编辑 / 重置 Token / 删除).
 *
 * The switch and the profile select PATCH `/api/admin/users/:id` immediately
 * and always report a failure through the page's error banner (the previous
 * value is restored). The create/edit form picks a profile by name from the
 * profiles API — there is no numeric ID input anywhere.
 *
 * `?new=1` (used by the dashboard's 快捷操作 card) opens the create form.
 *
 * Subscription links use the *effective* prefix (`sub_path` site setting, the
 * `admin-sub-path` state filled by the layout from `/api/admin/me`) — never a
 * hard-coded `/s/`. The row actions 「刷新令牌」 (confirm step: it kills the old
 * link at once) and 「自定义令牌」 (validated input + save, API errors shown)
 * rotate the token; the row is replaced with the server answer, so the copied
 * link already carries the new token.
 */
definePageMeta({ layout: 'admin' });

import type { AdminUser } from '~/server/utils/admin-users';
import type { AdminSource } from '~/server/utils/admin-sources';
import type { AdminProfile } from '~/server/utils/admin-profiles';
import { apiErrorMessage } from '~/core/utils/api-error';
import {
  buildUserPayload,
  emptyUserForm,
  userFormFromUser,
  type UserForm,
} from '~/core/utils/user-form';
import {
  formatDateTime,
  maskToken,
  subscriptionPathLabel,
  subscriptionUrlWithPrefix,
  SUBSCRIPTION_QUICK_TARGETS,
  userSourceCounts,
  type UserSourceCounts,
} from '~/core/utils/admin-ui';
import { validateCustomToken } from '~/core/utils/token-form';

const route = useRoute();
const users = ref<AdminUser[]>([]);
/** Sources are loaded to count 专属 / 共享 sources per user (best effort). */
const sources = ref<AdminSource[]>([]);
/** Profiles for the inline select and the form (best effort). */
const profiles = ref<AdminProfile[]>([]);
const loading = ref(false);
const saving = ref(false);
const busyId = ref<number | null>(null);
const error = ref('');
const notice = ref('');

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<UserForm>(emptyUserForm());

const deleting = ref<AdminUser | null>(null);
const copiedToken = ref('');

const origin = ref('');
/** Effective subscription prefix, shared with the settings page. */
const subPath = useState<string>('admin-sub-path', () => 's');

/** The 自定义令牌 dialog: which user, the draft, and its own error line. */
const tokenEditing = ref<AdminUser | null>(null);
const tokenDraft = ref('');
const tokenError = ref('');

const profilesById = computed(() => new Map(profiles.value.map((p) => [p.id, p])));

const counts = computed(() => {
  const map = new Map<number, UserSourceCounts>();
  for (const user of users.value) map.set(user.id, userSourceCounts(sources.value, user.id));
  return map;
});

function countsOf(user: AdminUser): UserSourceCounts {
  return counts.value.get(user.id) ?? { dedicated: 0, shared: 0 };
}

function profileName(user: AdminUser): string {
  if (user.profileId === null) return '无规则档';
  return profilesById.value.get(user.profileId)?.name ?? `已删除的规则档 #${user.profileId}`;
}

function linkFor(user: AdminUser, target?: string): string {
  return subscriptionUrlWithPrefix(origin.value || 'http://localhost', subPath.value, user.token, target);
}

function pathLabel(user: AdminUser): string {
  return subscriptionPathLabel(subPath.value, user.token);
}

async function loadSources() {
  try {
    const res = await $fetch<{ items: AdminSource[] }>('/api/admin/sources');
    sources.value = res.items;
  } catch {
    // Counts are informational; the hub stays usable without them.
    sources.value = [];
  }
}

async function loadProfiles() {
  try {
    const res = await $fetch<{ items: AdminProfile[] }>('/api/admin/profiles');
    profiles.value = res.items;
  } catch {
    profiles.value = [];
  }
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
  await Promise.all([loadSources(), loadProfiles()]);
}

/** PATCH one user and fold the server's answer back into the list. */
async function patchUser(user: AdminUser, body: Record<string, unknown>): Promise<AdminUser | null> {
  const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}`, {
    method: 'PATCH',
    body,
  });
  users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
  return res.item;
}

/**
 * Inline enabled toggle: PATCHes at once. A failure shows the banner and
 * reverts the optimistic flip (the row always reflects the server).
 */
async function toggleEnabled(user: AdminUser) {
  if (busyId.value !== null) return;
  const next = !user.enabled;
  busyId.value = user.id;
  error.value = '';
  notice.value = '';
  const before = user.enabled;
  users.value = users.value.map((u) => (u.id === user.id ? { ...u, enabled: next } : u));
  try {
    await patchUser(user, { enabled: next });
    notice.value = `「${user.name}」已${next ? '启用' : '停用'}`;
  } catch (err) {
    users.value = users.value.map((u) => (u.id === user.id ? { ...u, enabled: before } : u));
    error.value = `「${user.name}」状态更新失败：${apiErrorMessage(err)}`;
  } finally {
    busyId.value = null;
  }
}

/** Inline profile select (by name): '' = 无. PATCHes at once. */
async function changeProfile(user: AdminUser, event: Event) {
  if (busyId.value !== null) return;
  const value = (event.target as HTMLSelectElement).value;
  const profileId = value === '' ? null : Number(value);
  const before = user.profileId;
  busyId.value = user.id;
  error.value = '';
  notice.value = '';
  users.value = users.value.map((u) => (u.id === user.id ? { ...u, profileId } : u));
  try {
    await patchUser(user, { profileId });
    notice.value = profileId === null
      ? `「${user.name}」已取消规则档`
      : `「${user.name}」规则档已改为「${profilesById.value.get(profileId)?.name ?? ''}」`;
  } catch (err) {
    users.value = users.value.map((u) => (u.id === user.id ? { ...u, profileId: before } : u));
    error.value = `「${user.name}」规则档更新失败：${apiErrorMessage(err)}`;
    // Re-sync the <select> with the restored state.
    const select = event.target as HTMLSelectElement;
    select.value = before === null ? '' : String(before);
  } finally {
    busyId.value = null;
  }
}

function openCreate() {
  editingId.value = null;
  form.value = emptyUserForm();
  formOpen.value = true;
  error.value = '';
  notice.value = '';
}

function openEdit(user: AdminUser) {
  editingId.value = user.id;
  form.value = userFormFromUser(user);
  formOpen.value = true;
  error.value = '';
  notice.value = '';
  if (import.meta.client) {
    nextTick(() => {
      document.getElementById('user-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function closeForm() {
  formOpen.value = false;
  editingId.value = null;
  form.value = emptyUserForm();
}

/**
 * Submit the create/edit form. Never resolves without feedback: validation
 * problems, API errors and unexpected exceptions all end in the banner, and
 * the form stays open so nothing is lost.
 */
async function submitForm() {
  if (saving.value) return;
  try {
    error.value = '';
    notice.value = '';
    saving.value = true;

    const built = buildUserPayload(form.value);
    if (!built.ok) {
      error.value = built.error;
      return;
    }

    if (editingId.value === null) {
      const res = await $fetch<{ item: AdminUser }>('/api/admin/users', {
        method: 'POST',
        body: built.payload,
      });
      users.value = [...users.value, res.item];
      notice.value = '用户已创建';
    } else {
      const item = await patchUser({ id: editingId.value } as AdminUser, built.payload);
      if (!item) return;
      notice.value = '用户已更新';
    }
    closeForm();
  } catch (err) {
    error.value = apiErrorMessage(err);
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
    // Their sources (and allowlist entries) went with them.
    await loadSources();
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busyId.value = null;
  }
}

/** 刷新令牌: regenerate via the existing endpoint, with a confirm step. */
async function refreshToken(user: AdminUser) {
  if (busyId.value !== null) return;
  if (!confirm(`刷新「${user.name}」的订阅令牌？旧链接将立即失效，需要重新分发新链接。`)) return;
  busyId.value = user.id;
  error.value = '';
  notice.value = '';
  try {
    const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}/reset-token`, {
      method: 'POST',
    });
    users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
    notice.value = `「${user.name}」的订阅令牌已刷新，新链接：${pathLabel(res.item)}`;
  } catch (err) {
    error.value = `「${user.name}」刷新令牌失败：${apiErrorMessage(err)}`;
  } finally {
    busyId.value = null;
  }
}

function openTokenDialog(user: AdminUser) {
  tokenEditing.value = user;
  tokenDraft.value = '';
  tokenError.value = '';
  error.value = '';
  notice.value = '';
}

function closeTokenDialog() {
  tokenEditing.value = null;
  tokenDraft.value = '';
  tokenError.value = '';
}

/** 自定义令牌: PUT the validated token, surface the API error (400/409). */
async function saveCustomToken() {
  const user = tokenEditing.value;
  if (!user || busyId.value !== null) return;
  tokenError.value = '';
  const checked = validateCustomToken(tokenDraft.value);
  if (!checked.ok) {
    tokenError.value = checked.error;
    return;
  }
  busyId.value = user.id;
  error.value = '';
  notice.value = '';
  try {
    const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}/token`, {
      method: 'PUT',
      body: { token: checked.token },
    });
    users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
    notice.value = `「${user.name}」的订阅令牌已设为 ${pathLabel(res.item)}`;
    closeTokenDialog();
  } catch (err) {
    tokenError.value = apiErrorMessage(err);
  } finally {
    busyId.value = null;
  }
}

async function copyText(text: string, token: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedToken.value = token;
    notice.value = '订阅链接已复制';
    window.setTimeout(() => {
      if (copiedToken.value === token) copiedToken.value = '';
    }, 2000);
  } catch {
    error.value = '复制失败，请手动复制链接';
  }
}

onMounted(() => {
  origin.value = window.location.origin;
  if (route.query.new !== undefined) openCreate();
  load();
});
</script>

<template>
  <section class="page">
    <PageTopbar title="用户" subtitle="启用状态、规则档与订阅链接，一处管理">
      <button class="primary" type="button" @click="openCreate">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建用户
      </button>
    </PageTopbar>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form
      v-if="formOpen"
      id="user-form"
      class="card form"
      @submit.prevent="submitForm"
    >
      <h2>{{ editingId === null ? '新建用户' : `编辑用户「${users.find((u) => u.id === editingId)?.name ?? ''}」` }}</h2>
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
        规则档
        <select v-model="form.profileId" :disabled="saving">
          <option value="">无</option>
          <option v-for="profile in profiles" :key="profile.id" :value="String(profile.id)">
            {{ profile.name }}（{{ profile.variant }}）
          </option>
        </select>
      </label>
      <label class="inline">
        <input v-model="form.enabled" type="checkbox" :disabled="saving">
        启用
      </label>
      <label>
        备注（可选）
        <textarea v-model="form.note" rows="2" maxlength="500" :disabled="saving" />
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
      暂无用户，点击右上角「新建用户」开始。
    </p>

    <div v-else class="rows">
      <article
        v-for="user in users"
        :key="user.id"
        :class="['entity', { 'is-disabled': !user.enabled }]"
      >
        <div class="entity-identity">
          <div class="entity-name">
            <span :title="user.name">{{ user.name }}</span>
            <button
              type="button"
              role="switch"
              :class="['switch', 'small']"
              :aria-checked="user.enabled ? 'true' : 'false'"
              :aria-busy="busyId === user.id ? 'true' : 'false'"
              :aria-label="`${user.enabled ? '停用' : '启用'}用户 ${user.name}`"
              :disabled="busyId !== null"
              @click="toggleEnabled(user)"
            >
              <span class="switch-track" aria-hidden="true"><span class="switch-thumb" /></span>
              {{ user.enabled ? '启用' : '停用' }}
            </button>
          </div>
          <span v-if="user.note" class="sub">{{ user.note }}</span>
          <span v-else-if="user.createdAt" class="sub">创建于 {{ formatDateTime(user.createdAt) }}</span>
        </div>

        <div class="entity-body">
          <label class="entity-field" :title="`规则档：${profileName(user)}`">
            规则档
            <select
              :value="user.profileId === null ? '' : String(user.profileId)"
              :disabled="busyId !== null"
              :aria-label="`${user.name} 的规则档`"
              @change="changeProfile(user, $event)"
            >
              <option value="">无</option>
              <option v-for="profile in profiles" :key="profile.id" :value="String(profile.id)">
                {{ profile.name }}
              </option>
            </select>
          </label>

          <span class="entity-field link-row" :title="linkFor(user)">
            <code class="mono">{{ pathLabel(user) }}</code>
            <button
              type="button"
              class="small"
              :aria-label="`复制 ${user.name} 的订阅链接`"
              @click="copyText(linkFor(user), user.token)"
            >
              {{ copiedToken === user.token ? '已复制' : '复制' }}
            </button>
            <a
              v-for="quick in SUBSCRIPTION_QUICK_TARGETS"
              :key="quick.target"
              class="sub quick-target"
              :href="linkFor(user, quick.target)"
              target="_blank"
              rel="noreferrer"
            >{{ quick.label }}</a>
          </span>

          <span class="counts" :title="`专属源 ${countsOf(user).dedicated} 个 · 可用共享源 ${countsOf(user).shared} 个`">
            专属源 <b>{{ countsOf(user).dedicated }}</b>
            ·
            可用共享 <b>{{ countsOf(user).shared }}</b>
          </span>
        </div>

        <div class="entity-actions">
          <button type="button" class="small" :disabled="busyId !== null" @click="openEdit(user)">
            编辑
          </button>
          <button type="button" class="small" :disabled="busyId !== null" @click="refreshToken(user)">
            {{ busyId === user.id ? '处理中…' : '刷新令牌' }}
          </button>
          <button type="button" class="small" :disabled="busyId !== null" @click="openTokenDialog(user)">
            自定义令牌
          </button>
          <button type="button" class="small danger" :disabled="busyId !== null" @click="deleting = user">
            删除
          </button>
        </div>
      </article>
    </div>

    <div
      v-if="tokenEditing"
      class="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="token-user-title"
    >
      <form class="card dialog" @submit.prevent="saveCustomToken">
        <h2 id="token-user-title">自定义令牌「{{ tokenEditing.name }}」</h2>
        <p class="sub">
          新令牌会立即替换旧令牌，旧链接随即失效。8–64 个字符，只能用字母、数字、- 和 _。
        </p>
        <input
          v-model="tokenDraft"
          type="text"
          maxlength="64"
          autocomplete="off"
          spellcheck="false"
          :placeholder="`当前 ${maskToken(tokenEditing.token)}`"
          :disabled="busyId !== null"
          :aria-label="`${tokenEditing.name} 的新订阅令牌`"
        >
        <p class="sub">新链接：<code class="mono">{{ subscriptionPathLabel(subPath, tokenDraft.trim() || '…') }}</code></p>
        <p v-if="tokenError" class="error" role="alert">{{ tokenError }}</p>
        <div class="actions">
          <button class="primary" type="submit" :disabled="busyId !== null">
            {{ busyId === tokenEditing.id ? '保存中…' : '保存令牌' }}
          </button>
          <button type="button" :disabled="busyId !== null" @click="closeTokenDialog">取消</button>
        </div>
      </form>
    </div>

    <div v-if="deleting" class="overlay" role="dialog" aria-modal="true" aria-labelledby="delete-user-title">
      <div class="card dialog">
        <h2 id="delete-user-title">删除用户</h2>
        <p>确定删除「{{ deleting.name }}」？该用户的订阅链接将立即失效，其专属订阅源也会一并删除。</p>
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
.quick-target {
  text-decoration: none;
  padding: 0.1rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  font-family: var(--font-mono);
}

.quick-target:hover {
  border-color: var(--primary);
  color: var(--primary);
}
</style>
