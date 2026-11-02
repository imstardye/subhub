// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/user/:token/tailscale-dialer — choose (or clear) the policy group
 * the Tailscale outbound dials its control connection through.
 *
 * Body: `{ group: string | null }`. `null` (or a blank string) = 直连. A name
 * must be one of the user's current `tailscaleDialerOptions` (derived from
 * their assigned profile, reserved Tailscale names excluded); anything else is
 * a 400. The answer is the same `{ tailscaleDialerProxy, tailscaleDialerOptions }`
 * shape the /my GET carries. Behind the /my password gate like every other
 * user-side write.
 */
import { requireEnabledUserByToken } from '../../../utils/user-center';
import { setUserTailscaleDialerProxy } from '../../../utils/tailscale-dialer';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userTailscaleDialerHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      const state = await setUserTailscaleDialerProxy(db, user, body.group);
      return sendJson(event, 200, {
        tailscaleDialerProxy: state.dialerProxy,
        tailscaleDialerOptions: state.options,
      });
    },
    options,
  );
}
