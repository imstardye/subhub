// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Form state and request payload for the users page (`pages/users.vue`).
 *
 * Kept as pure functions outside the SFC so the create/edit submit path can be
 * unit-tested without mounting the component: the page only wires these into
 * `$fetch` and the reactive refs.
 *
 * Regression context: editing a user whose 规则档 ID input held a value used to
 * fail with no visible feedback at all. The payload itself is built here and,
 * for the settings the form can produce, is exactly what the API accepts
 * (`profileId` as a string id or null). Any remaining failure now surfaces
 * through `$fetch`'s rejection, which the page always turns into a banner.
 */

/** The user form; every field is a string or boolean so `<input>` can bind it. */
export interface UserForm {
  name: string;
  enabled: boolean;
  note: string;
  profileId: string;
}

/** Body sent to POST /api/admin/users and PATCH /api/admin/users/:id. */
export interface UserPayload {
  name: string;
  enabled: boolean;
  note: string | null;
  profileId: string | null;
}

export function emptyUserForm(): UserForm {
  return { name: '', enabled: true, note: '', profileId: '' };
}

/** Seed the edit form from a listed user; a missing profile id becomes ''. */
export function userFormFromUser(user: {
  name: string;
  enabled: boolean;
  note?: string | null;
  profileId?: number | null;
}): UserForm {
  return {
    name: user.name,
    enabled: user.enabled,
    note: user.note ?? '',
    profileId: user.profileId === null || user.profileId === undefined ? '' : String(user.profileId),
  };
}

export type UserPayloadResult = { ok: true; payload: UserPayload } | { ok: false; error: string };

/**
 * Validate the form and build the request body.
 *
 * The 规则档 ID is optional: empty (or whitespace) means "no profile" and is
 * sent as `null`, which clears the assignment on PATCH. A non-empty value must
 * be a positive integer (what the API's `parseProfileId` accepts).
 */
export function buildUserPayload(form: UserForm): UserPayloadResult {
  const name = form.name.trim();
  if (!name) return { ok: false, error: '请填写名称' };

  const rawProfileId = form.profileId.trim();
  if (rawProfileId) {
    const profileId = Number(rawProfileId);
    if (!Number.isInteger(profileId) || profileId <= 0) {
      return { ok: false, error: '规则档 ID 必须是正整数' };
    }
  }

  return {
    ok: true,
    payload: {
      name,
      enabled: form.enabled,
      note: form.note.trim() || null,
      profileId: rawProfileId || null,
    },
  };
}
