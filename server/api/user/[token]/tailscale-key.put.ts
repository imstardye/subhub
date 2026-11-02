// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/user/:token/tailscale-key — bind or clear the owner's Tailscale
 * auth key.
 *
 * Body: `{ authKey: string }`. A non-empty value is trimmed, length-capped
 * (512) and stored ENCRYPTED; an empty string clears the binding. The key is
 * write-only: the answer is `{ tailscaleKeySet }`, and no endpoint ever returns
 * the value. Behind the /my password gate like every other user-side write.
 */
import { requireEnabledUserByToken } from '../../../utils/user-center';
import { setUserTailscaleKey } from '../../../utils/tailscale';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userTailscaleKeyHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      const state = setUserTailscaleKey(db, user.id, body.authKey);
      return sendJson(event, 200, state);
    },
    options,
  );
}
