<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Users admin page — the operations hub.
 *
 * Every user is a rich row: name, an inline enabled switch, the rule profile
 * BY NAME (inline select), the subscription link with 复制 and quick
 * mihomo/clash targets, the source counts (专属源 N · 可用共享 M) and the row
 * actions (编辑 / 重置 Token / 删除).
 *
 * The switch and the profile select PATCH `/api/admin/users/:id` immediately
 * and always report a failure through a toast (the previous value is restored). The create/edit form picks a profile by name from the
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
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NSelect, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui';
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
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '~/core/utils/user-password';

const route = useRoute();
const users = ref<AdminUser[]>([]);
/** Sources are loaded to count 专属 / 共享 sources per user (best effort). */
const sources = ref<AdminSource[]>([]);
/** Profiles for the inline select and the form (best effort). */
const profiles = ref<AdminProfile[]>([]);
const loading = ref(false);
const saving = ref(false);
const busyId = ref<number | null>(null);
const loadError = ref('');
const message = useMessage();
const dialog = useDialog();

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<UserForm>(emptyUserForm());

/** Operator count of the user being edited (the pipeline itself lives in /my). */
const editingOperatorsCount = computed(
  () => users.value.find((user) => user.id === editingId.value)?.operatorsCount ?? 0,
);

/** Clear a user's operator pipeline at once (PATCH operators: []). */
function askClearOperators() {
  const user = users.value.find((entry) => entry.id === editingId.value);
  if (!user || user.operatorsCount === 0) return;
  dialog.warning({
    title: '清空节点处理管线',
    content: `确定要清空「${user.name}」的全部 ${user.operatorsCount} 个算子吗？清空后其导出恢复为未处理状态。`,
    positiveText: '确认清空',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await patchUser(user, { operators: [] });
        message.success(`「${user.name}」的节点处理管线已清空`);
      } catch (err) {
        message.error(apiErrorMessage(err));
      }
    },
  });
}

/** Saved source-order overrides of the user being edited (reordering is /my only). */
const editingSourceOrderCount = computed(
  () => users.value.find((user) => user.id === editingId.value)?.sourceOrderCount ?? 0,
);

/** Restore the default source order (PATCH sourceOrder: []). */
function askClearSourceOrder() {
  const user = users.value.find((entry) => entry.id === editingId.value);
  if (!user || user.sourceOrderCount === 0) return;
  dialog.warning({
    title: '清除订阅排序',
    content: `确定要清除「${user.name}」保存的 ${user.sourceOrderCount} 个订阅源排序吗？清除后恢复默认顺序。`,
    positiveText: '确认清除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await patchUser(user, { sourceOrder: [] });
        message.success(`「${user.name}」的订阅排序已清除`);
      } catch (err) {
        message.error(apiErrorMessage(err));
      }
    },
  });
}

const copiedToken = ref('');

const origin = ref('');
/** Effective subscription prefix, shared with the settings page. */
const subPath = useState<string>('admin-sub-path', () => 's');

/** The 自定义令牌 dialog: which user, the draft, and its own error line. */
const tokenEditing = ref<AdminUser | null>(null);
const tokenDraft = ref('');

/** The 设置密码 dialog (admins never see an existing password). */
const passwordEditing = ref<AdminUser | null>(null);
const passwordDraft = ref('');

const profileSelectOptions = computed(() => [
  { label: '无', value: '' },
  ...profiles.value.map((profile) => ({
    label: `${profile.name}（${profile.variant}）`,
    value: String(profile.id),
  })),
]);

const profileInlineOptions = computed(() => [
  { label: '无', value: '' },
  ...profiles.value.map((profile) => ({ label: profile.name, value: String(profile.id) })),
]);

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
  loadError.value = '';
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
  } catch (err) {
    loadError.value = apiErrorMessage(err);
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
  const before = user.enabled;
  users.value = users.value.map((u) => (u.id === user.id ? { ...u, enabled: next } : u));
  try {
    await patchUser(user, { enabled: next });
    message.success(`「${user.name}」已${next ? '启用' : '停用'}`);
  } catch (err) {
    users.value = users.value.map((u) => (u.id === user.id ? { ...u, enabled: before } : u));
    message.error(`「${user.name}」状态更新失败：${apiErrorMessage(err)}`);
  } finally {
    busyId.value = null;
  }
}

