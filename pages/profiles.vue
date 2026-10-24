<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Rule profile admin page: list, create, edit and delete.
 *
 * Talks to /api/admin/profiles. INIs are not secrets, so the form round-trips
 * `iniUrl` / `iniText` verbatim; the API requires at least one of them and an
 * http(s) `iniUrl`. `options` is edited as JSON text and only parsed on save.
 */
definePageMeta({ layout: 'admin' });

import type { AdminProfile } from '~/server/utils/admin-profiles';
import { apiErrorMessage } from '~/core/utils/api-error';
import type { ProfileVariant } from '~/server/utils/admin-validation';

interface ProfileForm {
  name: string;
  iniUrl: string;
  iniText: string;
  variant: ProfileVariant;
  dnsTemplate: string;
  options: string;
}

const profiles = ref<AdminProfile[]>([]);
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
}

function openCreate() {
  editingId.value = null;
  form.value = emptyForm();
  formOpen.value = true;
  error.value = '';
  notice.value = '';
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
      <h1>规则档</h1>
      <button class="primary" type="button" @click="openCreate">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        新建规则档
      </button>
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <form v-if="formOpen" class="card form" @submit.prevent="submitForm">
      <h2>{{ editingId === null ? '新建规则档' : `编辑规则档 #${editingId}` }}</h2>
      <label>
        名称
        <input v-model="form.name" type="text" maxlength="100" required :disabled="saving">
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
        <textarea v-model="form.dnsTemplate" rows="3" :disabled="saving" />
      </label>
      <label>
        options（JSON 对象，可选）
        <textarea
          v-model="form.options"
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
      暂无规则档。
    </p>

    <div v-else class="table-wrap">
      <table class="list">
        <thead>
          <tr>
            <th>ID</th>
            <th>名称</th>
            <th>变体</th>
            <th>INI 来源</th>
            <th>DNS 模板</th>
            <th>options</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="profile in profiles" :key="profile.id">
            <td class="id-cell">{{ profile.id }}</td>
            <td>{{ profile.name }}</td>
            <td>
              <span :class="['badge', profile.variant === 'mihomo' ? 'on' : 'off']">
                {{ profile.variant }}
              </span>
            </td>
            <td class="source">
              <code v-if="profile.iniUrl">{{ profile.iniUrl }}</code>
              <span v-if="profile.iniUrl && profile.iniText" class="sub">+ </span>
              <span v-if="profile.iniText" class="sub">内联 INI（{{ profile.iniText.length }} 字符）</span>
              <span v-if="!profile.iniUrl && !profile.iniText" class="sub">—</span>
            </td>
            <td class="source">
              <span v-if="profile.dnsTemplate" class="sub">{{ profile.dnsTemplate }}</span>
              <span v-else class="sub">—</span>
            </td>
            <td class="sub mono">{{ optionsSummary(profile) }}</td>
            <td class="row-actions">
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
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="deleting" class="overlay" role="dialog" aria-modal="true">
      <div class="card dialog">
        <h2>删除规则档</h2>
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
.id-cell {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--muted-foreground);
}
.source {
  max-width: 18rem;
  word-break: break-word;
}
.source code {
  display: block;
  color: var(--foreground);
}
</style>
