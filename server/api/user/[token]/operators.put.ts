// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PUT /api/user/:token/operators — save the owner's node operator pipeline.
 *
 * Body: `{ operators: NodeOperator[] }` (see `core/operators.ts`). The
 * shared save path validates structure and compiles every regex; an empty
 * list clears the pipeline. Behind the /my password gate like every other
 * user-side write.
 */
import { requireEnabledUserByToken } from '../../../utils/user-center';
import { saveUserOperators } from '../../../utils/operators';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { parseBody } from '../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userOperatorsHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      const saved = saveUserOperators(db, user.id, body.operators);
      return sendJson(event, 200, { operators: saved.operators, count: saved.count });
    },
    options,
  );
}