/** Inline profile select (by name): '' = 无. PATCHes at once. */
async function changeProfile(user: AdminUser, value: string) {
  if (busyId.value !== null) return;
  const profileId = value === '' ? null : Number(value);
  const before = user.profileId;
  busyId.value = user.id;
  users.value = users.value.map((u) => (u.id === user.id ? { ...u, profileId } : u));
  try {
    await patchUser(user, { profileId });
    message.success(profileId === null
      ? `「${user.name}」已取消规则档`
      : `「${user.name}」规则档已改为「${profilesById.value.get(profileId)?.name ?? ''}」`);
  } catch (err) {
    users.value = users.value.map((u) => (u.id === user.id ? { ...u, profileId: before } : u));
    message.error(`「${user.name}」规则档更新失败：${apiErrorMessage(err)}`);
  } finally {
    busyId.value = null;
  }
}

function openCreate() {
  editingId.value = null;
  form.value = emptyUserForm();
  formOpen.value = true;
}

function openEdit(user: AdminUser) {
  editingId.value = user.id;
  form.value = userFormFromUser(user);
  formOpen.value = true;
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
 * problems, API errors and unexpected exceptions all end in a toast, and
 * the form stays open so nothing is lost.
 */
async function submitForm() {
  if (saving.value) return;
  try {
    saving.value = true;

    const built = buildUserPayload(form.value);
    if (!built.ok) {
      message.error(built.error);
      return;
    }

    if (editingId.value === null) {
      const res = await $fetch<{ item: AdminUser }>('/api/admin/users', {
        method: 'POST',
        body: built.payload,
      });
      users.value = [...users.value, res.item];
      message.success('用户已创建');
    } else {
      const item = await patchUser({ id: editingId.value } as AdminUser, built.payload);
      if (!item) return;
      message.success('用户已更新');
    }
    closeForm();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    saving.value = false;
  }
}

async function confirmDelete(user: AdminUser) {
  if (busyId.value !== null) return;
  busyId.value = user.id;
  try {
    await $fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    users.value = users.value.filter((u) => u.id !== user.id);
    message.success(`已删除用户「${user.name}」`);
    if (editingId.value === user.id) closeForm();
    // Their sources (and allowlist entries) went with them.
    await loadSources();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    busyId.value = null;
  }
}

function askDelete(user: AdminUser) {
  dialog.warning({
    title: '删除用户',
    content: `确定删除「${user.name}」？该用户的订阅链接将立即失效，其专属订阅源也会一并删除。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: () => confirmDelete(user),
  });
}

/** 刷新令牌: regenerate via the existing endpoint, with a confirm step. */
function refreshToken(user: AdminUser) {
  if (busyId.value !== null) return;
  dialog.warning({
    title: '刷新令牌',
    content: `刷新「${user.name}」的订阅令牌？旧链接将立即失效，需要重新分发新链接。`,
    positiveText: '确认刷新',
    negativeText: '取消',
    onPositiveClick: () => doRefreshToken(user),
  });
}

async function doRefreshToken(user: AdminUser) {
  if (busyId.value !== null) return;
  busyId.value = user.id;
  try {
    const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}/reset-token`, {
      method: 'POST',
    });
    users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
    message.success(`「${user.name}」的订阅令牌已刷新，新链接：${pathLabel(res.item)}`);
  } catch (err) {
    message.error(`「${user.name}」刷新令牌失败：${apiErrorMessage(err)}`);
  } finally {
    busyId.value = null;
  }
}

function openTokenDialog(user: AdminUser) {
  tokenEditing.value = user;
  tokenDraft.value = '';
}

function closeTokenDialog() {
  tokenEditing.value = null;
  tokenDraft.value = '';
}

function openPasswordDialog(user: AdminUser) {
  passwordEditing.value = user;
  passwordDraft.value = '';
}

function closePasswordDialog() {
  passwordEditing.value = null;
  passwordDraft.value = '';
}

/**
 * 设置密码: PUT the admin-chosen password. The answer only carries
 * `passwordSet`, so the UI never receives a hash or the plaintext.
 */
async function savePassword() {
  const user = passwordEditing.value;
  if (!user || busyId.value !== null) return;
  const checked = validatePassword(passwordDraft.value);
  if (!checked.ok) {
    message.error(checked.error);
    return;
  }
  busyId.value = user.id;
  try {
    const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}/password`, {
      method: 'PUT',
      body: { password: checked.password },
    });
    users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
    message.success(`已为「${user.name}」设置访问密码`);
    closePasswordDialog();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    busyId.value = null;
  }
}

/** 重置密码: clear it; the user sets a new one on their next /my visit. */
function askResetPassword(user: AdminUser) {
  if (busyId.value !== null || !user.passwordSet) return;
  dialog.warning({
    title: '重置密码',
    content: `重置「${user.name}」的访问密码？重置后现有登录立即失效，该用户下次打开 /my 时需要自己重新设置密码。`,
    positiveText: '确认重置',
    negativeText: '取消',
    onPositiveClick: () => doResetPassword(user),
  });
}

async function doResetPassword(user: AdminUser) {
  if (busyId.value !== null) return;
  busyId.value = user.id;
  try {
    const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}/password`, {
      method: 'DELETE',
    });
    users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
    message.success(`「${user.name}」的访问密码已重置，下次进入需重新设置`);
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    busyId.value = null;
  }
}

