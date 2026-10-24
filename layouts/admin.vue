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
      <nav aria-label="主导航">
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="nav-link"
          active-class="active"
          :aria-label="link.label"
        >
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
            <template v-if="link.icon === 'dashboard'">
              <rect x="3" y="3" width="7" height="9" rx="1.5" />
              <rect x="14" y="3" width="7" height="5" rx="1.5" />
              <rect x="14" y="12" width="7" height="9" rx="1.5" />
              <rect x="3" y="16" width="7" height="5" rx="1.5" />
            </template>
            <template v-else-if="link.icon === 'users'">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </template>
            <template v-else-if="link.icon === 'rss'">
              <path d="M4 11a9 9 0 0 1 9 9" />
              <path d="M4 4a16 16 0 0 1 16 16" />
              <circle cx="5" cy="19" r="1" />
            </template>
            <template v-else-if="link.icon === 'layers'">
              <path d="m12 2 9 5-9 5-9-5 9-5Z" />
              <path d="m3 12 9 5 9-5" />
              <path d="m3 17 9 5 9-5" />
            </template>
            <template v-else-if="link.icon === 'eye'">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </template>
            <template v-else-if="link.icon === 'list'">
              <path d="M8 6h13" />
              <path d="M8 12h13" />
              <path d="M8 18h13" />
              <path d="M3 6h.01" />
              <path d="M3 12h.01" />
              <path d="M3 18h.01" />
            </template>
            <template v-else>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
            </template>
          </svg>
          <span class="nav-label">{{ link.label }}</span>
        </NuxtLink>
      </nav>
      <button
        class="logout"
        type="button"
        :disabled="loggingOut"
        aria-label="退出登录"
        @click="handleLogout"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
        </svg>
        <span class="nav-label">{{ loggingOut ? '退出中…' : '退出登录' }}</span>
      </button>
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

nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1;
  overflow-y: auto;
}

.nav-link {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0.5rem var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--muted-foreground);
  font-size: var(--text-sm);
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.nav-icon {
  width: 1.05rem;
  height: 1.05rem;
  flex-shrink: 0;
  stroke: currentColor;
  stroke-width: 1.75;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.nav-link:hover {
  background: var(--muted);
  color: var(--foreground);
}

.nav-link.active {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--primary);
  font-weight: 600;
}

.nav-link:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.logout {
  margin-top: var(--space-4);
  justify-content: flex-start;
  padding: 0.5rem var(--space-3);
  background: transparent;
  color: var(--muted-foreground);
}

.logout:hover:not(:disabled) {
  background: var(--muted);
  border-color: var(--border);
  color: var(--destructive-hover);
}

.logout svg {
  width: 1.05rem;
  height: 1.05rem;
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

/* Narrow screens: sidebar collapses to an icon rail so the cards keep their
   room. Labels stay in the DOM for assistive tech via the nav aria-labels. */
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

  nav {
    flex-direction: row;
    gap: var(--space-1);
    flex: 1;
  }

  .nav-link {
    padding: 0.5rem;
  }

  .nav-label,
  .brand-name {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .brand-name {
    display: none;
  }

  .logout {
    margin-top: 0;
    padding: 0.5rem;
  }

  .main {
    padding: 0 var(--space-3);
  }
}
</style>
