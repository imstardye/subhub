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
  progressRing,
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

/* ----------------------------------------------------- refresh sources -- */
const refreshingSources = ref(false);

/**
 * Manual refresh of the owner's DEDICATED sources only. The server reuses the
 * periodic task's fetch path and skips paused sources; this handler just
 * reloads the dashboard afterwards so cards/counts reflect the new cache.
 */
async function refreshOwnSources() {
  if (refreshingSources.value) return;
  refreshingSources.value = true;
  try {
    const result = await $fetch<{ refreshed: number; failed: number }>(
      userCenterApiPath(token.value, 'refresh-sources'),
      { method: 'POST' },
    );
    await refresh();
    if (result.failed > 0) {
      message.warning(`已刷新 ${result.refreshed} 个，${result.failed} 个失败`);
    } else {
      message.success(`已刷新 ${result.refreshed} 个订阅源`);
    }
  } catch (err) {
    message.error(apiErrorMessage(err));
  } finally {
    refreshingSources.value = false;
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

/* -------------------------------------------------------- custom token -- */
const customTokenOpen = ref(false);
const customTokenValue = ref('');
const customTokenBusy = ref(false);

function openCustomToken() {
  customTokenValue.value = '';
  customTokenOpen.value = true;
}

async function submitCustomToken() {
  const value = customTokenValue.value.trim();
  if (!value) {
    message.error('请输入新令牌');
    return;
  }
  if (customTokenBusy.value) return;
  customTokenBusy.value = true;
  try {
    const result = await $fetch<{ token: string }>(userCenterApiPath(token.value, 'token'), {
      method: 'PUT',
      body: { token: value },
    });
    customTokenOpen.value = false;
    // The session cookie is bound to the user id + password version, not the
    // token, so the dashboard at the new address is still unlocked.
    await navigateTo(userCenterPath(result.token), { replace: true });
  } catch (err) {
    message.error(apiErrorMessage(err));
    customTokenBusy.value = false;
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
/** Hero progress ring geometry (percent itself comes from `summaryBar`). */
const ring = computed(() => progressRing(summary.value.percent, 64));
/** Avatar initial in the greeting header. */
const userInitial = computed(() => (center.value?.user.name.trim().charAt(0) || 'S').toUpperCase());
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
    <!-- ---------------------------------------------------------- states -- -->
    <div v-if="view.kind === 'loading'" class="state">
      <n-spin size="medium" />
      <span>正在加载…</span>
    </div>

    <section v-else-if="view.kind === 'locked'" class="auth-wrap">
      <div class="auth-card">
        <div class="auth-mark" aria-hidden="true">S</div>
        <h1 class="auth-title">{{ view.lock === 'needs-setup' ? '设置访问密码' : '欢迎回来' }}</h1>
        <p class="auth-sub">
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
              size="large"
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
              size="large"
              autocomplete="new-password"
              :maxlength="PASSWORD_MAX_LENGTH"
              placeholder="再次输入密码"
              :disabled="authBusy"
              :input-props="{ 'aria-label': '确认密码' }"
            />
          </n-form-item>
          <n-alert v-if="authError" type="error" :bordered="false" role="alert">{{ authError }}</n-alert>
          <n-button class="auth-submit" type="primary" size="large" block attr-type="submit" :loading="authBusy">
            {{ authBusy ? '处理中…' : view.lock === 'needs-setup' ? '设置并进入' : '进入' }}
          </n-button>
        </n-form>
      </div>
    </section>

    <section v-else-if="view.kind === 'error'" class="auth-wrap">
      <div class="auth-card">
        <div class="auth-mark muted" aria-hidden="true">!</div>
        <h1 class="auth-title">{{ view.message }}</h1>
        <p class="auth-sub">请确认链接完整，或联系管理员重新获取。</p>
      </div>
    </section>

    <section v-else-if="view.kind === 'disabled'" class="auth-wrap">
      <div class="auth-card">
        <div class="auth-mark muted" aria-hidden="true">!</div>
        <h1 class="auth-title">{{ view.title }}</h1>
        <p class="auth-sub">{{ view.message }}</p>
      </div>
    </section>

    <!-- ------------------------------------------------------- dashboard -- -->
    <template v-else-if="center">
      <header class="topbar">
        <div class="brand">
          <span class="avatar" aria-hidden="true">{{ userInitial }}</span>
          <div>
            <h1>你好，{{ center.user.name }}</h1>
            <p class="sub">规则档 {{ center.profile.assignedProfile || '未分配' }} · 我的订阅</p>
          </div>
        </div>
        <n-button secondary round :loading="pending" @click="refresh()">刷新</n-button>
      </header>

      <section class="hero">
        <div class="hero-main">
          <span class="hero-label">剩余流量</span>
          <p v-if="summary.empty" class="hero-empty">暂无流量数据</p>
          <template v-else>
            <div class="hero-number">{{ summary.remainingLabel }}</div>
            <div class="hero-facts">
              <span>已用 <b>{{ summary.usedLabel }}</b></span>
              <span class="sep" aria-hidden="true" />
              <span>总量 <b>{{ summary.totalLabel }}</b></span>
            </div>
            <div class="hero-bar" aria-hidden="true">
              <div class="hero-bar-fill" :style="{ width: `${summary.percent ?? 0}%` }" />
            </div>
          </template>
          <p class="hero-note">
            仅统计专属订阅源（{{ center.traffic.summary.sourcesWithUserinfo }}/{{ center.traffic.summary.dedicatedCount }} 个有数据）
          </p>
        </div>
        <div class="hero-side">
          <div class="ring-wrap">
            <svg class="ring" viewBox="0 0 160 160" role="img" :aria-label="`已用 ${summary.percent === null ? '—' : Math.round(summary.percent) + '%'}`">
              <circle class="ring-track" cx="80" cy="80" r="64" />
              <circle
                class="ring-value"
                cx="80"
                cy="80"
                r="64"
                :stroke-dasharray="ring.circumference"
                :stroke-dashoffset="ring.offset"
              />
            </svg>
            <div class="ring-center">
              <span class="ring-pct">{{ summary.percent === null ? '—' : `${Math.round(summary.percent)}%` }}</span>
              <span class="ring-cap">已用</span>
            </div>
          </div>
          <p class="hero-expire">到期 <b>{{ summary.expireLabel }}</b></p>
        </div>
      </section>

      <section class="tiles">
        <div class="tile">
          <span class="tile-label">节点总数</span>
          <span class="tile-value">{{ ownStats.nodes }}</span>
          <span class="tile-hint">专属订阅源合计 · 已扣除信息节点</span>
        </div>
        <div class="tile">
          <span class="tile-label">订阅源状态</span>
          <span class="tile-value tile-status">
            <span class="dot ok" aria-hidden="true" />{{ ownStats.healthy }} 正常
            <span class="dot bad" aria-hidden="true" />{{ ownStats.failing }} 异常
          </span>
          <span class="tile-hint">共 {{ ownStats.total }} 个专属订阅源</span>
        </div>
        <div class="tile">
          <span class="tile-label">当前规则档</span>
          <span class="tile-value">{{ center.profile.assignedProfile || '未分配' }}</span>
          <span class="tile-hint">切换规则档只影响链接，不改账号默认</span>
        </div>
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
            <n-button type="primary" size="small" @click="copy(currentMainLink, 'main')">
              {{ copied === 'main' ? '已复制' : '复制' }}
            </n-button>
          </div>
          <div v-if="qrSvg" class="qr" aria-label="当前主链接二维码">
            <div class="qr-image" v-html="qrSvg" />
            <p class="hint tiny">扫描导入当前主链接</p>
          </div>

          <ul class="links">
            <li v-for="link in links" :key="link.target">
              <span class="link-chip">{{ link.label }}</span>
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
            <div style="display: flex; gap: 8px">
              <n-button
                secondary
                size="small"
                round
                :loading="refreshingSources"
                @click="refreshOwnSources"
              >
                刷新订阅
              </n-button>
              <n-button type="primary" size="small" round @click="openAdd">添加订阅源</n-button>
            </div>
          </template>

          <div v-if="cards.length" class="source-list">
            <article
              v-for="(card, index) in cards"
              :key="center.traffic.sources[index]!.id"
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
                <div class="source-bar" aria-hidden="true">
                  <div
                    class="source-bar-fill"
                    :style="{ width: `${card.percent ?? 0}%` }"
                  />
                </div>
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

              <div class="source-foot">
                <span class="hint tiny">
                  {{ card.lastRefresh }}
                  <span v-if="center.traffic.sources[index]!.enabled === false"> · 已暂停</span>
                  <span v-if="card.healthError"> · {{ card.healthError }}</span>
                </span>
                <span class="row">
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
                </span>
              </div>
            </article>
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

        <!-- ------------------------------------------------------- account -- -->
        <n-card class="panel panel-account" title="账户与安全">
          <div class="account-row">
            <div class="account-text">
              <span class="account-label">订阅令牌</span>
              <span class="hint tiny">当前 {{ maskUserToken(center.user.token) }} · 自定义后链接更好记；刷新会随机生成新令牌。两者都会让旧链接立即失效。</span>
            </div>
            <div class="row">
              <n-button secondary @click="openCustomToken">自定义令牌</n-button>
              <n-button secondary :loading="rotating" @click="askRotate">刷新令牌</n-button>
            </div>
          </div>
          <div class="account-row">
            <div class="account-text">
              <span class="account-label">访问密码</span>
              <span class="hint tiny">修改后其他设备上的登录会失效，需要重新输入新密码。</span>
            </div>
            <div class="row">
              <n-button secondary @click="openPasswordChange">修改密码</n-button>
            </div>
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

    <!-- ----------------------------------------------------- custom token -- -->
    <n-modal v-model:show="customTokenOpen" preset="card" class="modal-card" title="自定义令牌">
      <n-form class="form" @submit.prevent="submitCustomToken">
        <n-form-item label="新令牌" :show-feedback="false">
          <div class="field-stack">
            <n-input
              v-model:value="customTokenValue"
              type="text"
              maxlength="64"
              placeholder="8–64 个字符，如 my-sub-2026"
              :disabled="customTokenBusy"
              :input-props="{ 'aria-label': '新令牌' }"
            />
            <small class="hint">仅小写/大写字母、数字、- 和 _，且不能与其他人重复。保存后订阅链接和本页地址立即变更，旧链接立刻失效，客户端需要重新导入。</small>
          </div>
        </n-form-item>
        <div class="row">
          <n-button type="primary" attr-type="submit" :loading="customTokenBusy">
            {{ customTokenBusy ? '保存中…' : '保存' }}
          </n-button>
          <n-button :disabled="customTokenBusy" @click="customTokenOpen = false">取消</n-button>
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
  max-width: 72rem;
  margin: 0 auto;
  padding: 28px 20px 64px;
  background:
    radial-gradient(60rem 22rem at 85% -6rem, rgba(37, 99, 235, 0.13), transparent 60%),
    linear-gradient(180deg, #e9f1fe 0, #f8fafc 19rem);
  color: var(--foreground);
  font-family: var(--font-sans);
}

/* ------------------------------------------------------------ header */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}
.brand {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.avatar {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  flex: none;
  border-radius: 15px;
  background: linear-gradient(135deg, #2563eb, #38bdf8);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  box-shadow: 0 8px 18px rgba(37, 99, 235, 0.32);
}
.topbar h1 {
  margin: 0;
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub {
  margin: 2px 0 0;
  color: var(--muted-foreground, #64748b);
  font-size: 13px;
}

/* ------------------------------------------------------------ states */
.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 96px 0;
  color: var(--muted-foreground, #64748b);
}
.auth-wrap {
  display: flex;
  justify-content: center;
  padding: 9vh 0 48px;
}
.auth-card {
  width: 100%;
  max-width: 400px;
  padding: 34px 30px 30px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 24px;
  box-shadow: 0 24px 50px rgba(15, 40, 90, 0.12);
}
.auth-mark {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  margin-bottom: 18px;
  border-radius: 17px;
  background: linear-gradient(135deg, #2563eb, #38bdf8);
  color: #fff;
  font-size: 24px;
  font-weight: 700;
  box-shadow: 0 10px 22px rgba(37, 99, 235, 0.32);
}
.auth-mark.muted {
  background: #f1f5f9;
  color: #64748b;
  box-shadow: none;
}
.auth-title {
  margin: 0 0 8px;
  font-size: 21px;
  font-weight: 700;
}
.auth-sub {
  margin: 0 0 22px;
  color: var(--muted-foreground, #64748b);
  font-size: 13.5px;
  line-height: 1.65;
}
.auth-submit {
  margin-top: 6px;
}
.state-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
}

/* -------------------------------------------------------------- hero */
.hero {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
  align-items: center;
  padding: 28px 30px;
  margin-bottom: 18px;
  background: linear-gradient(120deg, #ffffff 55%, #eef5ff);
  border: 1px solid #dbe7fd;
  border-radius: 24px;
  box-shadow: 0 16px 36px rgba(15, 40, 90, 0.08);
}
.hero-label {
  color: #2563eb;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.14em;
}
.hero-number {
  margin: 8px 0 10px;
  font-size: 46px;
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: -0.01em;
}
.hero-empty {
  margin: 14px 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--muted-foreground, #64748b);
}
.hero-facts {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--muted-foreground, #64748b);
  font-size: 14px;
}
.hero-facts b {
  color: var(--foreground);
  font-weight: 600;
}
.hero-facts .sep {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #cbd5e1;
}
.hero-bar {
  height: 10px;
  margin-top: 18px;
  border-radius: 999px;
  background: #e3ecfd;
  overflow: hidden;
}
.hero-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #2563eb, #38bdf8);
  transition: width 0.5s ease;
}
.hero-note {
  margin: 12px 0 0;
  color: var(--muted-foreground, #64748b);
  font-size: 12.5px;
}
.hero-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.ring-wrap {
  position: relative;
  width: 148px;
  height: 148px;
}
.ring {
  width: 148px;
  height: 148px;
  transform: rotate(-90deg);
}
.ring circle {
  fill: none;
  stroke-width: 13;
}
.ring-track {
  stroke: #e3ecfd;
}
.ring-value {
  stroke: #2563eb;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.5s ease;
}
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.ring-pct {
  font-size: 27px;
  font-weight: 800;
  line-height: 1;
}
.ring-cap {
  margin-top: 4px;
  color: var(--muted-foreground, #64748b);
  font-size: 12px;
}
.hero-expire {
  margin: 0;
  color: var(--muted-foreground, #64748b);
  font-size: 13px;
}
.hero-expire b {
  color: var(--foreground);
  font-weight: 600;
}

/* ------------------------------------------------------------- tiles */
.tiles {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-bottom: 18px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 17px 20px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  box-shadow: 0 6px 16px rgba(15, 40, 90, 0.045);
}
.tile-label {
  color: var(--muted-foreground, #64748b);
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.tile-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
}
.tile-status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 17px;
}
.tile-hint {
  color: var(--muted-foreground, #64748b);
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.dot.ok {
  background: #16a34a;
}
.dot.bad {
  background: #dc2626;
  margin-left: 10px;
}

/* ------------------------------------------------------------ panels */
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  align-items: start;
}
.panel {
  border-radius: 20px;
  box-shadow: 0 10px 24px rgba(15, 40, 90, 0.055);
}
.panel :deep(.n-card-header) {
  font-weight: 700;
}
.hint {
  color: var(--muted-foreground, #64748b);
  font-size: 13px;
  line-height: 1.6;
}
.tiny {
  font-size: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.field-label {
  font-size: 13px;
  font-weight: 600;
}
.field-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ------------------------------------------------------------- links */
.main-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: #eef4fe;
  border: 1px solid #d7e5fd;
  border-radius: 14px;
}
.main-link code {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  word-break: break-all;
}
.qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 0 6px;
}
.qr-image {
  width: 148px;
  height: 148px;
  padding: 10px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
}
.qr-image :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.links {
  list-style: none;
  margin: 14px 0 10px;
  padding: 0;
}
.links li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
}
.links li:hover {
  background: #f6f9ff;
}
.link-chip {
  flex: none;
  min-width: 86px;
  font-size: 13px;
  font-weight: 600;
}
.links code {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted-foreground, #64748b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ----------------------------------------------------------- sources */
.source-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.source-card {
  padding: 16px 18px;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  background: #fbfdff;
}
.source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.source-head strong {
  font-size: 14.5px;
}
.source-bar {
  height: 6px;
  border-radius: 999px;
  background: #e3ecfd;
  overflow: hidden;
  margin-bottom: 10px;
}
.source-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #2563eb, #38bdf8);
}
.source-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 18px;
  color: var(--muted-foreground, #64748b);
  font-size: 13px;
}
.source-facts b {
  color: var(--foreground);
  font-weight: 600;
}
.source-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
}
.group h3 {
  margin: 14px 0 6px;
  font-size: 13.5px;
  font-weight: 600;
}
.group:first-child h3 {
  margin-top: 0;
}
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 2px;
  border-bottom: 1px solid #eef2f7;
  font-size: 14px;
}
.toggle-row:last-child {
  border-bottom: none;
}

/* ----------------------------------------------------------- account */
.account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 0;
}
.account-row + .account-row {
  border-top: 1px solid #eef2f7;
}
.account-row:first-child {
  padding-top: 2px;
}
.account-row:last-child {
  padding-bottom: 2px;
}
.account-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.account-label {
  font-size: 14px;
  font-weight: 600;
}

/* ------------------------------------------------------------ modals */
.modal-card {
  max-width: 30rem;
  border-radius: 20px;
}

/* -------------------------------------------------------- responsive */
@media (max-width: 960px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 720px) {
  .hero {
    grid-template-columns: 1fr;
    justify-items: start;
  }
  .hero-side {
    flex-direction: row;
    align-items: center;
    gap: 18px;
  }
  .ring-wrap,
  .ring {
    width: 108px;
    height: 108px;
  }
  .ring circle {
    stroke-width: 15;
  }
  .ring-pct {
    font-size: 21px;
  }
  .hero-number {
    font-size: 36px;
  }
  .tiles {
    grid-template-columns: 1fr;
  }
  .topbar h1 {
    font-size: 18px;
  }
  .account-row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
