<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Password login. Public page: no admin layout, no auth middleware.
 * On success the httpOnly cookie is set and we go to the requested page (`/`
 * by default). Already-authenticated visitors are sent straight on.
 */
definePageMeta({ layout: false });

const route = useRoute();
const password = ref('');
const error = ref('');
const submitting = ref(false);

const requested = computed(() => {
  const redirect = route.query.redirect;
  const value = Array.isArray(redirect) ? redirect[0] : redirect;
  // Only follow local paths, never an absolute URL.
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';
});

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
  } catch {
    error.value = '密码错误';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="card" @submit.prevent="handleSubmit">
      <h1>subhub</h1>
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
      <button type="submit" :disabled="submitting">
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
  background: #f5f7fa;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: #1f2933;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: min(22rem, calc(100vw - 2rem));
  padding: 2rem;
  background: #fff;
  border: 1px solid #e1e6ec;
  border-radius: 10px;
}
h1 {
  margin: 0;
  font-size: 1.4rem;
}
.hint {
  margin: 0 0 0.75rem;
  color: #6b7785;
  font-size: 0.9rem;
}
label {
  font-size: 0.9rem;
}
input {
  padding: 0.5rem 0.6rem;
  border: 1px solid #cfd7e0;
  border-radius: 6px;
  font-size: 1rem;
}
button {
  margin-top: 0.75rem;
  padding: 0.55rem 0.6rem;
  border: none;
  border-radius: 6px;
  background: #2f6feb;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.error {
  margin: 0;
  color: #c0392b;
  font-size: 0.9rem;
}
</style>
