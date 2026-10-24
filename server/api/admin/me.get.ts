// SPDX-License-Identifier: AGPL-3.0-only
/**
 * GET /api/admin/me — whether the request carries a valid admin session.
 *
 * Always 200 with `{ authenticated: boolean }`; the route middleware redirects
 * to /login when false, and the login page uses it to skip an already
 * authenticated visitor.
 */
import { me, type AdminEvent } from '../../utils/admin-auth';

export default function adminMeHandler(event: AdminEvent) {
  event.node.res.setHeader('cache-control', 'no-store');
  return me(event);
}