/** 自定义令牌: PUT the validated token, surface the API error (400/409). */
async function saveCustomToken() {
  const user = tokenEditing.value;
  if (!user || busyId.value !== null) return;
  const checked = validateCustomToken(tokenDraft.value);
  if (!checked.ok) {
    message.error(checked.error);
    return;
  }
  busyId.value = user.id;
  try {
    const res = await $fetch<{ item: AdminUser }>(`/api/admin/users/${user.id}/token`, {
      method: 'PUT',
      body: { token: checked.token },
    });
    users.value = users.value.map((u) => (u.id === res.item.id ? res.item : u));
    message.success(`「${user.name}」的订阅令牌已设为 ${pathLabel(res.item)}`);
    closeTokenDialog();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    busyId.value = null;
  }
}

async function copyText(text: string, token: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedToken.value = token;
    message.success('订阅链接已复制');
    window.setTimeout(() => {
      if (copiedToken.value === token) copiedToken.value = '';
    }, 2000);
  } catch {
    message.error('复制失败，请手动复制链接');
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
      <n-button type="primary" @click="openCreate">
        <template #icon>
          <n-icon><NavIcon name="plus" /></n-icon>
        </template>
        新建用户
      </n-button>
    </PageTopbar>

    <n-alert v-if="loadError" type="error" :bordered="false" role="alert">{{ loadError }}</n-alert>

    <n-form
      v-if="formOpen"
      id="user-form"
      class="card form"
      @submit.prevent="submitForm"
    >
      <h2>{{ editingId === null ? '新建用户' : `编辑用户「${users.find((u) => u.id === editingId)?.name ?? ''}」` }}</h2>
      <n-form-item label="名称" :show-feedback="false">
        <n-input
          v-model:value="form.name"
          maxlength="100"
          autocomplete="off"
          :input-props="{ required: true }"
          :disabled="saving"
        />
      </n-form-item>
      <n-form-item label="规则档" :show-feedback="false">
        <n-select v-model:value="form.profileId" :options="profileSelectOptions" :disabled="saving" />
      </n-form-item>
      <n-form-item label="启用" :show-feedback="false">
        <n-switch v-model:value="form.enabled" :disabled="saving" />
      </n-form-item>
      <n-form-item label="备注（可选）" :show-feedback="false">
        <n-input
          v-model:value="form.note"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          maxlength="500"
          :disabled="saving"
        />
      </n-form-item>
      <template v-if="editingId !== null">
        <n-form-item label="自定义规则（可选）" :show-feedback="false">
          <n-input
            v-model:value="form.customRules"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            placeholder="一行一条 Clash 规则，如 DOMAIN-SUFFIX,example.com,DIRECT；清空即删除全部"
            :disabled="saving"
          />
        </n-form-item>
        <n-form-item label="规则位置" :show-feedback="false">
          <n-select
            v-model:value="form.customRulesPosition"
            :options="[
              { label: '前置（优先于规则档规则）', value: 'prepend' },
              { label: '后置（规则档之后、MATCH 之前）', value: 'append' },
            ]"
            :disabled="saving"
          />
        </n-form-item>
        <n-form-item label="节点处理管线" :show-feedback="false">
          <div class="ops-admin-row">
            <span class="muted">
              已配置 {{ editingOperatorsCount }} 个算子（在用户自己的 /my 里编辑）
            </span>
            <n-button
              v-if="editingOperatorsCount > 0"
              size="small"
              secondary
              type="error"
              :disabled="saving"
              @click="askClearOperators"
            >
              清空管线
            </n-button>
          </div>
        </n-form-item>
        <n-form-item label="订阅排序" :show-feedback="false">
          <div class="ops-admin-row">
            <span class="muted">
              {{ editingSourceOrderCount > 0 ? `已保存 ${editingSourceOrderCount} 个订阅源的顺序（在用户自己的 /my 里调整）` : '未设置（使用默认顺序）' }}
            </span>
            <n-button
              v-if="editingSourceOrderCount > 0"
              size="small"
              secondary
              type="error"
              :disabled="saving"
              @click="askClearSourceOrder"
            >
              清除排序
            </n-button>
          </div>
        </n-form-item>
      </template>
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
    <n-empty v-else-if="users.length === 0" description="暂无用户，点击右上角「新建用户」开始。" class="empty" />

    <div v-else class="rows">
      <n-card
        v-for="user in users"
        :key="user.id"
        class="entity"
        :class="{ 'is-disabled': !user.enabled }"
      >
        <div class="entity-layout">
          <div class="entity-identity">
            <div class="entity-name">
              <span :title="user.name">{{ user.name }}</span>
              <n-tag size="small" :type="user.passwordSet ? 'success' : 'default'" :bordered="false">
                {{ user.passwordSet ? '已设密码' : '未设密码' }}
              </n-tag>
              <n-switch
                :value="user.enabled"
                size="small"
                :loading="busyId === user.id"
                :disabled="busyId !== null"
                :aria-label="`${user.enabled ? '停用' : '启用'}用户 ${user.name}`"
                @update:value="toggleEnabled(user)"
              >
                <template #checked>启用</template>
                <template #unchecked>停用</template>
              </n-switch>
            </div>
            <span v-if="user.note" class="sub">{{ user.note }}</span>
            <span v-else-if="user.createdAt" class="sub">创建于 {{ formatDateTime(user.createdAt) }}</span>
          </div>

          <div class="entity-body">
            <label class="entity-field" :title="`规则档：${profileName(user)}`">
              规则档
              <n-select
                class="inline-select"
                size="small"
                :value="user.profileId === null ? '' : String(user.profileId)"
                :options="profileInlineOptions"
                :disabled="busyId !== null"
                :aria-label="`${user.name} 的规则档`"
                @update:value="(value) => changeProfile(user, String(value))"
              />
            </label>

            <span class="entity-field link-row" :title="linkFor(user)">
              <code class="mono">{{ pathLabel(user) }}</code>
              <n-button
                size="tiny"
                secondary
                :aria-label="`复制 ${user.name} 的订阅链接`"
                @click="copyText(linkFor(user), user.token)"
              >
                {{ copiedToken === user.token ? '已复制' : '复制' }}
              </n-button>
              <n-button
                v-for="quick in SUBSCRIPTION_QUICK_TARGETS"
                :key="quick.target"
                tag="a"
                text
                size="tiny"
                class="quick-target"
                :href="linkFor(user, quick.target)"
                target="_blank"
                rel="noreferrer"
              >{{ quick.label }}</n-button>
            </span>

            <span class="counts" :title="`专属源 ${countsOf(user).dedicated} 个 · 可用共享源 ${countsOf(user).shared} 个`">
              专属源 <b>{{ countsOf(user).dedicated }}</b>
              ·
              可用共享 <b>{{ countsOf(user).shared }}</b>
            </span>
          </div>

          <div class="entity-actions">
            <n-button size="small" secondary :disabled="busyId !== null" @click="openEdit(user)">
              编辑
            </n-button>
            <n-button size="small" secondary :disabled="busyId !== null" @click="refreshToken(user)">
              {{ busyId === user.id ? '处理中…' : '刷新令牌' }}
            </n-button>
            <n-button size="small" tertiary :disabled="busyId !== null" @click="openTokenDialog(user)">
              自定义令牌
            </n-button>
            <n-button size="small" secondary :disabled="busyId !== null" @click="openPasswordDialog(user)">
              设置密码
            </n-button>
            <n-button
              size="small"
              tertiary
              :disabled="busyId !== null || !user.passwordSet"
              @click="askResetPassword(user)"
            >
              重置密码
            </n-button>
            <n-button size="small" secondary type="error" :disabled="busyId !== null" @click="askDelete(user)">
              删除
            </n-button>
          </div>
        </div>
      </n-card>
    </div>

    <n-modal
      :show="tokenEditing !== null"
      preset="card"
      class="dialog-card"
      :title="tokenEditing ? `自定义令牌「${tokenEditing.name}」` : '自定义令牌'"
      @update:show="(value) => { if (!value) closeTokenDialog(); }"
    >
      <n-form v-if="tokenEditing" class="form" @submit.prevent="saveCustomToken">
        <p class="sub">
          新令牌会立即替换旧令牌，旧链接随即失效。8–64 个字符，只能用字母、数字、- 和 _。
        </p>
        <n-input
          v-model:value="tokenDraft"
          maxlength="64"
          autocomplete="off"
          spellcheck="false"
          :placeholder="`当前 ${maskToken(tokenEditing.token)}`"
          :disabled="busyId !== null"
          :aria-label="`${tokenEditing.name} 的新订阅令牌`"
        />
        <p class="sub">新链接：<code class="mono">{{ subscriptionPathLabel(subPath, tokenDraft.trim() || '…') }}</code></p>
        <div class="actions">
          <n-button type="primary" attr-type="submit" :loading="busyId === tokenEditing.id">
            {{ busyId === tokenEditing.id ? '保存中…' : '保存令牌' }}
          </n-button>
          <n-button :disabled="busyId !== null" @click="closeTokenDialog">取消</n-button>
        </div>
      </n-form>
    </n-modal>

    <n-modal
      :show="passwordEditing !== null"
      preset="card"
      class="dialog-card"
      :title="passwordEditing ? `设置密码「${passwordEditing.name}」` : '设置密码'"
      @update:show="(value) => { if (!value) closePasswordDialog(); }"
    >
      <n-form v-if="passwordEditing" class="form" @submit.prevent="savePassword">
        <p class="sub">
          为该用户直接指定 /my 访问密码（{{ PASSWORD_MIN_LENGTH }}–{{ PASSWORD_MAX_LENGTH }} 个字符）。
          保存后该用户现有登录立即失效，可用新密码进入；管理员无法查看已设密码。
        </p>
        <n-input
          v-model:value="passwordDraft"
          type="password"
          show-password-on="click"
          autocomplete="new-password"
          :maxlength="PASSWORD_MAX_LENGTH"
          :placeholder="passwordEditing.passwordSet ? '输入新密码（将覆盖原密码）' : '输入访问密码'"
          :disabled="busyId !== null"
          :aria-label="`${passwordEditing.name} 的访问密码`"
        />
        <div class="actions">
          <n-button type="primary" attr-type="submit" :loading="busyId === passwordEditing.id">
            {{ busyId === passwordEditing.id ? '保存中…' : '保存密码' }}
          </n-button>
          <n-button :disabled="busyId !== null" @click="closePasswordDialog">取消</n-button>
        </div>
      </n-form>
    </n-modal>
  </section>
</template>

<style scoped>
.ops-admin-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.entity-layout {
  display: grid;
  grid-template-columns: minmax(14rem, 1fr) minmax(0, 2fr) auto;
  gap: var(--space-3) var(--space-5);
  align-items: center;
}

.entity.is-disabled {
  opacity: 0.72;
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

.entity-field {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  color: var(--muted-foreground);
  font-size: var(--text-xs);
}

.inline-select {
  width: 8.5rem;
}

.entity-field > code,
.entity-field .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 18rem;
}

.counts {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  font-variant-numeric: tabular-nums;
}

.counts b {
  font-weight: 600;
  color: var(--foreground);
}

.link-row {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  max-width: 100%;
}

.link-row code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quick-target {
  font-family: var(--font-mono);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.dialog-card {
  width: min(30rem, calc(100vw - 2rem));
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
  .entity-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-3);
  }

  .entity-body,
  .entity-field,
  .inline-select,
  .entity-field > code,
  .entity-field .mono,
  .link-row {
    max-width: 100%;
    width: 100%;
    min-width: 0;
  }

  .entity-actions {
    justify-content: flex-start;
  }

  .entity-actions :deep(.n-button) {
    flex: 1 1 auto;
  }
}
</style>
