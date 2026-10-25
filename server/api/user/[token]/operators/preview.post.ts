// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/operators/preview — dry-run a candidate pipeline.
 *
 * Body: `{ operators: NodeOperator[] }`. Applies the candidate to the
 * owner's real nodes and reports before/after names, drops, renames and
 * the proxy groups that survive, so the editor can show the effect before
 * anything is saved (a rename can starve a profile group). Persists
 * nothing. Behind the /my password gate.
 */
import { requireEnabledUserByToken } from '../../../../utils/user-center';
import { previewUserOperators } from '../../../../utils/operators';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../../utils/user-routes';
import { parseBody } from '../../../../utils/admin-routes';
import { sendJson, type AdminApiEvent } from '../../../../utils/admin-api';

export default function userOperatorsPreviewHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const body = await parseBody(event);
      const preview = await previewUserOperators(db, user.id, body.operators);
      return sendJson(event, 200, { preview });
    },
    options,
  );
}
