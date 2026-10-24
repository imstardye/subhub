// SPDX-License-Identifier: AGPL-3.0-only
import { defineNuxtConfig } from 'nuxt/config';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
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
      ],
    },
  },
});
