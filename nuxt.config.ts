// SPDX-License-Identifier: AGPL-3.0-only
import { defineNuxtConfig } from 'nuxt/config';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  modules: ['nuxtjs-naive-ui'],
  // @ts-expect-error Nuxt 3.21 only augments `NuxtConfig` with `nitro` when its
  // generated .nuxt types are loaded; the repo's root tsconfig is standalone.
  nitro: {
    experimental: {
      tasks: true,
    },
    // The task scans every 5 minutes; each source's own refresh_minutes decides
    // whether it is actually due (see refreshAllDueSources).
    scheduledTasks: {
      '*/5 * * * *': ['refresh-sources'],
    },
  },
  typescript: {
    strict: true,
  },
  app: {
    head: {
      title: 'subhub',
      meta: [
        {
          name: 'description',
          content: 'Subscription hub — core parsers, producers and rules.',
        },
        { name: 'theme-color', content: '#F8FAFC' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
        },
      ],
    },
  },
});
