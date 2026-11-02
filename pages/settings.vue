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

import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpin, NSwitch, NTag, useMessage } from 'naive-ui';
import { apiErrorMessage } from '~/core/utils/api-error';
import { validateSubPathInput, type SettingsView } from '~/core/utils/admin-ui';
import {
  oidcAdminUrls,
  oidcSavePayload,
  oidcSecretLabel,
  type OidcSettingsView,
} from '~/core/utils/oidc';

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

/* ------------------------------------------------------------------ XAuth -- */
/**
 * XAuth (OIDC) client settings — stored in the same app-settings table as the
 * prefix (never env vars). The client secret is write-only: the field always
 * starts empty, `已配置/未配置` is the only thing the server reports, blank =
 * keep, and 清除 clears it explicitly.
 */
const oidcDraft = reactive({
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  clearClientSecret: false,
  scopes: 'openid profile email',
});
const oidcSaving = ref(false);
const oidcLoaded = ref(false);

function seedOidc(oidc: OidcSettingsView | undefined) {
  if (!oidc) return;
  oidcDraft.enabled = oidc.enabled;
  oidcDraft.issuer = oidc.issuer;
  oidcDraft.clientId = oidc.clientId;
  oidcDraft.scopes = oidc.scopes;
  oidcDraft.clientSecret = '';
  oidcDraft.clearClientSecret = false;
  oidcLoaded.value = true;
}

watch(settings, (value) => seedOidc(value?.oidc), { immediate: true });

/** Current site origin — the URLs the admin must register at the IdP. */
const siteOrigin = ref('');
onMounted(() => {
  siteOrigin.value = window.location.origin;
});
const oidcUrls = computed(() => oidcAdminUrls(siteOrigin.value));

const oidcActive = computed(() => settings.value?.oidc.active ?? false);
const oidcSecretSet = computed(() => settings.value?.oidc.clientSecretSet ?? false);

async function copyUrl(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success(`${label}已复制`);
  } catch {
    message.error('复制失败，请手动复制');
  }
}

