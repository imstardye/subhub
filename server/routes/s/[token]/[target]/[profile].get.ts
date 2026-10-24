// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /s/:token/:target/:profile — subscription export for an explicit target
 * (`mihomo`, `clash`, `shadowrocket`, `singbox`, `surge`, `loon`, `uri`) with a
 * rule-profile override by profile *name* (case-sensitive).
 *
 * The override replaces `users.profileId` for this request only: proxy groups,
 * rules, rule-providers, the profile `dnsTemplate` and `[common]
 * exclude_remarks` all come from the named profile. An unknown name is a 404.
 *
 * Same handler as `/s/:token`; see `export-handler.ts` for the segment
 * resolution (form 2, `/s/:token/:profile`, is served by `index.get.ts`).
 */
import exportHandler from '../../../../utils/export-handler';

export default exportHandler;
