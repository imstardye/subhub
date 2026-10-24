// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/tasks/refresh-sources — manual trigger for the cache refresh task.
 *
 * No admin UI and no auth layer yet (P2 has none): this lives under /api,
 * outside the public /s/:token export, and simply reports a refresh summary.
 * Query: `?sourceId=123` narrows the run, `?force=1` ignores the due check.
 *
 * Uses a minimal local event shape instead of Nuxt auto-import globals so the
 * module type-checks without the generated `.nuxt` types.
 */
import { refreshAllDueSources } from '../../tasks/refresh-sources';
import { getServerDb } from '../../utils/db';

interface TaskEvent {
  _path?: string;
  node: {
    req: { url?: string };
    res: { statusCode: number };
  };
}

function firstQueryValue(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export default async function refreshSourcesHandler(event: TaskEvent) {
  const url = new URL(event.node.req.url ?? '/', 'http://localhost');
  const sourceIdRaw = firstQueryValue(url.searchParams.get('sourceId'));
  const sourceId = sourceIdRaw ? Number(sourceIdRaw) : undefined;
  if (sourceId !== undefined && !Number.isInteger(sourceId)) {
    event.node.res.statusCode = 400;
    return { error: 'invalid sourceId' };
  }
  const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
  return refreshAllDueSources(getServerDb(), { sourceId, force });
}