async function saveOidc() {
  if (oidcSaving.value) return;
  oidcSaving.value = true;
  try {
    const saved = await $fetch<SettingsView>('/api/admin/settings', {
      method: 'PUT',
      body: { oidc: oidcSavePayload(oidcDraft) },
    });
    settings.value = saved;
    seedOidc(saved.oidc);
    message.success(saved.oidc.active ? 'XAuth 已启用' : 'XAuth 设置已保存');
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    oidcSaving.value = false;
  }
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

    <n-card class="settings-card" title="XAuth 登录（OIDC）">
      <template #header-extra>
        <n-tag size="small" round :type="oidcActive ? 'success' : 'default'" :bordered="false">
          {{ oidcActive ? '已启用' : '未启用' }}
        </n-tag>
      </template>

      <p class="hint">
        仅用于 <code class="mono">/my</code> 用户中心登录，管理后台不经过 XAuth。用户由管理员预先创建：
        填写「预绑邮箱」后，用户首次使用 XAuth 登录时认领绑定；绑定后密码登录停用，解绑后恢复。
        未匹配到用户的身份一律拒绝，不会自动注册。
      </p>

      <n-spin v-if="loading && !oidcLoaded" size="small">
        <span class="muted">加载中…</span>
      </n-spin>
      <n-form v-else class="form" @submit.prevent="saveOidc">
        <n-form-item label="启用 XAuth 登录" :show-feedback="false">
          <n-switch v-model:value="oidcDraft.enabled" :disabled="oidcSaving">
            <template #checked>启用</template>
            <template #unchecked>停用</template>
          </n-switch>
        </n-form-item>
        <n-form-item label="Issuer" :show-feedback="false">
          <div class="field-stack">
            <n-input
              v-model:value="oidcDraft.issuer"
              placeholder="https://id.example.com"
              autocomplete="off"
              spellcheck="false"
              :disabled="oidcSaving"
            />
            <span class="field-hint">XAuth 的 issuer 地址（用于发现 endpoints 与校验 ID token），不要带查询参数。</span>
          </div>
        </n-form-item>
        <n-form-item label="Client ID" :show-feedback="false">
          <n-input
            v-model:value="oidcDraft.clientId"
            autocomplete="off"
            spellcheck="false"
            :disabled="oidcSaving"
          />
        </n-form-item>
        <n-form-item label="Client Secret" :show-feedback="false">
          <div class="field-stack">
            <div class="secret-row">
              <n-input
                v-model:value="oidcDraft.clientSecret"
                type="password"
                show-password-on="click"
                autocomplete="new-password"
                :placeholder="oidcSecretSet ? '已配置，留空表示不修改' : '粘贴 client secret'"
                :disabled="oidcSaving || oidcDraft.clearClientSecret"
              />
              <n-tag size="small" :type="oidcDraft.clearClientSecret ? 'warning' : oidcSecretSet ? 'success' : 'default'">
                {{ oidcDraft.clearClientSecret ? '将清除' : oidcSecretLabel(oidcSecretSet) }}
              </n-tag>
              <n-button
                v-if="oidcSecretSet && !oidcDraft.clearClientSecret"
                secondary
                type="error"
                size="small"
                :disabled="oidcSaving"
                @click="oidcDraft.clearClientSecret = true"
              >
                清除
              </n-button>
              <n-button
                v-else-if="oidcDraft.clearClientSecret"
                secondary
                size="small"
                :disabled="oidcSaving"
                @click="oidcDraft.clearClientSecret = false"
              >
                撤销
              </n-button>
            </div>
            <span class="field-hint">写入后不可查看（写-only），留空保持不变，点「清除」后保存即可删除。</span>
          </div>
        </n-form-item>
        <n-form-item label="Scopes" :show-feedback="false">
          <div class="field-stack">
            <n-input
              v-model:value="oidcDraft.scopes"
              autocomplete="off"
              spellcheck="false"
              :disabled="oidcSaving"
            />
            <span class="field-hint">
              默认 <code class="mono">openid profile email</code>；v1 不申请 offline_access，登录态由本站 30 天的会话 cookie 维持。
            </span>
          </div>
        </n-form-item>

        <n-form-item label="回调地址（在 XAuth 中注册为 Redirect URI）" :show-feedback="false">
          <div class="url-row">
            <code class="mono url-text">{{ oidcUrls.redirectUri }}</code>
            <n-button size="small" secondary :disabled="!siteOrigin" @click="copyUrl(oidcUrls.redirectUri, '回调地址')">
              复制
            </n-button>
          </div>
        </n-form-item>
        <n-form-item label="退出后跳转地址（Post Logout URI）" :show-feedback="false">
          <div class="url-row">
            <code class="mono url-text">{{ oidcUrls.postLogoutUri }}</code>
            <n-button size="small" secondary :disabled="!siteOrigin" @click="copyUrl(oidcUrls.postLogoutUri, '退出跳转地址')">
              复制
            </n-button>
          </div>
        </n-form-item>

        <div class="actions">
          <n-button type="primary" attr-type="submit" :loading="oidcSaving">
            {{ oidcSaving ? '保存中…' : '保存 XAuth 设置' }}
          </n-button>
        </div>
        <p v-if="oidcDraft.enabled && !oidcActive" class="field-hint">
          XAuth 仅在「启用」且 Issuer、Client ID、Client Secret 全部配置后生效；未生效时 /auth 路由返回 404。
        </p>
      </n-form>
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

.secret-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

.secret-row :deep(.n-input) {
  flex: 1;
}

.url-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

/* The two cards stack at the page gap radius (no global .page glue needed). */
.settings-card + .settings-card {
  margin-top: var(--space-5);
}

.url-text {
  flex: 1;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--muted, #f1f5f9);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
</style>
