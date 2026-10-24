<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * Slim page bar at the top of the content area: title (+ optional subtitle) on
 * the left, the page's primary action in the default slot on the right.
 *
 * Rendered by each page as its first element, so the title/action always match
 * the page below it without the layout having to know about page slots (layout
 * slots only flow from `<NuxtLayout>`, not from the page component).
 */
defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>

<template>
  <header class="topbar">
    <div class="topbar-title">
      <h1>{{ title }}</h1>
      <span v-if="subtitle" class="sub">{{ subtitle }}</span>
    </div>
    <div class="actions">
      <slot />
    </div>
  </header>
</template>
