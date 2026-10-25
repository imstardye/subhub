<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Admin shell: fixed sidebar plus the page's content column. The slim top bar
 * (page title + primary action) is rendered inside the page via
 * `<PageTopbar>`. Every page is protected by the global `admin.global.ts`
 * route middleware.
 *
 * The effective subscription prefix (`sub_path` site setting) rides on
 * `/api/admin/me` and is put into the `admin-sub-path` state here — the
 * layout is mounted on every admin page, so copy-link buttons on /users get
 * the live prefix without each page fetching the settings itself. A settings
 * save updates the same state immediately (pages/settings.vue).
 */
import { NButton, NIcon, NMenu, type MenuOption } from 'naive-ui';
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue';
import NavIcon from '~/components/NavIcon.vue';

const route = useRoute();
const subPathState = useState<string>('admin-sub-path', () => 's');
const requestFetch = useRequestFetch();

onMounted(async () => {
  try {
    const me = await requestFetch<{ authenticated: boolean; subPath?: string }>('/api/admin/me');
    if (me.subPath) subPathState.value = me.subPath;
  } catch {
    // The prefix stays at the built-in default; links still work then.
  }
});
const links = [
  { to: '/', label: '仪表盘', icon: 'dashboard' },
  { to: '/users', label: '用户', icon: 'users' },
  { to: '/sources', label: '订阅源', icon: 'rss' },
  { to: '/profiles', label: '规则档', icon: 'layers' },
  { to: '/preview', label: '预览', icon: 'eye' },
  { to: '/logs', label: '日志', icon: 'list' },
  { to: '/settings', label: '设置', icon: 'settings' },
];

const menuOptions = computed<MenuOption[]>(() =>
  links.map((link) => ({
    key: link.to,
    label: link.label,
    icon: () => h(NIcon, null, { default: () => h(NavIcon, { name: link.icon }) }),
  })),
);

/** Vertical rail on desktop, horizontal strip under the brand on phones. */
const narrow = ref(false);
let media: MediaQueryList | null = null;
const menuMode = computed(() => (narrow.value ? 'horizontal' : 'vertical'));

function syncNarrow() {
  narrow.value = media?.matches ?? false;
}

onMounted(() => {
  media = window.matchMedia('(max-width: 640px)');
  syncNarrow();
  media.addEventListener('change', syncNarrow);
});

onBeforeUnmount(() => {
  media?.removeEventListener('change', syncNarrow);
});

function handleNavigate(key: string) {
  if (key !== route.path) navigateTo(key);
}

const loggingOut = ref(false);

async function handleLogout() {
  loggingOut.value = true;
  try {
    await $fetch('/api/admin/logout', { method: 'POST' });
  } finally {
    loggingOut.value = false;
    await navigateTo('/login');
  }
}
</script>

<template>
  <div class="admin">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 17l6-5-6-5" />
            <path d="M12 19h8" />
          </svg>
        </span>
        <span class="brand-name">subhub</span>
      </div>
      <nav class="nav" aria-label="主导航">
        <n-menu
          :value="route.path"
          :options="menuOptions"
          :mode="menuMode"
          @update:value="handleNavigate"
        />
      </nav>
      <n-button
        class="logout"
        quaternary
        block
        :loading="loggingOut"
        aria-label="退出登录"
        @click="handleLogout"
      >
        <template #icon>
          <n-icon><NavIcon name="logout" /></n-icon>
        </template>
        {{ loggingOut ? '退出中…' : '退出登录' }}
      </n-button>
    </aside>
    <div class="main">
      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  min-height: 100vh;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}

.sidebar {
  display: flex;
  flex-direction: column;
  width: 14rem;
  flex-shrink: 0;
  padding: var(--space-5) var(--space-3);
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  position: sticky;
  top: 0;
  height: 100vh;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-2) var(--space-5);
  margin-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
}

.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.85rem;
  height: 1.85rem;
  border-radius: var(--radius);
  background: var(--accent-soft);
  border: 1px solid rgba(37, 99, 235, 0.18);
  color: var(--primary);
}

.brand-mark svg {
  width: 1rem;
  height: 1rem;
  stroke: currentColor;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.brand-name {
  font-weight: 700;
  font-size: var(--text-lg);
  letter-spacing: -0.02em;
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.logout {
  margin-top: var(--space-4);
  justify-content: flex-start;
}

.main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  max-width: 96rem;
  padding: 0 var(--space-10);
}

.content {
  flex: 1;
  min-width: 0;
  padding: 0 0 var(--space-10);
}

@media (max-width: 900px) {
  .main {
    padding: 0 var(--space-6);
  }
}

/* Narrow screens: sidebar becomes a horizontal rail so the cards keep their
   room. The menu switches to horizontal mode in script. */
@media (max-width: 640px) {
  .admin {
    flex-direction: column;
  }

  .sidebar {
    position: sticky;
    z-index: 20;
    width: 100%;
    height: auto;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-right: none;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  .brand {
    padding: 0 var(--space-2) 0 0;
    margin-bottom: 0;
    border-bottom: none;
    border-right: 1px solid var(--border);
  }

  .brand-name {
    display: none;
  }

  .nav {
    flex: 1;
    overflow-x: auto;
    overflow-y: visible;
  }

  .logout {
    margin-top: 0;
    width: auto;
    flex-shrink: 0;
  }

  .main {
    padding: 0 var(--space-3);
  }
}
</style>
