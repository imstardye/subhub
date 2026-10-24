// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Subscription preview for POST /api/admin/preview (P3).
 *
 * Renders exactly what `/s/:token/:target` would return for a user, but for the
 * admin UI: no token lookup, no rate limiting and **no access log line**. The
 * disabled flag is reported so an admin can debug a suspended user's output.
 *
 * The rendered body is capped at `PREVIEW_BODY_MAX_BYTES` (~200 KiB) so a user
 * with hundreds of nodes cannot stall the admin page; `truncated` flags it.
 *
 * The user's rule profile is applied exactly as in the public export (same
 * `loadUserProfile` + `renderTargetBody` path), so what an admin sees here is
 * what `/s/:token` serves. An optional `profile` (profile *name*) overrides the
 * assigned profile exactly like the URL's trailing segment — unknown name is a
 * 404 here too, never a silent fallback.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { users } from '../db/schema';
import {
  collectUserNodes,
  loadUserProfile,
  renderTargetBody,
  resolveProfileIdByName,
} from './export-nodes';
import {
  contentTypeForTarget,
  EXPORT_TARGETS,
  isExportTarget,
  type ExportTarget,
} from './targets';
import { parseId, ValidationError } from './admin-validation';

/** Hard cap on the returned body (~200 KiB); larger exports are cut off. */
export const PREVIEW_BODY_MAX_BYTES = 200 * 1024;

export const DEFAULT_PREVIEW_TARGET: ExportTarget = 'mihomo';

export interface PreviewResult {
  userId: number;
  name: string;
  enabled: boolean;
  target: ExportTarget;
  /** Profile override the caller asked for (absent when none was given). */
  profile?: string | null;
  status: number;
  contentType: string;
  body: string;
  truncated?: boolean;
}

/**
 * Cut `body` to at most `maxBytes` UTF-8 bytes without splitting a character.
 * Returns the (possibly shorter) body and whether anything was dropped.
 */
export function truncateBody(
  body: string,
  maxBytes: number = PREVIEW_BODY_MAX_BYTES,
): { body: string; truncated: boolean } {
  if (Buffer.byteLength(body, 'utf8') <= maxBytes) return { body, truncated: false };
  const buffer = Buffer.from(body, 'utf8').subarray(0, maxBytes);
  // `toString` drops an incomplete trailing sequence, keeping the YAML valid-ish.
  return { body: buffer.toString('utf8'), truncated: true };
}

/** Validate the requested target; absent means mihomo, unknown is a 400. */
function parsePreviewTarget(value: unknown): ExportTarget {
  if (value === undefined || value === null || value === '') return DEFAULT_PREVIEW_TARGET;
  const target = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isExportTarget(target)) {
    throw new ValidationError(`target must be one of: ${EXPORT_TARGETS.join(', ')}`);
  }
  return target;
}

/**
 * Validate the optional profile override; absent means "no override". The name
 * is passed through untrimmed-but-checked (profiles are matched exactly), only
 * rejecting obviously unusable input.
 */
function parsePreviewProfile(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('profile must be a string');
  return value;
}

/**
 * Render a preview for `body.userId`. A missing user is a 404; a disabled user
 * is still rendered (admin debugging) and flagged via `enabled: false`.
 *
 * Async because the profile's INI may have to be fetched (`iniUrl`).
 */
export async function previewSubscription(
  db: SubhubDb,
  body: Record<string, unknown>,
): Promise<PreviewResult> {
  const userId = parseId(body.userId);
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user) throw new ValidationError('user not found', 404);

  const target = parsePreviewTarget(body.target);
  // Profile override by name (same semantics as `/s/:token/:target/:profile`).
  const profileName = parsePreviewProfile(body.profile);
  let overrideProfileId: number | null = null;
  if (profileName) {
    overrideProfileId = resolveProfileIdByName(db, profileName);
    if (overrideProfileId === null) throw new ValidationError('profile not found', 404);
  }

  const nodes = collectUserNodes(db, user.id);
  // Same single-pass profile load as the public export: `exclude_remarks` is
  // applied to `nodes` before the groups are expanded.
  const loaded = await loadUserProfile(
    db,
    user.id,
    target,
    nodes,
    undefined,
    overrideProfileId,
  );
  const rendered = renderTargetBody(target, loaded?.nodes ?? nodes, {}, loaded?.profile ?? null);
  const { body: text, truncated } = truncateBody(rendered);

  return {
    userId: user.id,
    name: user.name,
    enabled: user.enabled,
    target,
    profile: profileName,
    status: 200,
    // json for sing-box, plain text for the share-link and line-based
    // bodies, YAML for mihomo/clash.
    contentType: contentTypeForTarget(target),
    body: text,
    ...(truncated ? { truncated: true } : {}),
  };
}
