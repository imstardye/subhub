<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Self-service user center — `/my/<token>`.
 *
 * PUBLIC page: the token in the URL identifies the account, and a password gate
 * protects it. Opening the page asks the server for the data; the server answers
 * 401 `needs-setup` (no password yet -> 设置密码) or `needs-password` (-> 输入密码)
 * unless the signed `subhub_my` cookie matches the user and password version.
 * The subscription export (`/<prefix>/<token>/...`) is not gated — clients must
 * keep fetching it automatically.
 *
 * Mobile-first, light theme. Chinese labels. Everything it shows is decided in
 * `core/utils/user-center.ts` (pure, unit-tested): the payload never carries a
 * source URL, the write-only hint, the link table, the traffic cards and the
 * inclusion list are all rendered from those helpers.
 *
 * Profile switcher: choosing a profile only rebuilds the links (with the
 * `/<profileName>` suffix). It never writes `users.profileId`, so a reload
 * returns to the assigned profile.
 */
definePageMeta({ layout: false });

import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NIcon, NInput, NModal, NProgress, NSelect, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui';
import { apiErrorMessage } from '~/core/utils/api-error';
import { qrSvgPath } from '~/core/utils/qr';
import {
  confirmPasswordError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validatePassword,
} from '~/core/utils/user-password';
import {
  HEALTH_LABELS,
  TARGET_LABELS,
  URL_WRITE_ONLY_HINT,
  applyInclusion,
  applySourceDelete,
  deleteSourceConfirmText,
  editFormFromSource,
  groupAvailableSources,
  lastRefreshLabel,
  mainLink,
  maskUserToken,
  originFromLocation,
  ownSourceStats,
  profileChoices,
  sourceCreatePayload,
  sourcePatchPayload,
  summaryBar,
  targetLinks,
  trafficCard,
  userCenterApiPath,
  userCenterLockFromError,
  userCenterPath,
  userCenterView,
  type UserCenterPayload,
} from '~/core/utils/user-center';
import type { UserCenterOwnSource } from '~/server/utils/user-center';

const route = useRoute();
const token = computed(() => String(route.params.token ?? ''));
const message = useMessage();
const dialog = useDialog();
/** Forwards the session cookie during SSR; plain `$fetch` on the client. */
const requestFetch = useRequestFetch();

const { data, pending, error, refresh } = await useAsyncData(
  () => `user-center-${token.value}`,
  // `useRequestFetch` forwards the browser's session cookie during SSR, so a
  // returning user gets the dashboard on the first paint instead of the
  // password form. The bare `$fetch` is anonymous server-side.
  () => requestFetch<UserCenterPayload>(userCenterApiPath(token.value, '')),
  { watch: [token] },
);

const lock = computed(() => userCenterLockFromError(error.value));
const view = computed(() =>
  userCenterView({
    data: data.value,
    error: error.value ? apiErrorMessage(error.value) : null,
    pending: pending.value,
    lock: lock.value,
  }),
);
const center = computed(() => (view.value.kind === 'ready' ? view.value.data : null));

/**
 * Request origin, taken from the browser itself after mount. The API's
 * reported origin is NOT a usable fallback: behind a reverse proxy the
 * server sees the internal host (`http://localhost`), and links built from
 * it are wrong for the user. Before mount the links stay relative (they
 * resolve against the page address) and become absolute once mounted.
 */
const origin = ref('');
onMounted(() => {
  origin.value = originFromLocation(window.location);
});

const linkOrigin = computed(() => origin.value);

