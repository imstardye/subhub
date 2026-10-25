// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/user/:token/rules — save the owner's custom rules (user center).
 *
 * Body: `{ rules: string, position?: 'prepend' | 'append' }` — one Clash
 * rule per line. Validation lives in `server/utils/custom-rules.ts`, shared
 * with the admin代改 path: syntax per line, every policy must resolve
 * against the user's profile, and a profile-less user cannot save rules
 * yet. Behind the /my password gate like every other user-side write.
 */
import { requireEnabledUserByToken } from '../../../utils/user-center';
import { saveUserCustomRules } from '../../../utils/custom-rules';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userCustomRulesHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      const customRules = await saveUserCustomRules(db, user.id, body.rules, body.position);
      return sendJson(event, 200, { customRules });
    },
    options,
  );
}
