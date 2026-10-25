// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Naive UI SSR style hand-off.
 *
 * Naive UI renders its component CSS through `@css-render/vue3-ssr`. The
 * official Nuxt module sets up the collector but writes the result to
 * `ssrContext.styles`, a property Nuxt 3.21 no longer renders. This plugin
 * provides its own collector (registered after the module's, so it is the one
 * the components see) and pushes the collected CSS onto the request head.
 * `app:rendered` fires after the Vue render and before `renderSSRHead`, so the
 * styles are present in the first HTML paint (no client-side style flash).
 */
import { setup } from '@css-render/vue3-ssr';
import { defineNuxtPlugin } from '#app';

export default defineNuxtPlugin((nuxtApp) => {
  if (!import.meta.server) return;
  const { collect } = setup(nuxtApp.vueApp);
  nuxtApp.hook('app:rendered', () => {
    const context = nuxtApp.ssrContext;
    const css = collect();
    if (!context || !css) return;
    context.head.push({ style: [{ innerHTML: css, key: 'naive-ui' }] });
  });
});
