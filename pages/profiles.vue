<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Rule profile admin page: cards with name, variant badge, INI source summary
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
const error = ref('');
const notice = ref('');

const editingId = ref<number | null>(null);
const formOpen = ref(false);
const form = ref<ProfileForm>(emptyForm());

const deleting = ref<AdminProfile | null>(null);

function emptyForm(): ProfileForm {
  return { name: '', iniUrl: '', iniText: '', variant: 'mihomo', dnsTemplate: '', options: '' };
}

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
  error.value = '';
  try {
    const res = await $fetch<{ items: AdminProfile[] }>('/api/admin/profiles');
    profiles.value = res.items;
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
  error.value = '';
  notice.value = '';
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
  error.value = '';
  notice.value = '';
  const name = form.value.name.trim();
  const iniUrl = form.value.iniUrl.trim();
  const iniText = form.value.iniText;
  if (!name) {
    error.value = '请填写名称';
    return;
  }
  if (!iniUrl && !iniText.trim()) {
    error.value = 'iniUrl 与 iniText 至少填写一个';
    return;
  }
  if (iniUrl && !validUrl(iniUrl)) {
    error.value = 'iniUrl 必须是 http 或 https 地址';
    return;
  }
  const options = form.value.options.trim();
  if (options) {
    try {
      const parsed: unknown = JSON.parse(options);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        error.value = 'options 必须是 JSON 对象';
        return;
      }
    } catch {
      error.value = 'options 不是合法的 JSON';
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
      notice.value = '规则档已创建';
    } else {
      const res = await $fetch<{ item: AdminProfile }>(`/api/admin/profiles/${editingId.value}`, {
        method: 'PATCH',
        body,
      });
      profiles.value = profiles.value.map((p) => (p.id === res.item.id ? res.item : p));
      notice.value = '规则档已更新';
    }
    closeForm();
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    saving.value = false;
  }
}

async function confirmDelete() {
  const profile = deleting.value;
  if (!profile || busyId.value !== null) return;
  busyId.value = profile.id;
  error.value = '';
  notice.value = '';
  try {
    await $fetch(`/api/admin/profiles/${profile.id}`, { method: 'DELETE' });
    profiles.value = profiles.value.filter((p) => p.id !== profile.id);
    notice.value = `已删除规则档「${profile.name}」`;
    if (editingId.value === profile.id) closeForm();
    deleting.value = null;
    await loadUsers();
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
    <PageTopbar title="规则档" subtitle="规则 INI 与变体，以及被哪些用户使用">
      <button class="primary" type="button" @click="openCreate">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建规则档
      </button>
    </PageTopbar>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form
      v-if="formOpen"
      id="profile-form"
      class="card form"
      @submit.prevent="submitForm"
    >
      <h2>{{ editingId === null ? '新建规则档' : `编辑规则档「${profiles.find((p) => p.id === editingId)?.name ?? ''}」` }}</h2>
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
        INI URL（可选）
        <input
          v-model="form.iniUrl"
          type="url"
          inputmode="url"
          autocomplete="off"
          placeholder="https://example.com/rules.ini"
          :disabled="saving"
        >
      </label>
      <label>
        INI 内容（可选）
        <textarea
          v-model="form.iniText"
          class="mono-input"
          rows="6"
          spellcheck="false"
          placeholder="[custom_proxy_group]&#10;…"
          :disabled="saving"
        />
      </label>
      <p class="hint">INI URL 与 INI 内容至少填写一项。</p>
      <label>
        变体
        <select v-model="form.variant" :disabled="saving">
          <option value="mihomo">mihomo</option>
          <option value="legacy">legacy（老 Clash）</option>
        </select>
      </label>
      <label>
        DNS 模板（可选）
        <textarea v-model="form.dnsTemplate" class="mono-input" rows="3" :disabled="saving" />
      </label>
      <label>
        options（JSON 对象，可选）
        <textarea
          v-model="form.options"
          class="mono-input"
          rows="3"
          spellcheck="false"
          placeholder='{ "ruleProviderCache": true }'
          :disabled="saving"
        />
      </label>
      <div class="actions">
        <button class="primary" type="submit" :disabled="saving">
          {{ saving ? '保存中…' : '保存' }}
        </button>
        <button type="button" :disabled="saving" @click="closeForm">取消</button>
      </div>
    </form>

    <p v-if="loading" class="muted empty">加载中…</p>
    <p v-else-if="profiles.length === 0" class="muted empty">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 2 9 5-9 5-9-5 9-5Z" />
        <path d="m3 12 9 5 9-5" />
        <path d="m3 17 9 5 9-5" />
      </svg>
      暂无规则档，点击右上角「新建规则档」开始。
    </p>

    <div v-else class="card-grid">
      <article v-for="profile in profiles" :key="profile.id" class="card profile">
        <div class="card-head">
          <h2 :title="profile.name">{{ profile.name }}</h2>
          <span :class="['badge', profile.variant === 'mihomo' ? 'on' : 'off']">
            {{ profile.variant }}
          </span>
        </div>

        <dl class="facts">
          <div>
            <dt>INI 来源</dt>
            <dd>
              <code v-if="profile.iniUrl" class="mono" :title="profile.iniUrl">
                {{ truncate(profile.iniUrl, 48) }}
              </code>
              <span v-if="profile.iniUrl && profile.iniText"> + </span>
              <span v-if="profile.iniText" class="sub">内联 {{ profile.iniText.length }} 字符</span>
              <span v-if="!profile.iniUrl && !profile.iniText" class="sub">—</span>
            </dd>
          </div>
          <div>
            <dt>用户</dt>
            <dd :title="usersLabel(profile)">{{ usersLabel(profile) }}</dd>
          </div>
          <div v-if="profile.dnsTemplate">
            <dt>DNS 模板</dt>
            <dd class="sub mono" :title="profile.dnsTemplate">{{ truncate(profile.dnsTemplate, 48) }}</dd>
          </div>
          <div v-if="profile.options">
            <dt>options</dt>
            <dd class="sub mono">{{ optionsSummary(profile) }}</dd>
          </div>
        </dl>

        <div class="entity-actions">
          <button type="button" class="small" :disabled="busyId !== null" @click="openEdit(profile)">
            编辑
          </button>
          <button
            type="button"
            class="small danger"
            :disabled="busyId !== null"
            @click="deleting = profile"
          >
            删除
          </button>
        </div>
      </article>
    </div>

    <div v-if="deleting" class="overlay" role="dialog" aria-modal="true" aria-labelledby="delete-profile-title">
      <div class="card dialog">
        <h2 id="delete-profile-title">删除规则档</h2>
        <p>确定删除「{{ deleting.name }}」？引用该规则档的用户将回退到默认规则。</p>
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
.profile {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.profile .card-head h2 {
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.facts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
}

.facts > div {
  display: grid;
  grid-template-columns: 5.5rem minmax(0, 1fr);
  gap: var(--space-2);
  align-items: baseline;
}

.facts dt {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  font-weight: 500;
}

.facts dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--foreground);
  font-size: var(--text-sm);
  word-break: break-word;
}

.mono-input {
  font-family: var(--font-mono);
}

@media (max-width: 640px) {
  .facts > div {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
}
</style>
