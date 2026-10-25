<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * App shell: Naive UI providers around the layout + page.
 *
 * `n-config-provider` carries the light-only theme overrides (the palette lives
 * in `assets/naive-theme.ts`); the message/dialog providers make `useMessage()`
 * and `useDialog()` available to every page. No global style component is
 * mounted on purpose — the design system's own `main.css` stays authoritative
 * for page chrome, and Naive's styles are component-scoped CSS-in-JS.
 *
 * `<NuxtLayout>` is load-bearing, not decoration: without it, `definePageMeta`
 * layout choices are ignored and `layouts/admin.vue` never mounts — no
 * sidebar, no content margins, and the layout's `/api/admin/me` fetch that
 * seeds the `admin-sub-path` state never runs, so admin copy-links silently
 * fall back to the default `s` prefix (live incident 2026-10-25, exposed the
 * first time the prefix was changed away from the default). Pages that opt
 * out (`layout: false` — login, /my) are unaffected.
 */
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui';
import { naiveThemeOverrides } from '~/assets/naive-theme';
</script>

<template>
  <n-config-provider :theme-overrides="naiveThemeOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <NuxtLayout>
          <NuxtPage />
        </NuxtLayout>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
