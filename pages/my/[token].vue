<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Self-service user center — `/my/<token>`.
 *
 * PUBLIC page: the token in the URL *is* the credential (no accounts, no
 * password). It is outside the admin gate (`/my` is in `USER_CENTER_PAGES`), so
 * it renders without any gate cookie and must keep working exactly like `/s/*`.
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

import { apiErrorMessage } from '~/core/utils/api-error';
import { qrSvgPath } from '~/core/utils/qr';
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
  userCenterPath,
  userCenterView,
  type UserCenterPayload,
} from '~/core/utils/user-center';
import type { UserCenterOwnSource } from '~/server/utils/user-center';

const route = useRoute();
const token = computed(() => String(route.params.token ?? ''));

const { data, pending, error, refresh } = await useAsyncData(
  () => `user-center-${token.value}`,
  () => $fetch<UserCenterPayload>(userCenterApiPath(token.value, '')),
  { watch: [token] },
);

const view = computed(() =>
  userCenterView({
    data: data.value,
    error: error.value ? apiErrorMessage(error.value) : null,
    pending: pending.value,
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
const error2 = ref('');
const notice = ref('');
const busy = ref(false);

function clearMessages() {
  error2.value = '';
  notice.value = '';
}

/** Inclusion toggle for a public/shared source. */
async function toggleIncluded(sourceId: number, included: boolean) {
  if (!center.value || busy.value) return;
  clearMessages();
  busy.value = true;
  const previous = center.value.availableSources;
  center.value.availableSources = applyInclusion(previous, sourceId, included);
  try {
    await $fetch(userCenterApiPath(token.value, 'choices'), {
      method: 'POST',
      body: { sourceId, included },
    });
    notice.value = included ? '已加入订阅' : '已从订阅中移除';
  } catch (err) {
    center.value.availableSources = previous;
    error2.value = apiErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

/* ------------------------------------------------------------ add source -- */
const addOpen = ref(false);
const addForm = reactive({ name: '', url: '', userAgent: '' });
const adding = ref(false);

function openAdd() {
  clearMessages();
  addForm.name = '';
  addForm.url = '';
  addForm.userAgent = '';
  addOpen.value = true;
}

async function submitAdd() {
  if (adding.value) return;
  clearMessages();
  if (!addForm.name.trim()) {
    error2.value = '请填写名称';
    return;
  }
  if (!addForm.url.trim()) {
    error2.value = '请填写订阅链接';
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
    notice.value = '订阅源已添加';
    await refresh();
  } catch (err) {
    error2.value = apiErrorMessage(err);
  } finally {
    adding.value = false;
  }
}

/* --------------------------------------------------------- edit source -- */
const editing = ref<UserCenterOwnSource | null>(null);
const editForm = reactive({ name: '', enabled: true, userAgent: '', url: '' });
const savingEdit = ref(false);

function openEdit(source: UserCenterOwnSource) {
  clearMessages();
  editing.value = source;
  // The URL field is always empty: a saved link can never be shown again.
  Object.assign(editForm, editFormFromSource(source));
}

async function submitEdit() {
  if (!editing.value || savingEdit.value) return;
  clearMessages();
  if (!editForm.name.trim()) {
    error2.value = '请填写名称';
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
    notice.value = '已保存';
    await refresh();
  } catch (err) {
    error2.value = apiErrorMessage(err);
  } finally {
    savingEdit.value = false;
  }
}

/* ------------------------------------------------------ delete source -- */
/**
 * Two-step delete: the card's 删除 button opens a confirm block that spells the
 * source name out (防误删). Only the owner's dedicated sources can be deleted;
 * the server answers 404 for anything else.
 */
const deletingSource = ref<UserCenterOwnSource | null>(null);
const removing = ref(false);

function askDelete(source: UserCenterOwnSource) {
  clearMessages();
  editing.value = null;
  deletingSource.value = source;
}

async function confirmDelete() {
  const target = deletingSource.value;
  if (!target || removing.value || !center.value) return;
  clearMessages();
  removing.value = true;
  try {
    await $fetch(userCenterApiPath(token.value, `sources/${target.id}`), { method: 'DELETE' });
    // Update both lists from the answer immediately (cards + 流量概览), then
    // reconcile with the server (summary, node counts, links).
    if (center.value) {
      const next = applySourceDelete(center.value, target.id);
      center.value.ownSources = next.ownSources;
      center.value.traffic.sources = next.trafficSources;
    }
    deletingSource.value = null;
    notice.value = `已删除订阅源「${target.name}」`;
    await refresh();
  } catch (err) {
    error2.value = apiErrorMessage(err);
    deletingSource.value = null;
  } finally {
    removing.value = false;
  }
}

/* ------------------------------------------------------------ token refresh -- */
const confirmingRotate = ref(false);
const rotating = ref(false);

async function rotateToken() {
  if (rotating.value) return;
  clearMessages();
  rotating.value = true;
  try {
    const result = await $fetch<{ token: string }>(userCenterApiPath(token.value, 'refresh'), {
      method: 'POST',
    });
    await navigateTo(userCenterPath(result.token), { replace: true });
  } catch (err) {
    error2.value = apiErrorMessage(err);
    rotating.value = false;
    confirmingRotate.value = false;
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
      <button v-if="center" class="ghost small" type="button" :disabled="pending" @click="refresh()">
        刷新
      </button>
    </header>

    <p v-if="view.kind === 'loading'" class="state">正在加载…</p>

    <section v-else-if="view.kind === 'error'" class="card state-card">
      <p class="state-title">{{ view.message }}</p>
      <p class="hint">请确认链接完整，或联系管理员重新获取。</p>
    </section>

    <section v-else-if="view.kind === 'disabled'" class="card state-card">
      <p class="state-title">{{ view.title }}</p>
      <p class="hint">{{ view.message }}</p>
    </section>

    <template v-else-if="center">
      <p v-if="error2" class="banner error" role="alert">{{ error2 }}</p>
      <p v-else-if="notice" class="banner ok" role="status">{{ notice }}</p>

      <!-- ------------------------------------------------------- traffic -- -->
      <section class="card">
        <h2>流量概览</h2>
        <p v-if="summary.empty" class="hint">暂无流量数据</p>
        <template v-else>
          <div class="summary-row">
            <span class="big">{{ summary.usedLabel }}</span>
            <span class="muted">/ {{ summary.totalLabel }}</span>
          </div>
          <div v-if="summary.percent !== null" class="bar" role="progressbar" :aria-valuenow="Math.round(summary.percent)" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ width: `${summary.percent}%` }" />
          </div>
          <dl class="facts">
            <div><dt>剩余</dt><dd>{{ summary.remainingLabel }}</dd></div>
            <div><dt>到期</dt><dd>{{ summary.expireLabel }}</dd></div>
          </dl>
        </template>
        <p class="hint tiny">
          仅统计专属订阅源（{{ center.traffic.summary.sourcesWithUserinfo }}/{{ center.traffic.summary.dedicatedCount }} 个有数据）
        </p>
      </section>

      <section v-if="center.traffic.sources.length" class="cards">
        <article v-for="(card, index) in cards" :key="center.traffic.sources[index]!.id" class="card traffic">
          <div class="row between">
            <h3>{{ card.name }}</h3>
            <span class="badge" :class="card.healthState">{{ card.healthLabel }}</span>
          </div>
          <p v-if="card.empty" class="hint">暂无流量数据</p>
          <template v-else>
            <div class="bar" v-if="card.percent !== null">
              <span :style="{ width: `${card.percent}%` }" />
            </div>
            <dl class="facts">
              <div><dt>已用</dt><dd>{{ card.usedLabel }}</dd></div>
              <div><dt>总量</dt><dd>{{ card.totalLabel }}</dd></div>
              <div><dt>剩余</dt><dd>{{ card.remainingLabel }}</dd></div>
              <div><dt>到期</dt><dd>{{ card.expireLabel }}</dd></div>
            </dl>
            <p v-if="card.rawFields.length" class="hint tiny">
              剩余 / 到期取自订阅自身报告的信息节点
            </p>
          </template>
          <p class="hint tiny">
            {{ card.lastRefresh }}
            <span v-if="center.traffic.sources[index]!.enabled === false"> · 已暂停</span>
            <span v-if="card.healthError"> · {{ card.healthError }}</span>
          </p>
        </article>
      </section>

      <!-- --------------------------------------------------------- links -- -->
      <section class="card">
        <div class="row between">
          <h2>订阅链接</h2>
        </div>

        <label v-if="profileOptions.length > 1" class="field">
          <span>规则档</span>
          <select v-model="selectedProfile">
            <option :value="null" v-for="option in profileOptions" :key="option.label">{{ option.label }}</option>
          </select>
        </label>

        <div class="main-link">
          <code>{{ currentMainLink }}</code>
          <button class="ghost small" type="button" @click="copy(currentMainLink, 'main')">
            {{ copied === 'main' ? '已复制' : '复制' }}
          </button>
        </div>
        <div v-if="qrSvg" class="qr" aria-label="当前主链接二维码">
          <div class="qr-image" v-html="qrSvg" />
          <p class="hint tiny">扫描导入当前主链接</p>
        </div>

        <ul class="links">
          <li v-for="link in links" :key="link.target">
            <div class="link-name">{{ link.label }}</div>
            <code>{{ link.url }}</code>
            <button class="ghost small" type="button" @click="copy(link.url, link.target)">
              {{ copied === link.target ? '已复制' : '复制' }}
            </button>
          </li>
        </ul>
        <p class="hint tiny">
          切换规则档只改变上面的链接，不会修改账号默认规则档。Token：{{ maskUserToken(center.user.token) }}
        </p>
      </section>

      <!-- --------------------------------------------------- own sources -- -->
      <section class="card">
        <div class="row between">
          <h2>我的订阅源</h2>
          <button class="primary small" type="button" @click="openAdd">添加订阅源</button>
        </div>
        <p v-if="!center.ownSources.length" class="hint">还没有专属订阅源。</p>
        <p v-else class="hint tiny">
          共 {{ ownStats.total }} 个 · 正常 {{ ownStats.healthy }} · 异常 {{ ownStats.failing }} · 节点 {{ ownStats.nodes }}
        </p>

        <ul class="own">
          <li v-for="source in center.ownSources" :key="source.id">
            <div class="row between">
              <strong>{{ source.name }}</strong>
              <span class="badge" :class="source.health.state">{{ HEALTH_LABELS[source.health.state] }}</span>
            </div>
            <p class="hint tiny">
              {{ lastRefreshLabel(source.health.lastOkAt) }}
              <span v-if="!source.enabled"> · 已暂停</span>
              <span v-if="source.nodeCount !== null"> · {{ source.nodeCount }} 个节点</span>
              <span v-if="source.health.error"> · {{ source.health.error }}</span>
            </p>
            <div class="row">
              <button class="ghost small" type="button" @click="openEdit(source)">编辑</button>
              <button class="small danger" type="button" @click="askDelete(source)">删除</button>
            </div>
          </li>
        </ul>

        <form v-if="addOpen" class="form" @submit.prevent="submitAdd">
          <h3>添加订阅源</h3>
          <label class="field">
            <span>名称</span>
            <input v-model="addForm.name" type="text" maxlength="80" placeholder="例如：自用机场" :disabled="adding">
          </label>
          <label class="field">
            <span>订阅链接</span>
            <input v-model="addForm.url" type="url" inputmode="url" placeholder="https://…" :disabled="adding">
          </label>
          <label class="field">
            <span>User-Agent（可选）</span>
            <input v-model="addForm.userAgent" type="text" placeholder="留空使用默认" :disabled="adding">
          </label>
          <div class="row">
            <button class="primary" type="submit" :disabled="adding">{{ adding ? '添加中…' : '添加' }}</button>
            <button class="ghost" type="button" :disabled="adding" @click="addOpen = false">取消</button>
          </div>
        </form>
      </section>

      <!-- ----------------------------------------------- inclusion list -- -->
      <section class="card">
        <h2>公共 / 共享订阅源</h2>
        <p v-if="!availableGroups.length" class="hint">暂无可选订阅源。</p>
        <div v-for="group in availableGroups" :key="group.kind" class="group">
          <h3>{{ group.label }}</h3>
          <label v-for="source in group.items" :key="source.id" class="toggle">
            <input
              type="checkbox"
              :checked="source.included"
              :disabled="busy"
              @change="toggleIncluded(source.id, ($event.target as HTMLInputElement).checked)"
            >
            <span>{{ source.name }}</span>
          </label>
        </div>
        <p class="hint tiny">取消勾选后，该订阅源不会出现在你的订阅链接中。</p>
      </section>

      <!-- ------------------------------------------------------- rotate -- -->
      <section class="card">
        <h2>重置 Token</h2>
        <p class="hint tiny">重置后旧链接立即失效，需要重新导入新链接。</p>
        <template v-if="!confirmingRotate">
          <button class="ghost" type="button" @click="confirmingRotate = true">重置 Token</button>
        </template>
        <div v-else class="row">
          <button class="primary" type="button" :disabled="rotating" @click="rotateToken">
            {{ rotating ? '重置中…' : '确认重置' }}
          </button>
          <button class="ghost" type="button" :disabled="rotating" @click="confirmingRotate = false">取消</button>
        </div>
      </section>
    </template>

    <!-- ----------------------------------------------------- delete confirm -- -->
    <div v-if="deletingSource" class="scrim" @click.self="deletingSource = null">
      <div class="card modal" role="alertdialog" aria-labelledby="delete-title">
        <h3 id="delete-title">删除订阅源</h3>
        <p class="confirm-text">{{ deleteSourceConfirmText(deletingSource.name) }}</p>
        <p class="hint tiny">该订阅源会从你的订阅链接中移除，已合并的公共 / 共享订阅源不受影响。</p>
        <div class="row">
          <button class="danger" type="button" :disabled="removing" @click="confirmDelete">
            {{ removing ? '删除中…' : '确认删除' }}
          </button>
          <button class="ghost" type="button" :disabled="removing" @click="deletingSource = null">取消</button>
        </div>
      </div>
    </div>

    <!-- ------------------------------------------------------- edit modal -- -->
    <div v-if="editing" class="scrim" @click.self="editing = null">
      <form class="card modal" @submit.prevent="submitEdit">
        <h3>编辑订阅源</h3>
        <label class="field">
          <span>名称</span>
          <input v-model="editForm.name" type="text" maxlength="80" :disabled="savingEdit">
        </label>
        <label class="field">
          <span>订阅链接</span>
          <input v-model="editForm.url" type="url" inputmode="url" placeholder="留空保持不变" :disabled="savingEdit">
          <small class="hint">{{ URL_WRITE_ONLY_HINT }}</small>
        </label>
        <label class="field">
          <span>User-Agent</span>
          <input v-model="editForm.userAgent" type="text" :disabled="savingEdit">
        </label>
        <label class="toggle">
          <input v-model="editForm.enabled" type="checkbox" :disabled="savingEdit">
          <span>启用该订阅源</span>
        </label>
        <div class="row">
          <button class="primary" type="submit" :disabled="savingEdit">{{ savingEdit ? '保存中…' : '保存' }}</button>
          <button class="ghost" type="button" :disabled="savingEdit" @click="editing = null">取消</button>
        </div>
      </form>
    </div>
  </main>
</template>

<style scoped>
.my {
  min-height: 100vh;
  padding: var(--space-4) var(--space-3) var(--space-10);
  background: #f8fafc;
  color: var(--foreground);
  font-family: var(--font-sans);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  max-width: 34rem;
  margin: 0 auto var(--space-3);
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
h2 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
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
.card {
  max-width: 34rem;
  margin: 0 auto var(--space-3);
  padding: var(--space-4);
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}
.cards {
  max-width: 34rem;
  margin: 0 auto;
}
.traffic {
  padding: var(--space-3) var(--space-4);
}
.state,
.state-card {
  max-width: 34rem;
  margin: var(--space-6) auto;
  text-align: center;
  color: var(--muted-foreground);
}
.state-title {
  margin: 0 0 var(--space-1);
  color: var(--foreground);
  font-weight: 600;
}
.hint {
  margin: var(--space-1) 0 0;
  color: var(--muted-foreground);
  font-size: var(--text-sm);
}
.tiny {
  font-size: var(--text-xs);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.between {
  justify-content: space-between;
  margin-top: 0;
}
.summary-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.big {
  font-size: var(--text-2xl);
  font-weight: 700;
  font-family: var(--font-mono);
}
.muted {
  color: var(--muted-foreground);
  font-family: var(--font-mono);
}
.bar {
  height: 0.4rem;
  margin: var(--space-2) 0;
  border-radius: var(--radius-pill);
  background: var(--muted);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--primary);
}
.facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-1) var(--space-3);
  margin: var(--space-2) 0 0;
}
.facts dt {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
}
.facts dd {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.badge {
  padding: 0.05rem 0.5rem;
  border-radius: var(--radius-pill);
  background: var(--muted);
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  white-space: nowrap;
}
.badge.ok {
  background: var(--success-soft);
  color: var(--success);
}
.badge.failed {
  background: var(--destructive-soft);
  color: var(--destructive);
}
.badge.never {
  background: var(--warning-soft);
  color: var(--warning-text);
}
.links,
.own {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
}
.links li,
.own li {
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border);
}
.links li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--space-1) var(--space-2);
}
.link-name {
  font-size: var(--text-sm);
  font-weight: 600;
}
code {
  overflow: hidden;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.links code {
  grid-column: 1 / -1;
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
  color: var(--foreground);
}
.qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: var(--space-3);
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
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  color: var(--muted-foreground);
  font-size: var(--text-sm);
}
input,
select {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #fff;
  color: var(--foreground);
  font: inherit;
}
.toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  font-size: var(--text-sm);
}
.toggle input {
  width: auto;
}
.group {
  margin-top: var(--space-2);
}
.group h3 {
  color: var(--muted-foreground);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
}
button {
  min-height: 2.4rem;
  cursor: pointer;
}
button.small {
  min-height: 2rem;
  padding: 0.2rem 0.7rem;
  font-size: var(--text-sm);
}
button:disabled {
  cursor: default;
  opacity: 0.6;
}
.confirm-text {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.banner {
  max-width: 34rem;
  margin: 0 auto var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius);
  font-size: var(--text-sm);
}
.banner.error {
  background: var(--destructive-soft);
  color: var(--destructive);
}
.banner.ok {
  background: var(--success-soft);
  color: var(--success);
}
.scrim {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: var(--space-3);
  background: var(--scrim);
}
.modal {
  width: 100%;
  max-width: 34rem;
  max-height: 88vh;
  overflow-y: auto;
  margin: 0;
}
@media (min-width: 40rem) {
  .my {
    padding-top: var(--space-8);
  }
  .scrim {
    align-items: center;
  }
}
</style>
