// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Guard: `app.vue` must wrap `<NuxtPage />` in `<NuxtLayout>`.
 *
 * Without it, `definePageMeta({ layout: 'admin' })` is ignored and
 * `layouts/admin.vue` never mounts: no sidebar, no content margins, and the
 * layout's `/api/admin/me` fetch that seeds the `admin-sub-path` state never
 * runs — admin copy-links then silently use the default `s` prefix even when
 * the site setting says otherwise (live incident 2026-10-25). There is no DOM
 * test environment in this repo, so — like the /my page import guard — this
 * asserts on the SFC source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('app.vue layout wiring', () => {
  const vue = readFileSync(new URL('../app.vue', import.meta.url), 'utf8');

  it('wraps NuxtPage in NuxtLayout', () => {
    const layoutOpen = vue.indexOf('<NuxtLayout');
    const page = vue.indexOf('<NuxtPage');
    const layoutClose = vue.indexOf('</NuxtLayout>');
    expect(layoutOpen).toBeGreaterThanOrEqual(0);
    expect(page).toBeGreaterThan(layoutOpen);
    expect(layoutClose).toBeGreaterThan(page);
  });
});
