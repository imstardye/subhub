// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Guard: the periodic source refresh is actually wired into Nitro.
 *
 * `refreshAllDueSources` used to be a plain module with no task registration, so
 * nothing ever ran it on a schedule. There is no DOM/SSR test harness for Nitro
 * tasks here, so — like `tests/app-layout.test.ts` — this asserts on the source
 * of `nuxt.config.ts` and the task wrapper. The task wrapper itself must not be
 * imported: `defineTask` is a Nitro build-time global and only exists inside
 * the built server. Its behaviour is covered by the `refreshAllDueSources`
 * tests against `server/utils/refresh-sources.ts`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Nitro scheduled task wiring', () => {
  const config = readFileSync(new URL('../nuxt.config.ts', import.meta.url), 'utf8');
  const task = readFileSync(new URL('../server/tasks/refresh-sources.ts', import.meta.url), 'utf8');

  it('enables Nitro experimental tasks', () => {
    expect(config).toMatch(/nitro:\s*\{/);
    expect(config).toMatch(/experimental:\s*\{[^}]*tasks:\s*true/);
  });

  it('schedules refresh-sources every 5 minutes', () => {
    expect(config).toMatch(/scheduledTasks:\s*\{/);
    expect(config).toMatch(/['"]\*\/5 \* \* \* \*['"]\s*:\s*\[\s*['"]refresh-sources['"]\s*\]/);
  });

  it('registers a defineTask wrapper with the expected meta name', () => {
    expect(task).toContain('defineTask(');
    expect(task).toMatch(/name:\s*['"]refresh-sources['"]/);
    expect(task).toContain('refreshAllDueSources');
  });
});
