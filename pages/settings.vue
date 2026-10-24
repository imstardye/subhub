<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * 设置 page — site-level settings the owner changes without a redeploy.
 *
 * Currently one card, 「订阅链接」: the subscription URL *prefix* (`sub_path`
 * site setting). `/s/<token>` looks exactly like every airport's link and gets
 * blocked/targeted, so the prefix can be anything that is not an app route
 * (`dl`, `sub/x`, …). Saving a new prefix makes the exports move at once (the
 * server rewrites `/<prefix>/…` to the `/s/` implementation) and invalidates
 * every previously shared link — the form warns about that before saving.
 *
 * The page is SSR-fetched through `useRequestFetch()` (the session cookie is
 * only forwarded that way), and the layout's `admin-sub-path` state is updated
 * from the saved answer so copy-link buttons on other pages follow immediately.
 */
definePageMeta({ layout: 'admin' });

import { apiErrorMessage } from '~/core/utils/api-error';
import { validateSubPathInput, type SettingsView } from '~/core/utils/admin-ui';

const requestFetch = useRequestFetch();

const effectivePrefix = useState<string>('admin-sub-path', () => 's');
const settings = ref<SettingsView | null>(null);
const loading = ref(false);
const fetchError = ref<unknown>(null);

const draft = ref('');
const saving = ref(false);
const error = ref('');
const notice = ref('');

const currentPrefix = computed(() => settings.value?.subPath ?? effectivePrefix.value);
const reserved = computed(() => settings.value?.reservedRoots ?? []);

// Seed the input once the payload is there (SSR and client alike).
watch(
  currentPrefix,
  (value) => {
    if (!draft.value) draft.value = value;
  },
  { immediate: true },
);

const dirty = computed(() => draft.value.trim() !== currentPrefix.value);
const pageError = computed(() =>
  fetchError.value ? `设置加载失败：${apiErrorMessage(fetchError.value)}` : '',
);

async function refresh() {
  loading.value = true;
  fetchError.value = null;
  try {
    settings.value = await $fetch<SettingsView>('/api/admin/settings');
    effectivePrefix.value = settings.value.subPath;
    draft.value = settings.value.subPath;
  } catch (err) {
    fetchError.value = err;
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

async function save() {
  if (saving.value || !settings.value) return;
  error.value = '';
  notice.value = '';
  const checked = validateSubPathInput(draft.value, settings.value);
  if (!checked.ok) {
    error.value = checked.error;
    return;
  }
  if (checked.value === currentPrefix.value) {
    notice.value = '前缀未变化';
    return;
  }
  saving.value = true;
  try {
    const saved = await $fetch<SettingsView>('/api/admin/settings', {
      method: 'PUT',
      body: { subPath: checked.value },
    });
    settings.value = saved;
    draft.value = saved.subPath;
    // Every link builder reads this state (see layouts/admin.vue).
    effectivePrefix.value = saved.subPath;
    notice.value = `订阅链接前缀已改为「${saved.subPath}」，旧链接全部失效。`;
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    saving.value = false;
  }
}

function useDefault() {
  draft.value = settings.value?.defaultSubPath ?? 's';
}
</script>

<template>
  <section class="page">
    <PageTopbar title="设置" subtitle="站点级配置，保存后立即生效" />

    <p v-if="pageError" class="error" role="alert">{{ pageError }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <section class="card settings-card">
      <div class="card-head">
        <h2>订阅链接</h2>
        <button type="button" class="small" :disabled="loading" @click="refresh()">重新加载</button>
      </div>

      <p v-if="loading" class="muted">加载中…</p>
      <template v-else-if="settings">
        <p class="hint">
          订阅链接的前缀，当前为 <code class="mono">/{{ currentPrefix }}/</code>。
          客户端的链接形如 <code class="mono">/{{ currentPrefix }}/&lt;token&gt;/clash</code>。
          <code class="mono">/s/</code> 与常见机场完全一致，容易被针对，可改成任意其他路径。
        </p>

        <form class="form" @submit.prevent="save">
          <label>
            订阅前缀
            <input
              v-model="draft"
              type="text"
              class="short"
              maxlength="64"
              autocomplete="off"
              spellcheck="false"
              :disabled="saving"
            >
            <span class="field-hint">
              仅小写字母、数字、- 和 _，可用多段（如 <code class="mono">x/y</code>）；
              不能与后台入口 <code class="mono">/{{ settings?.adminPath }}</code>
              或系统路径（{{ reserved.join('、') }}）冲突。
            </span>
          </label>

          <p class="warn" role="note">
            修改前缀会<strong>立即让所有已分享的订阅链接失效</strong>，需要把新链接重新发给每个客户端。
          </p>

          <div class="actions">
            <button class="primary" type="submit" :disabled="saving || !dirty">
              {{ saving ? '保存中…' : '保存前缀' }}
            </button>
            <button type="button" :disabled="saving" @click="useDefault">恢复默认（{{ settings?.defaultSubPath }}）</button>
          </div>
        </form>
      </template>
    </section>
  </section>
</template>

<style scoped>
.settings-card {
  max-width: 46rem;
}

.hint {
  margin: 0 0 var(--space-4);
  color: var(--muted-foreground);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.form input.short {
  max-width: 18rem;
}

.field-hint {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  font-weight: 400;
}

.warn {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid rgba(217, 119, 6, 0.28);
  border-left: 3px solid #d97706;
  border-radius: var(--radius);
  background: rgba(217, 119, 6, 0.08);
  color: #92400e;
  font-size: var(--text-sm);
}
</style>
