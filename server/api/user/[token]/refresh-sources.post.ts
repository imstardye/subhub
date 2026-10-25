// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/user/:token/refresh-sources — manually refresh the token owner's
 * own DEDICATED sources.
 *
 * Behind the /my password gate (see `handleUserRequest`): only an unlocked
 * session may refresh. Shared/public sources and other users' sources are never
 * touched; paused sources are reported as skipped. Reuses the periodic task's
 * `refreshSource` per source, so cache/userinfo/failure handling is identical.
 */
import {
  refreshOwnSources,
  requireEnabledUserByToken,
} from '../../../utils/user-center';
import {
  handleUserRequest,
  tokenFromPath,
  type UserRequestOptions,
} from '../../../utils/user-routes';
import { sendJson, type AdminApiEvent } from '../../../utils/admin-api';

export default function userSourcesRefreshHandler(
  event: AdminApiEvent,
  options?: UserRequestOptions,
) {
  return handleUserRequest(
    event,
    async (db) => {
      const user = requireEnabledUserByToken(db, tokenFromPath(event));
      const result = await refreshOwnSources(db, user.id);
      return sendJson(event, 200, result);
    },
    options,
  );
}
