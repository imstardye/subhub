// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /s/:token/:target — subscription export for an explicit target
 * (`mihomo`, `clash`, `shadowrocket`, `singbox`, `surge`, `loon`, `uri`).
 *
 * Same handler as `/s/:token`; see `index.get.ts` for the P2 scope and the
 * P4 TODO list.
 */
import exportHandler from '../../../utils/export-handler';

export default exportHandler;
