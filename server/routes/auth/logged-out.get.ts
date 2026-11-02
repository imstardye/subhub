// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /auth/logged-out — post-logout landing page ("已退出登录").
 *
 * A tiny standalone page (no layout, no data): the IdP's `end_session` redirects
 * here after an XAuth logout, and a password logout lands here directly. It
 * links back to nothing secret — the user re-enters through `/auth/login` (or
 * their /my link) themselves.
 */
import { XAUTH_LOGIN_PATH } from '../../../core/oidc';
import { sendStandaloneHtml, type AuthEvent } from '../../utils/auth-routes';

export default function authLoggedOutPage(event: AuthEvent) {
  sendStandaloneHtml(
    event,
    200,
    '已退出登录',
    `<div class="mark" aria-hidden="true">S</div>
<h1>已退出登录</h1>
<p>本机登录状态已清除。</p>
<a class="btn" href="${XAUTH_LOGIN_PATH}">重新使用 XAuth 登录</a>`,
  );
}
