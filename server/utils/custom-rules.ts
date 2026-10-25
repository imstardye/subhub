// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saving per-user custom rules (user center + admin代改 share this path).
 *
 * The rules are validated twice by design (see `core/rules/custom-rules.ts`):
 * here at save time — syntax per line, then every policy must resolve
 * against the user's assigned profile (its surviving groups, the emitted
 * node names, the built-ins) and every RULE-SET must name a provider that
 * profile defines — and again at export time inside `loadUserProfile`,
 * against the profile that render actually uses. A user without a usable
 * profile cannot save rules yet (v1 boundary: every live user has one);
 * clearing the text is always allowed.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { users, type User } from '../db/schema';
import {
  BUILTIN_GROUP_MEMBERS,
  parseCustomRulePosition,
  parseCustomRules,
  validateCustomRulePolicies,
  type CustomRuleError,
  type CustomRulePosition,
} from '../../core';
import { collectUserNodes, loadUserProfile, targetProxyNames } from './export-nodes';
import { ValidationError } from './admin-validation';

export interface UserCustomRules {
  /** The stored rules, newline-joined ('' when none). */
  text: string;
  position: CustomRulePosition;
  /** Number of rule lines (0 when none). */
  count: number;
}

/** The DTO view of a user row's custom rules. */
export function readUserCustomRules(user: User): UserCustomRules {
  const text = user.customRules ?? '';
  return {
    text,
    position: user.customRulesPosition === 'append' ? 'append' : 'prepend',
    count: text === '' ? 0 : text.split('\n').filter((line) => line.trim() !== '').length,
  };
}

function formatRuleErrors(errors: CustomRuleError[]): string {
  const shown = errors.slice(0, 5).map((error) => `第 ${error.line} 行：${error.message}`);
  const rest = errors.length > 5 ? `；另有 ${errors.length - 5} 处错误` : '';
  return `自定义规则有误 — ${shown.join('；')}${rest}`;
}

/**
 * Validate and store a user's custom rules. `rawPosition` may be omitted to
 * keep the stored position. Returns the stored view. Throws ValidationError
 * (400) with per-line messages on any problem; nothing is written then.
 */
export async function saveUserCustomRules(
  db: SubhubDb,
  userId: number,
  rawText: unknown,
  rawPosition?: unknown,
): Promise<UserCustomRules> {
  const existing = db.select().from(users).where(eq(users.id, userId)).get();
  if (!existing) throw new ValidationError('user not found', 404);

  const position =
    rawPosition === undefined
      ? readUserCustomRules(existing).position
      : parseCustomRulePosition(rawPosition);
  if (position === null) {
    throw new ValidationError('规则位置只能是 prepend（前置）或 append（后置）');
  }

  const parsed = parseCustomRules(rawText);
  if (parsed.errors.length > 0) throw new ValidationError(formatRuleErrors(parsed.errors));

  if (parsed.entries.length > 0) {
    const nodes = collectUserNodes(db, userId);
    const loaded = await loadUserProfile(db, userId, 'mihomo', nodes);
    if (!loaded) {
      throw new ValidationError('该用户尚未分配规则档，自定义规则暂不可用');
    }
    const allowedPolicies = new Set<string>([
      ...loaded.profile.groupNames,
      ...targetProxyNames('mihomo', loaded.nodes),
      ...BUILTIN_GROUP_MEMBERS,
    ]);
    const policyErrors = validateCustomRulePolicies(
      parsed.entries,
      allowedPolicies,
      new Set(Object.keys(loaded.profile.ruleProviders)),
    );
    if (policyErrors.length > 0) throw new ValidationError(formatRuleErrors(policyErrors));
  }

  const text = parsed.entries.map((entry) => entry.rule).join('\n');
  const row = db
    .update(users)
    .set({ customRules: text === '' ? null : text, customRulesPosition: position })
    .where(eq(users.id, userId))
    .returning()
    .get();
  if (!row) throw new ValidationError('user not found', 404);
  return readUserCustomRules(row);
}
