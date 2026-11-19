<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Rule profile admin page: table with name, variant badge, INI source summary
 * (URL or 内联 N 字符), the users that reference the profile (by name) and
 * 编辑 / 删除.
 *
 * Talks to /api/admin/profiles. INIs are not secrets, so the form round-trips
 * `iniUrl` / `iniText` verbatim; the API requires at least one of them and an
 * http(s) `iniUrl`. `options` is edited as JSON text and only parsed on save.
 *
 * `?new=1` opens the create form (dashboard 快捷操作).
 */
definePageMeta({ layout: 'admin' });

import type { AdminProfile } from '~/server/utils/admin-profiles';
import type { AdminUser } from '~/server/utils/admin-users';
import { h } from 'vue';
import { NAlert, NButton, NCard, NDataTable, NDropdown, NEmpty, NForm, NFormItem, NIcon, NInput, NSelect, NSpin, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui';
import { apiErrorMessage } from '~/core/utils/api-error';
import { profileUsers, truncate } from '~/core/utils/admin-ui';
import type { ProfileVariant } from '~/server/utils/admin-validation';

interface ProfileForm {
  name: string;
  iniUrl: string;
  iniText: string;
  variant: ProfileVariant;
  dnsTemplate: string;
  options: string;
}

const route = useRoute();
const profiles = ref<AdminProfile[]>([]);
/** Users, loaded to show 被 N 个用户使用 + their names (best effort). */
const users = ref<AdminUser[]>([]);
const loading = ref(false);
const saving = ref(false);
const busyId = ref<number | null>(null);
const loadError = ref('');
const message = useMessage();
const dialog = useDialog();

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<ProfileForm>(emptyForm());

function emptyForm(): ProfileForm {
  return { name: '', iniUrl: '', iniText: '', variant: 'mihomo', dnsTemplate: '', options: '' };
}

const variantOptions = [
  { label: 'mihomo', value: 'mihomo' },
  { label: 'legacy（老 Clash）', value: 'legacy' },
];

function usersOf(profile: AdminProfile): Array<Pick<AdminUser, 'id' | 'name' | 'profileId'>> {
  return profileUsers(users.value, profile.id);
}

function usersLabel(profile: AdminProfile): string {
  const names = usersOf(profile).map((user) => user.name);
  if (names.length === 0) return '未被任何用户使用';
  return `被 ${names.length} 个用户使用：${names.join('、')}`;
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function optionsText(profile: AdminProfile): string {
  return profile.options ? JSON.stringify(profile.options, null, 2) : '';
}

function optionsSummary(profile: AdminProfile): string {
  if (!profile.options) return '—';
  const keys = Object.keys(profile.options);
  return keys.length === 0 ? '{}' : keys.join(', ');
}

const profileRowKey = (profile: AdminProfile) => profile.id;

const profileColumns = computed<DataTableColumns<AdminProfile>>(() => [
  {
    title: '规则档',
    key: 'name',
    minWidth: 260,
    render: (profile) => h('div', { class: 'profile-cell' }, [
      h('div', { class: 'profile-name-line' }, [
        h('span', { class: 'profile-name', title: profile.name }, profile.name),
        h(NTag, {
          size: 'small', round: true, type: profile.variant === 'mihomo' ? 'info' : 'default',
        }, { default: () => profile.variant }),
      ]),
      h('div', { class: 'profile-meta', title: usersLabel(profile) }, [
        '用户 ', usersLabel(profile),
      ]),
    ]),
  },
  {
    title: '来源',
    key: 'iniUrl',
    minWidth: 320,
    render: (profile) => h('div', { class: 'profile-cell' }, [
      h('div', { class: 'profile-source' }, [
        h('span', { class: 'profile-meta' }, 'INI 来源 '),
        profile.iniUrl
          ? h('code', { class: 'mono profile-url', title: profile.iniUrl }, truncate(profile.iniUrl, 48))
          : null,
        profile.iniUrl && profile.iniText ? ' + ' : null,
        profile.iniText
          ? h('span', { class: 'profile-meta' }, [
              '内联 ', h('span', { class: 'mono' }, String(profile.iniText.length)), ' 字符',
            ])
          : null,
        !profile.iniUrl && !profile.iniText ? h('span', { class: 'profile-meta' }, '—') : null,
      ]),
      profile.dnsTemplate
        ? h('div', { class: 'profile-meta', title: profile.dnsTemplate }, [
            'DNS 模板 ', h('span', { class: 'mono' }, truncate(profile.dnsTemplate, 48)),
          ])
        : null,
      profile.options
        ? h('div', { class: 'profile-meta' }, [
            'options ', h('span', { class: 'mono' }, optionsSummary(profile)),
          ])
        : null,
    ]),
  },
  {
    title: '操作',
    key: 'actions',
    width: 132,
    align: 'right',
    render: (profile) => h('div', { class: 'row-actions' }, [
      h(NButton, {
        size: 'small', secondary: true, disabled: busyId.value !== null,
        onClick: () => openEdit(profile),
      }, { default: () => '编辑' }),
      h(NDropdown, {
        trigger: 'click',
        options: [{
          key: 'delete',
          disabled: busyId.value !== null,
          label: () => h('span', { style: 'color: var(--destructive)' }, '删除'),
        }],
        onSelect: () => askDelete(profile),
      }, {
        default: () => h(NButton, {
          size: 'small', tertiary: true, disabled: busyId.value !== null,
          'aria-label': `${profile.name} 的更多操作`,
        }, { default: () => '⋯' }),
      }),
    ]),
  },
]);

async function loadUsers() {
  try {
    const res = await $fetch<{ items: AdminUser[] }>('/api/admin/users');
    users.value = res.items;
  } catch {
    // "被 N 个用户使用" is informational; the profile list stays usable.
    users.value = [];
  }
}

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await $fetch<{ items: AdminProfile[] }>('/api/admin/profiles');
    profiles.value = res.items;
  } catch (err) {
    loadError.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
  await loadUsers();
}

function openCreate() {
  editingId.value = null;
  form.value = emptyForm();
  formOpen.value = true;
  if (import.meta.client) {
    nextTick(() => {
      document.getElementById('profile-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function openEdit(profile: AdminProfile) {
  editingId.value = profile.id;
  form.value = {
    name: profile.name,
    iniUrl: profile.iniUrl ?? '',
    iniText: profile.iniText ?? '',
    variant: profile.variant,
    dnsTemplate: profile.dnsTemplate ?? '',
    options: optionsText(profile),
  };
  formOpen.value = true;
  if (import.meta.client) {
    nextTick(() => {
      document.getElementById('profile-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function closeForm() {
  formOpen.value = false;
  editingId.value = null;
  form.value = emptyForm();
}

async function submitForm() {
  if (saving.value) return;
  const name = form.value.name.trim();
  const iniUrl = form.value.iniUrl.trim();
  const iniText = form.value.iniText;
  if (!name) {
    message.error('请填写名称');
    return;
  }
  if (!iniUrl && !iniText.trim()) {
    message.error('iniUrl 与 iniText 至少填写一个');
    return;
  }
  if (iniUrl && !validUrl(iniUrl)) {
    message.error('iniUrl 必须是 http 或 https 地址');
    return;
  }
  const options = form.value.options.trim();
  if (options) {
    try {
      const parsed: unknown = JSON.parse(options);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        message.error('options 必须是 JSON 对象');
        return;
      }
    } catch {
      message.error('options 不是合法的 JSON');
      return;
    }
  }

  const body: Record<string, unknown> = {
    name,
    iniUrl: iniUrl || null,
    iniText: iniText.trim() || null,
    variant: form.value.variant,
    dnsTemplate: form.value.dnsTemplate.trim() || null,
    options: options || null,
  };

  saving.value = true;
  try {
    if (editingId.value === null) {
      const res = await $fetch<{ item: AdminProfile }>('/api/admin/profiles', {
        method: 'POST',
        body,
      });
      profiles.value = [...profiles.value, res.item];
      message.success('规则档已创建');
    } else {
      const res = await $fetch<{ item: AdminProfile }>(`/api/admin/profiles/${editingId.value}`, {
        method: 'PATCH',
        body,
      });
      profiles.value = profiles.value.map((p) => (p.id === res.item.id ? res.item : p));
      message.success('规则档已更新');
    }
    closeForm();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    saving.value = false;
  }
}

async function confirmDelete(profile: AdminProfile) {
  if (busyId.value !== null) return;
  busyId.value = profile.id;
  try {
    await $fetch(`/api/admin/profiles/${profile.id}`, { method: 'DELETE' });
    profiles.value = profiles.value.filter((p) => p.id !== profile.id);
    message.success(`已删除规则档「${profile.name}」`);
    if (editingId.value === profile.id) closeForm();
    await loadUsers();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    busyId.value = null;
  }
}

function askDelete(profile: AdminProfile) {
  dialog.warning({
    title: '删除规则档',
    content: `确定删除「${profile.name}」？引用该规则档的用户将回退到默认规则。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: () => confirmDelete(profile),
  });
}

onMounted(() => {
  if (route.query.new !== undefined) openCreate();
  load();
});
</script>

<template>
  <section class="page">
    <PageTopbar title="规则档" subtitle="规则 INI 与变体，以及被哪些用户使用">
      <n-button type="primary" @click="openCreate">
        <template #icon>
          <n-icon><NavIcon name="plus" /></n-icon>
        </template>
        新建规则档
      </n-button>
    </PageTopbar>

    <n-alert v-if="loadError" type="error" :bordered="false" role="alert">{{ loadError }}</n-alert>

    <n-form
      v-if="formOpen"
      id="profile-form"
      class="card form"
      @submit.prevent="submitForm"
    >
      <h2>{{ editingId === null ? '新建规则档' : `编辑规则档「${profiles.find((p) => p.id === editingId)?.name ?? ''}」` }}</h2>
      <n-form-item label="名称" :show-feedback="false">
        <n-input
          v-model:value="form.name"
          maxlength="100"
          autocomplete="off"
          :input-props="{ required: true }"
          :disabled="saving"
        />
      </n-form-item>
      <n-form-item label="INI URL（可选）" :show-feedback="false">
        <n-input
          v-model:value="form.iniUrl"
          type="text"
          inputmode="url"
          autocomplete="off"
          placeholder="https://example.com/rules.ini"
          :disabled="saving"
        />
      </n-form-item>
      <n-form-item label="INI 内容（可选）" :show-feedback="false">
        <n-input
          v-model:value="form.iniText"
          class="mono-input"
          type="textarea"
          :autosize="{ minRows: 6, maxRows: 14 }"
          spellcheck="false"
          placeholder="[custom_proxy_group]&#10;…"
          :disabled="saving"
        />
      </n-form-item>
      <p class="hint">INI URL 与 INI 内容至少填写一项。</p>
      <n-form-item label="变体" :show-feedback="false">
        <n-select v-model:value="form.variant" :options="variantOptions" :disabled="saving" />
      </n-form-item>
      <n-form-item label="DNS 模板（可选）" :show-feedback="false">
        <n-input
          v-model:value="form.dnsTemplate"
          class="mono-input"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 10 }"
          :disabled="saving"
        />
      </n-form-item>
      <n-form-item label="options（JSON 对象，可选）" :show-feedback="false">
        <n-input
          v-model:value="form.options"
          class="mono-input"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 10 }"
          spellcheck="false"
          placeholder='{ "ruleProviderCache": true }'
          :disabled="saving"
        />
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
    <n-empty v-else-if="profiles.length === 0" description="暂无规则档，点击右上角「新建规则档」开始。" class="empty" />

    <n-card v-else class="table-card" :bordered="false">
      <n-data-table
        :columns="profileColumns"
        :data="profiles"
        :row-key="profileRowKey"
        :bordered="false"
        :scroll-x="760"
      />
    </n-card>
  </section>
</template>

<style scoped>
.table-card {
  overflow: hidden;
}

.table-card :deep(.n-card__content) {
  padding: 0;
}

.table-card :deep(.profile-cell) {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.table-card :deep(.profile-name-line) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.table-card :deep(.profile-name) {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.table-card :deep(.profile-source) {
  min-width: 0;
}

.table-card :deep(.profile-url) {
  display: inline-block;
  max-width: 24rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.table-card :deep(.profile-meta) {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}

.table-card :deep(.row-actions) {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.mono-input :deep(textarea) {
  font-family: var(--font-mono);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

</style>
