// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Nitro scheduled task: refresh every remote source whose cache is due.
 *
 * The actual logic lives in `server/utils/refresh-sources.ts` (a plain module,
 * injectable and unit-tested). This file is only the build-time task wrapper;
 * `defineTask` is a Nitro global and this module must never be imported by
 * vitest — tests drive `refreshAllDueSources` directly instead.
 *
 * `nuxt.config.ts` schedules it every 5 minutes. Whether a source is actually
 * fetched is decided per source by `refresh_minutes` inside
 * `refreshAllDueSources`; do not turn the schedule itself into the due check.
 */
import { refreshAllDueSources } from '../utils/refresh-sources';

// Nitro injects this global at build time. The declaration keeps the root
// `tsc --noEmit` (which has no generated Nitro globals) happy without pulling
// Nitro's runtime types into every other server module.
declare const defineTask: <T>(definition: T) => T;

export default defineTask({
  meta: { name: 'refresh-sources', description: 'Refresh due remote subscription sources' },
  async run() {
    const { getServerDb } = await import('../utils/db');
    const result = await refreshAllDueSources(getServerDb());
    console.log('[task] refresh-sources', result);
    return { result };
  },
});
