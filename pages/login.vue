<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Password login. Public page: no admin layout, no auth middleware.
 * On success the httpOnly cookie is set and we go to the requested page (`/`
 * by default). Already-authenticated visitors are sent straight on.
 */
definePageMeta({ layout: false });

import { safeRedirectPath } from '~/server/utils/safe-redirect';

const route = useRoute();
const password = ref('');
const error = ref('');
const submitting = ref(false);

const requested = computed(() => safeRedirectPath(route.query.redirect));

onMounted(async () => {
  const state = await $fetch<{ authenticated: boolean }>('/api/admin/me').catch(() => ({
    authenticated: false,
  }));
  if (state.authenticated) await navigateTo(requested.value);
});

async function handleSubmit() {
  if (submitting.value) return;
  error.value = '';
  if (!password.value) {
    error.value = '请输入密码';
    return;
  }
  submitting.value = true;
  try {
    await $fetch('/api/admin/login', {
      method: 'POST',
      body: { password: password.value },
    });
    password.value = '';
    await navigateTo(requested.value);
  } catch (err) {
    const status = (err as { statusCode?: number; status?: number }).statusCode
      ?? (err as { status?: number }).status;
    if (status !== undefined && status >= 500) {
      error.value = '服务器错误，请稍后再试';
    } else {
      error.value = '密码错误';
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="card login-card" @submit.prevent="handleSubmit">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 17l6-5-6-5" />
            <path d="M12 19h8" />
          </svg>
        </span>
        <h1>subhub</h1>
      </div>
      <p class="hint">管理后台登录</p>
      <label for="password">密码</label>
      <input
        id="password"
        v-model="password"
        type="password"
        name="password"
        autocomplete="current-password"
        autofocus
        :disabled="submitting"
      >
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="submitting">
        {{ submitting ? '登录中…' : '登录' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: var(--space-4);
  background:
    radial-gradient(60rem 30rem at 50% -10%, rgba(34, 197, 94, 0.08), transparent 70%),
    var(--background);
  font-family: var(--font-sans);
  color: var(--foreground);
}
.login-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(23rem, 100%);
  padding: var(--space-8);
  box-shadow: var(--shadow-lg);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-1);
}
.brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.1rem;
  height: 2.1rem;
  border: 1px solid rgba(34, 197, 94, 0.35);
  border-radius: var(--radius);
  background: var(--accent-soft);
  color: var(--accent-muted);
}
.brand-mark svg {
  width: 1.15rem;
  height: 1.15rem;
}
h1 {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.hint {
  margin: 0 0 var(--space-4);
  color: var(--muted-foreground);
  font-size: var(--text-sm);
}
label {
  color: var(--muted-foreground);
  font-size: var(--text-sm);
  font-weight: 500;
}
input {
  margin-bottom: var(--space-1);
  padding: 0.6rem 0.75rem;
  font-size: var(--text-md);
}
button {
  margin-top: var(--space-3);
  min-height: 2.6rem;
  font-size: var(--text-md);
  width: 100%;
}
</style>