/** Profile switcher state ('' = the assigned profile, i.e. no suffix). */
const selectedProfile = ref<string | null>(null);
const profileOptions = computed(() =>
  center.value ? profileChoices(center.value.profile.profileNames, center.value.profile.assignedProfile) : [],
);
const profileSelectOptions = computed(() =>
  profileOptions.value.map((option) => ({ label: option.label, value: option.name ?? '' })),
);
const selectedProfileValue = computed({
  get: () => selectedProfile.value ?? '',
  set: (value: string) => {
    selectedProfile.value = value === '' ? null : value;
  },
});
const links = computed(() =>
  center.value
    ? targetLinks({
        origin: linkOrigin.value,
        token: center.value.user.token,
        assignedProfile: center.value.profile.assignedProfile,
        profile: selectedProfile.value,
        subPrefix: center.value.subPrefix,
      })
    : [],
);
const currentMainLink = computed(() =>
  center.value
    ? mainLink({
        origin: linkOrigin.value,
        token: center.value.user.token,
        assignedProfile: center.value.profile.assignedProfile,
        profile: selectedProfile.value,
        subPrefix: center.value.subPrefix,
      })
    : '',
);

/* ----------------------------------------------------------------- QR code -- */
const qrSvg = ref<string | null>(null);
watch(
  currentMainLink,
  async (link) => {
    // A relative link (pre-mount, origin unknown) is useless in a QR code;
    // wait for the absolute form once the client origin is known.
    qrSvg.value = link.startsWith('http') ? await qrSvgPath(link) : null;
  },
  { immediate: true },
);

/* -------------------------------------------------------------- clipboard -- */
const copied = ref('');
async function copy(text: string, id: string) {
  copied.value = '';
  try {
    await navigator.clipboard.writeText(text);
    copied.value = id;
    setTimeout(() => {
      if (copied.value === id) copied.value = '';
    }, 1600);
  } catch {
    copied.value = '';
  }
}

/* --------------------------------------------------------------- actions -- */
const busy = ref(false);

