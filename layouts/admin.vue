<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Admin shell: fixed sidebar plus the page content. Protected by the
 * `admin` route middleware (also declared in pages via `definePageMeta`).
 */
const links = [
  { to: '/', label: '仪表盘' },
  { to: '/users', label: '用户' },
  { to: '/sources', label: '订阅源' },
  { to: '/profiles', label: '规则档' },
  { to: '/preview', label: '预览' },
  { to: '/logs', label: '日志' },
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
      <div class="brand">subhub</div>
      <nav>
        <NuxtLink
          v-for="link in links"
          :key="link.to"
          :to="link.to"
          class="nav-link"
          active-class="active"
        >
          {{ link.label }}
        </NuxtLink>
      </nav>
      <button class="logout" type="button" :disabled="loggingOut" @click="handleLogout">
        {{ loggingOut ? '退出中…' : '退出登录' }}
      </button>
    </aside>
    <main class="content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  min-height: 100vh;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: #1f2933;
}
.sidebar {
  display: flex;
  flex-direction: column;
  width: 12rem;
  flex-shrink: 0;
  padding: 1.25rem 0.75rem;
  background: #f5f7fa;
  border-right: 1px solid #e1e6ec;
}
.brand {
  font-weight: 700;
  font-size: 1.1rem;
  padding: 0 0.5rem 1rem;
}
nav {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  flex: 1;
}
.nav-link {
  padding: 0.45rem 0.5rem;
  border-radius: 6px;
  color: inherit;
  text-decoration: none;
}
.nav-link:hover {
  background: #e8edf3;
}
.nav-link.active {
  background: #dbe4ee;
  font-weight: 600;
}
.logout {
  margin-top: 1rem;
  padding: 0.45rem 0.5rem;
  border: 1px solid #d3dae2;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
.content {
  flex: 1;
  padding: 1.75rem 2rem;
  min-width: 0;
}
</style>
