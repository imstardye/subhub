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

import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpin, useMessage } from 'naive-ui';
import { apiErrorMessage } from '~/core/utils/api-error';
import { validateSubPathInput, type SettingsView } from '~/core/utils/admin-ui';

const requestFetch = useRequestFetch();

const effectivePrefix = useState<string>('admin-sub-path', () => 's');
const settings = ref<SettingsView | null>(null);
const loading = ref(false);
const fetchError = ref<unknown>(null);

const draft = ref('');
const saving = ref(false);
const message = useMessage();

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
  const checked = validateSubPathInput(draft.value, settings.value);
  if (!checked.ok) {
    message.error(checked.error);
    return;
  }
  if (checked.value === currentPrefix.value) {
    message.info('前缀未变化');
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
    message.success(`订阅链接前缀已改为「${saved.subPath}」，旧链接全部失效。`);
  } catch (err) {
    message.error(apiErrorMessage(err));
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

    <n-alert v-if="pageError" type="error" :bordered="false" role="alert">{{ pageError }}</n-alert>

    <n-card class="settings-card" title="订阅链接">
      <template #header-extra>
        <n-button size="small" secondary :disabled="loading" @click="refresh()">重新加载</n-button>
      </template>

      <n-spin v-if="loading" size="small">
        <span class="muted">加载中…</span>
      </n-spin>
      <template v-else-if="settings">
        <p class="hint">
          订阅链接的前缀，当前为 <code class="mono">/{{ currentPrefix }}/</code>。
          客户端的链接形如 <code class="mono">/{{ currentPrefix }}/&lt;token&gt;/clash</code>。
          <code class="mono">/s/</code> 与常见机场完全一致，容易被针对，可改成任意其他路径。
        </p>

        <n-form class="form" @submit.prevent="save">
          <n-form-item label="订阅前缀" :show-feedback="false">
            <div class="field-stack">
              <n-input
                v-model:value="draft"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
                :disabled="saving"
                class="short"
              />
              <span class="field-hint">
                仅小写字母、数字、- 和 _，可用多段（如 <code class="mono">x/y</code>）；
                不能与后台入口 <code class="mono">/{{ settings?.adminPath }}</code>
                或系统路径（{{ reserved.join('、') }}）冲突。
              </span>
            </div>
          </n-form-item>

          <n-alert type="warning" :bordered="false" role="note">
            修改前缀会<strong>立即让所有已分享的订阅链接失效</strong>，需要把新链接重新发给每个客户端。
          </n-alert>

          <div class="actions">
            <n-button type="primary" attr-type="submit" :loading="saving" :disabled="!dirty">
              {{ saving ? '保存中…' : '保存前缀' }}
            </n-button>
            <n-button :disabled="saving" @click="useDefault">恢复默认（{{ settings?.defaultSubPath }}）</n-button>
          </div>
        </n-form>
      </template>
    </n-card>
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

.field-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
}

.short {
  max-width: 18rem;
}

.field-hint {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  font-weight: 400;
}
</style>
