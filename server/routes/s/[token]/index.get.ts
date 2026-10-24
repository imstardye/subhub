// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /s/:token — subscription export without an explicit target; the target is
 * guessed from the User-Agent (mihomo when unrecognised).
 *
 * Also serves form 2 of the profile override, GET /s/:token/:profile: when the
 * 2nd segment is not a known target but is a profile name, it is applied to that
 * User-Agent target (`requestFromEvent` decides the shape; the name is resolved
 * against the database by the export, unknown -> 404).
 *
 * P2 minimal implementation. User lookup, per-token rate limiting (30/min),
 * access logging and a placeholder body (empty `proxies` when the user has no
 * source cache) live in `server/utils/subscription.ts`; real source
 * parsing/pipeline, aggregated `subscription-userinfo` and the dedicated
 * shadowrocket/sing-box/surge/loon/uri producers come later (P4).
 */
import exportHandler from '../../../utils/export-handler';

export default exportHandler;