/** Inclusion toggle for a public/shared source. */
async function toggleIncluded(sourceId: number, included: boolean) {
  if (!center.value || busy.value) return;
  busy.value = true;
  const previous = center.value.availableSources;
  center.value.availableSources = applyInclusion(previous, sourceId, included);
  try {
    await $fetch(userCenterApiPath(token.value, 'choices'), {
      method: 'POST',
      body: { sourceId, included },
    });
    message.success(included ? '已加入订阅' : '已从订阅中移除');
  } catch (err) {
    center.value.availableSources = previous;
    message.error(apiErrorMessage(err));
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------ add source -- */
const addOpen = ref(false);
const addForm = reactive({ name: '', url: '', userAgent: '' });
const adding = ref(false);

function openAdd() {
  addForm.name = '';
  addForm.url = '';
  addForm.userAgent = '';
  addOpen.value = true;
}

async function submitAdd() {
  if (adding.value) return;
  if (!addForm.name.trim()) {
    message.error('请填写名称');
    return;
  }
  if (!addForm.url.trim()) {
    message.error('请填写订阅链接');
    return;
  }
  adding.value = true;
  try {
    await $fetch(userCenterApiPath(token.value, 'sources'), {
      method: 'POST',
      body: sourceCreatePayload({ ...addForm }),
    });
    addForm.name = '';
    addForm.url = '';
    addForm.userAgent = '';
    addOpen.value = false;
    message.success('订阅源已添加');
    await refresh();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    adding.value = false;
  }
}

/* --------------------------------------------------------- edit source -- */
const editing = ref<UserCenterOwnSource | null>(null);
const editForm = reactive({ name: '', enabled: true, userAgent: '', url: '' });
const savingEdit = ref(false);

function openEdit(source: UserCenterOwnSource) {
  editing.value = source;
  // The URL field is always empty: a saved link can never be shown again.
  Object.assign(editForm, editFormFromSource(source));
}

async function submitEdit() {
  if (!editing.value || savingEdit.value) return;
  if (!editForm.name.trim()) {
    message.error('请填写名称');
    return;
  }
  savingEdit.value = true;
  try {
    await $fetch(userCenterApiPath(token.value, `sources/${editing.value.id}`), {
      method: 'PATCH',
      body: sourcePatchPayload({ ...editForm }),
    });
    editForm.url = '';
    editing.value = null;
    message.success('已保存');
    await refresh();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    savingEdit.value = false;
  }
}

/* ------------------------------------------------------ delete source -- */
/**
 * Delete confirmation: the dialog spells the source name out (防误删). Only the
 * owner's dedicated sources can be deleted; the server answers 404 otherwise.
 */
function askDelete(source: UserCenterOwnSource) {
  editing.value = null;
  dialog.warning({
    title: '删除订阅源',
    content: `${deleteSourceConfirmText(source.name)} 该订阅源会从你的订阅链接中移除，已合并的公共 / 共享订阅源不受影响。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: () => confirmDelete(source),
  });
}

async function confirmDelete(target: UserCenterOwnSource) {
  if (!center.value) return;
  try {
    await $fetch(userCenterApiPath(token.value, `sources/${target.id}`), { method: 'DELETE' });
    // Update both lists from the answer immediately (cards + 流量概览), then
    // reconcile with the server (summary, node counts, links).
    const next = applySourceDelete(center.value, target.id);
    center.value.ownSources = next.ownSources;
    center.value.traffic.sources = next.trafficSources;
    message.success(`已删除订阅源「${target.name}」`);
    await refresh();
  } catch (err) {
    message.error(apiErrorMessage(err));
  }
}

/* ------------------------------------------------------------ token refresh -- */
const rotating = ref(false);

function askRotate() {
  dialog.warning({
    title: '重置 Token',
    content: '重置后旧链接立即失效，需要重新导入新链接。',
    positiveText: '确认重置',
    negativeText: '取消',
    onPositiveClick: () => rotateToken(),
  });
}

async function rotateToken() {
  if (rotating.value) return;
  rotating.value = true;
  try {
    const result = await $fetch<{ token: string }>(userCenterApiPath(token.value, 'refresh'), {
      method: 'POST',
    });
    await navigateTo(userCenterPath(result.token), { replace: true });
  } catch (err) {
    message.error(apiErrorMessage(err));
    rotating.value = false;
  }
}

/* --------------------------------------------------------- password gate -- */
/**
 * Setup vs. unlock form. The server decides which one is needed and answers
 * 401 with `{ status }`; `lock` above mirrors that. Setup also asks for the
 * confirmation field (client-side only — the server never needs it).
 */
const authForm = reactive({ password: '', confirm: '' });
const authBusy = ref(false);
const authError = ref('');

async function submitAuth() {
  const mode = view.value.kind === 'locked' ? view.value.lock : null;
  if (!mode || authBusy.value) return;
  const checked = validatePassword(authForm.password);
  if (!checked.ok) {
    authError.value = checked.error;
    return;
  }
  if (mode === 'needs-setup') {
    const mismatch = confirmPasswordError(checked.password, authForm.confirm);
    if (mismatch) {
      authError.value = mismatch;
      return;
    }
  }
  authBusy.value = true;
  authError.value = '';
  try {
    await $fetch(userCenterApiPath(token.value, mode === 'needs-setup' ? 'password' : 'unlock'), {
      method: 'POST',
      body: { password: checked.password },
    });
    authForm.password = '';
    authForm.confirm = '';
    await refresh();
  } catch (err) {
    // A password reset while this page was open switches the required form.
    const nextLock = userCenterLockFromError(err);
    if (nextLock && nextLock !== mode) {
      await refresh();
    } else {
      authError.value = apiErrorMessage(err);
    }
  } finally {
    authBusy.value = false;
  }
}

/* ------------------------------------------------------- change password -- */
const passwordOpen = ref(false);
const passwordForm = reactive({ currentPassword: '', newPassword: '', confirm: '' });
const passwordBusy = ref(false);

function openPasswordChange() {
  passwordForm.currentPassword = '';
  passwordForm.newPassword = '';
  passwordForm.confirm = '';
  passwordOpen.value = true;
}

function closePasswordChange() {
  passwordOpen.value = false;
  passwordForm.currentPassword = '';
  passwordForm.newPassword = '';
  passwordForm.confirm = '';
}

async function submitPasswordChange() {
  if (passwordBusy.value) return;
  const checked = validatePassword(passwordForm.newPassword);
  if (!checked.ok) {
    message.error(checked.error);
    return;
  }
  const mismatch = confirmPasswordError(checked.password, passwordForm.confirm);
  if (mismatch) {
    message.error(mismatch);
    return;
  }
  if (!passwordForm.currentPassword) {
    message.error('请填写当前密码');
    return;
  }
  passwordBusy.value = true;
  try {
    await $fetch(userCenterApiPath(token.value, 'password'), {
      method: 'PUT',
      body: {
        currentPassword: passwordForm.currentPassword,
        newPassword: checked.password,
      },
    });
    message.success('密码已修改，其他设备需要重新输入密码');
    closePasswordChange();
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    passwordBusy.value = false;
  }
}

/* ---------------------------------------------------------------- derived -- */
const cards = computed(() => (center.value ? center.value.traffic.sources.map((card) => trafficCard(card)) : []));
const summary = computed(() => (center.value ? summaryBar(center.value.traffic.summary) : summaryBar(null)));
const availableGroups = computed(() =>
  center.value ? groupAvailableSources(center.value.availableSources) : [],
);
const ownStats = computed(() => ownSourceStats(center.value?.ownSources ?? []));
const targets = TARGET_LABELS;

function ownSourceById(id: number): UserCenterOwnSource | null {
  return center.value?.ownSources.find((source) => source.id === id) ?? null;
}

function editSourceById(id: number) {
  const source = ownSourceById(id);
  if (source) openEdit(source);
}

function askDeleteById(id: number) {
  const source = ownSourceById(id);
  if (source) askDelete(source);
}

function healthType(state: 'ok' | 'failed' | 'never'): 'success' | 'error' | 'warning' {
  if (state === 'ok') return 'success';
  if (state === 'failed') return 'error';
  return 'warning';
}

useHead({ title: '我的订阅 · subhub' });
</script>

<template>
  <main class="my">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">S</span>
        <div>
          <h1>我的订阅</h1>
          <p v-if="center" class="sub">{{ center.user.name }}</p>
        </div>
      </div>
      <n-button v-if="center" secondary size="small" :loading="pending" @click="refresh()">
        刷新
      </n-button>
    </header>

    <div v-if="view.kind === 'loading'" class="state">
      <n-spin size="small" />
      <span>正在加载…</span>
    </div>

    <n-card v-else-if="view.kind === 'locked'" class="state-card auth-card">
      <template #header>
        {{ view.lock === 'needs-setup' ? '设置访问密码' : '输入访问密码' }}
      </template>
      <p class="hint">
        {{ view.lock === 'needs-setup'
          ? `首次进入请设置密码（${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符），之后凭密码进入本页。`
          : '该账号已设置密码，请输入后进入。' }}
      </p>
      <n-form class="form" @submit.prevent="submitAuth">
        <n-form-item :label="view.lock === 'needs-setup' ? '设置密码' : '密码'" :show-feedback="false">
          <n-input
            v-model:value="authForm.password"
            type="password"
            show-password-on="click"
            :autocomplete="view.lock === 'needs-setup' ? 'new-password' : 'current-password'"
            :maxlength="PASSWORD_MAX_LENGTH"
            placeholder="请输入密码"
            :disabled="authBusy"
            :input-props="{ 'aria-label': view.lock === 'needs-setup' ? '设置密码' : '密码' }"
          />
        </n-form-item>
        <n-form-item v-if="view.lock === 'needs-setup'" label="确认密码" :show-feedback="false">
          <n-input
            v-model:value="authForm.confirm"
            type="password"
            show-password-on="click"
            autocomplete="new-password"
            :maxlength="PASSWORD_MAX_LENGTH"
            placeholder="再次输入密码"
            :disabled="authBusy"
            :input-props="{ 'aria-label': '确认密码' }"
          />
        </n-form-item>
        <n-alert v-if="authError" type="error" :bordered="false" role="alert">{{ authError }}</n-alert>
        <div class="row">
          <n-button type="primary" attr-type="submit" :loading="authBusy">
            {{ authBusy ? '处理中…' : view.lock === 'needs-setup' ? '设置并进入' : '进入' }}
          </n-button>
        </div>
      </n-form>
    </n-card>

    <n-card v-else-if="view.kind === 'error'" class="state-card">
      <p class="state-title">{{ view.message }}</p>
      <p class="hint">请确认链接完整，或联系管理员重新获取。</p>
    </n-card>

    <n-card v-else-if="view.kind === 'disabled'" class="state-card">
      <p class="state-title">{{ view.title }}</p>
      <p class="hint">{{ view.message }}</p>
    </n-card>

    <template v-else-if="center">
      <section class="overview-grid">
        <n-card class="stat stat-traffic">
          <div class="stat-head">
            <span class="stat-label">流量概览</span>
            <n-tag v-if="summary.empty" size="small">暂无数据</n-tag>
          </div>
          <p v-if="summary.empty" class="hint">暂无流量数据</p>
          <template v-else>
            <div class="traffic-numbers">
              <span class="big">{{ summary.usedLabel }}</span>
              <span class="muted">/ {{ summary.totalLabel }}</span>
            </div>
            <n-progress
              v-if="summary.percent !== null"
              type="line"
              :percentage="summary.percent"
              :show-indicator="false"
              :height="8"
            />
            <div class="stat-facts">
              <span>剩余 <b>{{ summary.remainingLabel }}</b></span>
              <span>到期 <b>{{ summary.expireLabel }}</b></span>
            </div>
          </template>
          <p class="hint tiny">
            仅统计专属订阅源（{{ center.traffic.summary.sourcesWithUserinfo }}/{{ center.traffic.summary.dedicatedCount }} 个有数据）
          </p>
        </n-card>

        <n-card class="stat">
          <span class="stat-label">节点总数</span>
          <div class="stat-value">{{ ownStats.nodes }}</div>
          <p class="hint tiny">专属订阅源合计 · 已扣除信息节点</p>
        </n-card>

        <n-card class="stat">
          <span class="stat-label">订阅源状态</span>
          <div class="status-row">
            <n-tag type="success" size="small" round>正常 {{ ownStats.healthy }}</n-tag>
            <n-tag :type="ownStats.failing ? 'error' : 'default'" size="small" round>异常 {{ ownStats.failing }}</n-tag>
          </div>
          <p class="hint tiny">共 {{ ownStats.total }} 个专属订阅源</p>
        </n-card>

        <n-card class="stat">
          <span class="stat-label">到期信息</span>
          <div class="stat-value small">{{ summary.expireLabel }}</div>
          <p class="hint tiny">取自专属订阅源的套餐信息</p>
        </n-card>
      </section>

      <div class="dashboard-grid">
        <!-- ------------------------------------------------------- links -- -->
        <n-card class="panel panel-links" title="订阅链接">
          <div v-if="profileOptions.length > 1" class="field">
            <span class="field-label">规则档</span>
            <n-select v-model:value="selectedProfileValue" :options="profileSelectOptions" />
          </div>

          <div class="main-link">
            <code>{{ currentMainLink }}</code>
            <n-button size="small" secondary @click="copy(currentMainLink, 'main')">
              {{ copied === 'main' ? '已复制' : '复制' }}
            </n-button>
          </div>
          <div v-if="qrSvg" class="qr" aria-label="当前主链接二维码">
            <div class="qr-image" v-html="qrSvg" />
            <p class="hint tiny">扫描导入当前主链接</p>
          </div>

          <ul class="links">
            <li v-for="link in links" :key="link.target">
              <div class="link-name">{{ link.label }}</div>
              <code>{{ link.url }}</code>
              <n-button size="tiny" secondary @click="copy(link.url, link.target)">
                {{ copied === link.target ? '已复制' : '复制' }}
              </n-button>
            </li>
          </ul>
          <p class="hint tiny">
            切换规则档只改变上面的链接，不会修改账号默认规则档。Token：{{ maskUserToken(center.user.token) }}
          </p>
        </n-card>

        <!-- --------------------------------------------------- own sources -- -->
        <n-card class="panel panel-sources">
          <template #header>我的订阅源</template>
          <template #header-extra>
            <n-button type="primary" size="small" @click="openAdd">添加订阅源</n-button>
          </template>

          <p v-if="center.ownSources.length" class="hint tiny">
            共 {{ ownStats.total }} 个 · 正常 {{ ownStats.healthy }} · 异常 {{ ownStats.failing }} · 节点 {{ ownStats.nodes }}
          </p>

          <div v-if="cards.length" class="source-grid">
            <n-card
              v-for="(card, index) in cards"
              :key="center.traffic.sources[index]!.id"
              size="small"
              class="source-card"
            >
              <div class="source-head">
                <strong>{{ card.name }}</strong>
                <n-tag size="small" round :type="healthType(card.healthState)">
                  {{ card.healthLabel }}
                </n-tag>
              </div>

              <p v-if="card.empty" class="hint tiny">暂无流量数据</p>
              <template v-else>
                <n-progress
                  v-if="card.percent !== null"
                  type="line"
                  :percentage="card.percent"
                  :show-indicator="false"
                  :height="6"
                />
                <div class="source-facts">
                  <span>已用 <b>{{ card.usedLabel }}</b></span>
                  <span>总量 <b>{{ card.totalLabel }}</b></span>
                  <span>剩余 <b>{{ card.remainingLabel }}</b></span>
                  <span>到期 <b>{{ card.expireLabel }}</b></span>
                </div>
                <p v-if="card.rawFields.length" class="hint tiny">
                  剩余 / 到期取自订阅自身报告的信息节点
                </p>
              </template>

              <p class="hint tiny">
                {{ card.lastRefresh }}
                <span v-if="center.traffic.sources[index]!.enabled === false"> · 已暂停</span>
                <span v-if="card.healthError"> · {{ card.healthError }}</span>
              </p>

              <div class="row">
                <n-button size="tiny" secondary @click="editSourceById(center.traffic.sources[index]!.id)">
                  编辑
                </n-button>
                <n-button
                  size="tiny"
                  secondary
                  type="error"
                  @click="askDeleteById(center.traffic.sources[index]!.id)"
                >
                  删除
                </n-button>
              </div>
            </n-card>
          </div>
          <n-empty v-else description="还没有专属订阅源。" />
        </n-card>

        <!-- ----------------------------------------------- inclusion list -- -->
        <n-card class="panel panel-shared" title="公共 / 共享订阅源">
          <p v-if="!availableGroups.length" class="hint">暂无可选订阅源。</p>
          <div v-for="group in availableGroups" :key="group.kind" class="group">
            <h3>{{ group.label }}</h3>
            <div v-for="source in group.items" :key="source.id" class="toggle-row">
              <span>{{ source.name }}</span>
              <n-switch
                :value="source.included"
                :disabled="busy"
                :aria-label="`${source.name} 是否加入订阅`"
                @update:value="(value) => toggleIncluded(source.id, value)"
              />
            </div>
          </div>
          <p class="hint tiny">取消勾选后，该订阅源不会出现在你的订阅链接中。</p>
        </n-card>

        <!-- ------------------------------------------------------ password -- -->
        <n-card class="panel panel-password" title="访问密码">
          <p class="hint tiny">修改后其他设备上的登录会失效，需要重新输入新密码。</p>
          <div class="row">
            <n-button secondary @click="openPasswordChange">修改密码</n-button>
          </div>
        </n-card>

        <!-- ------------------------------------------------------- rotate -- -->
        <n-card class="panel panel-token" title="重置 Token">
          <p class="hint tiny">重置后旧链接立即失效，需要重新导入新链接。</p>
          <div class="row">
            <n-button secondary :loading="rotating" @click="askRotate">重置 Token</n-button>
          </div>
        </n-card>
      </div>
    </template>

    <!-- ---------------------------------------------------- change password -- -->
    <n-modal
      :show="passwordOpen"
      preset="card"
      class="modal-card"
      title="修改密码"
      @update:show="(value) => { if (!value) closePasswordChange(); }"
    >
      <n-form class="form" @submit.prevent="submitPasswordChange">
        <n-form-item label="当前密码" :show-feedback="false">
          <n-input
            v-model:value="passwordForm.currentPassword"
            type="password"
            show-password-on="click"
            autocomplete="current-password"
            :disabled="passwordBusy"
            :input-props="{ 'aria-label': '当前密码' }"
          />
        </n-form-item>
        <n-form-item label="新密码" :show-feedback="false">
          <n-input
            v-model:value="passwordForm.newPassword"
            type="password"
            show-password-on="click"
            autocomplete="new-password"
            :maxlength="PASSWORD_MAX_LENGTH"
            :placeholder="`${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 个字符`"
            :disabled="passwordBusy"
            :input-props="{ 'aria-label': '新密码' }"
          />
        </n-form-item>
        <n-form-item label="确认新密码" :show-feedback="false">
          <n-input
            v-model:value="passwordForm.confirm"
            type="password"
            show-password-on="click"
            autocomplete="new-password"
            :maxlength="PASSWORD_MAX_LENGTH"
            :disabled="passwordBusy"
            :input-props="{ 'aria-label': '确认新密码' }"
          />
        </n-form-item>
        <div class="row">
          <n-button type="primary" attr-type="submit" :loading="passwordBusy">
            {{ passwordBusy ? '保存中…' : '保存' }}
          </n-button>
          <n-button :disabled="passwordBusy" @click="closePasswordChange">取消</n-button>
        </div>
      </n-form>
    </n-modal>

    <!-- ----------------------------------------------------- add source -- -->
    <n-modal v-model:show="addOpen" preset="card" class="modal-card" title="添加订阅源">
      <n-form class="form" @submit.prevent="submitAdd">
        <n-form-item label="名称" :show-feedback="false">
          <n-input v-model:value="addForm.name" maxlength="80" placeholder="例如：自用机场" :disabled="adding" />
        </n-form-item>
        <n-form-item label="订阅链接" :show-feedback="false">
          <n-input v-model:value="addForm.url" type="text" inputmode="url" placeholder="https://…" :disabled="adding" />
        </n-form-item>
        <n-form-item label="User-Agent（可选）" :show-feedback="false">
          <n-input v-model:value="addForm.userAgent" placeholder="留空使用默认" :disabled="adding" />
        </n-form-item>
        <div class="row">
          <n-button type="primary" attr-type="submit" :loading="adding">{{ adding ? '添加中…' : '添加' }}</n-button>
          <n-button :disabled="adding" @click="addOpen = false">取消</n-button>
        </div>
      </n-form>
    </n-modal>

    <!-- ------------------------------------------------------- edit modal -- -->
    <n-modal
      :show="editing !== null"
      preset="card"
      class="modal-card"
      title="编辑订阅源"
      @update:show="(value) => { if (!value) editing = null; }"
    >
      <n-form v-if="editing" class="form" @submit.prevent="submitEdit">
        <n-form-item label="名称" :show-feedback="false">
          <n-input v-model:value="editForm.name" maxlength="80" :disabled="savingEdit" />
        </n-form-item>
        <n-form-item label="订阅链接" :show-feedback="false">
          <div class="field-stack">
            <n-input
              v-model:value="editForm.url"
              type="text"
              inputmode="url"
              placeholder="留空保持不变"
              :disabled="savingEdit"
            />
            <small class="hint">{{ URL_WRITE_ONLY_HINT }}</small>
          </div>
        </n-form-item>
        <n-form-item label="User-Agent" :show-feedback="false">
          <n-input v-model:value="editForm.userAgent" :disabled="savingEdit" />
        </n-form-item>
        <n-form-item label="启用该订阅源" :show-feedback="false">
          <n-switch v-model:value="editForm.enabled" :disabled="savingEdit" />
        </n-form-item>
        <div class="row">
          <n-button type="primary" attr-type="submit" :loading="savingEdit">{{ savingEdit ? '保存中…' : '保存' }}</n-button>
          <n-button :disabled="savingEdit" @click="editing = null">取消</n-button>
        </div>
      </n-form>
    </n-modal>
  </main>
</template>

<style scoped>
.my {
  min-height: 100vh;
  max-width: 76rem;
  margin: 0 auto;
  padding: var(--space-4) var(--space-4) var(--space-10);
  background: #f8fafc;
  color: var(--foreground);
  font-family: var(--font-sans);
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--primary);
  font-weight: 700;
}

h1 {
  margin: 0;
  font-size: var(--text-lg);
}

h3 {
  margin: 0;
  font-size: var(--text-base);
}

.sub {
  margin: 0;
  color: var(--muted-foreground);
  font-size: var(--text-sm);
}

.hint {
  margin: 0;
  color: var(--muted-foreground);
  font-size: var(--text-sm);
}

.tiny {
  font-size: var(--text-xs);
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-10) 0;
  color: var(--muted-foreground);
}

.state-card {
  max-width: 34rem;
  margin: var(--space-6) auto;
  text-align: center;
}

.state-title {
  margin: 0 0 var(--space-1);
  color: var(--foreground);
  font-weight: 600;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.stat {
  min-width: 0;
}

.stat :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.stat-traffic {
  grid-column: span 2;
}

.stat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.stat-label {
  color: var(--muted-foreground);
  font-size: var(--text-sm);
  font-weight: 500;
}

.traffic-numbers {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.big {
  font-size: var(--text-2xl);
  font-weight: 700;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.muted {
  color: var(--muted-foreground);
  font-family: var(--font-mono);
}

.stat-value {
  font-family: var(--font-mono);
  font-size: var(--text-2xl);
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.stat-value.small {
  font-size: var(--text-lg);
}

.stat-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-4);
  color: var(--muted-foreground);
  font-size: var(--text-xs);
}

.stat-facts b {
  color: var(--foreground);
  font-family: var(--font-mono);
  font-weight: 500;
}

.status-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--space-4);
  align-items: start;
}

.panel {
  min-width: 0;
}

.panel > :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.panel-links {
  grid-column: span 5;
}

.panel-sources {
  grid-column: span 7;
}

.panel-shared {
  grid-column: span 7;
}

.panel-password {
  grid-column: span 7;
}

.panel-token {
  grid-column: span 5;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.field-label {
  color: var(--muted-foreground);
  font-size: var(--text-sm);
  font-weight: 500;
}

.field-stack {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
}

.main-link {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--muted);
  border-radius: var(--radius);
}

.main-link code {
  flex: 1;
  overflow: hidden;
  color: var(--foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.qr-image {
  width: 11rem;
  height: 11rem;
  padding: var(--space-2);
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.qr-image :deep(svg) {
  width: 100%;
  height: 100%;
}

.links {
  list-style: none;
  margin: 0;
  padding: 0;
}

.links li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border);
}

.link-name {
  font-size: var(--text-sm);
  font-weight: 600;
}

.links code {
  grid-column: 1 / -1;
  overflow: hidden;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: var(--space-3);
}

.source-card :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}

.source-head strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1) var(--space-3);
  color: var(--muted-foreground);
  font-size: var(--text-xs);
}

.source-facts b {
  color: var(--foreground);
  font-family: var(--font-mono);
  font-weight: 500;
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group h3 {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) 0;
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
}

.modal-card {
  width: min(30rem, calc(100vw - 2rem));
}

@media (max-width: 1100px) {
  .panel-links,
  .panel-sources,
  .panel-shared,
  .panel-password,
  .panel-token {
    grid-column: span 12;
  }
}

@media (max-width: 900px) {
  .overview-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stat-traffic {
    grid-column: span 2;
  }
}

@media (max-width: 640px) {
  .my {
    padding: var(--space-3) var(--space-3) var(--space-8);
  }

  .overview-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .stat-traffic {
    grid-column: span 1;
  }

  .topbar {
    flex-wrap: wrap;
    align-items: flex-start;
  }

  .source-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .modal-card {
    width: calc(100vw - 1.5rem);
  }
}
</style>
