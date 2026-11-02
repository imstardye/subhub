// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /auth/error?code=<whitelisted code> — friendly failure page.
 *
 * Whitelisted codes only (`unbound`, `conflict`, `state`, `expired`,
 * `provider`, `disabled`); anything else renders the generic text. The page is
 * built from `core/oidc.ts` constants — raw provider errors, emails and `sub`
 * values are never reflected.
 */
import { oidcErrorPage } from '../../../core/oidc';
import { escapeHtml, sendStandaloneHtml, type AuthEvent } from '../../utils/auth-routes';
import { requestQuery } from '../../utils/admin-api';

export default function authErrorPage(event: AuthEvent) {
  const page = oidcErrorPage(requestQuery(event as never).code);
  sendStandaloneHtml(
    event,
    200,
    page.title,
    `<div class="mark muted" aria-hidden="true">!</div>
<h1>${escapeHtml(page.title)}</h1>
<p>${escapeHtml(page.detail)}</p>
${page.contact ? `<p class="contact">${escapeHtml(page.contact)}</p>` : ''}`,
  );
}
