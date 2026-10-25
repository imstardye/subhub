// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Saving and dry-running per-user operator pipelines.
 *
 * One save path for the user center (`PUT /api/user/:token/operators`) and
 * the admin user update, exactly like custom rules: validation is the pure
 * core `validateOperators`, so a stored pipeline is always runnable and
 * the export side only has to be defensive, never clever.
 *
 * The dry-run (`previewUserOperators`) is what makes the /my editor safe
 * to use: renaming runs BEFORE profile group expansion, so a rename can
 * starve a group. The preview applies a candidate pipeline to the user's
 * real nodes (tagged so drops/renames can be attributed) and reports the
 * before/after name lists plus the groups that survive — all without
 * persisting anything.
 */
import { eq } from 'drizzle-orm';
import type { SubhubDb } from '../db';
import { users, type User } from '../db/schema';
import {
  applyOperators,
  parseOperatorsJson,
  validateOperators,
  type NodeOperator,
  type OperatorError,
  type ProxyNode,
} from '../../core';
import { collectUserNodes, loadUserProfile } from './export-nodes';
import { ValidationError } from './admin-validation';

export interface UserOperators {
  operators: NodeOperator[];
  count: number;
}

/** The DTO view of a user row's stored pipeline. */
export function readUserOperators(user: User): UserOperators {
  const operators = parseOperatorsJson(user.operators);
  return { operators, count: operators.length };
}

function formatOperatorErrors(errors: OperatorError[]): string {
  const shown = errors
    .slice(0, 5)
    .map((error) => (error.index >= 0 ? `第 ${error.index + 1} 个算子：${error.message}` : error.message));
  const rest = errors.length > 5 ? `；另有 ${errors.length - 5} 处错误` : '';
  return `算子配置有误 — ${shown.join('；')}${rest}`;
}

/** Validate candidate input or throw the shared 400. Returns the clean list. */
export function checkedOperators(input: unknown): NodeOperator[] {
  const { operators, errors } = validateOperators(input);
  if (errors.length > 0) throw new ValidationError(formatOperatorErrors(errors));
  return operators;
}

/**
 * Validate and store a user's pipeline. An empty list clears the column.
 * Throws ValidationError (400) with per-operator messages; nothing is
 * written then.
 */
export function saveUserOperators(db: SubhubDb, userId: number, input: unknown): UserOperators {
  const existing = db.select().from(users).where(eq(users.id, userId)).get();
  if (!existing) throw new ValidationError('user not found', 404);
  const operators = checkedOperators(input);
  const row = db
    .update(users)
    .set({ operators: operators.length > 0 ? JSON.stringify(operators) : null })
    .where(eq(users.id, userId))
    .returning()
    .get();
  if (!row) throw new ValidationError('user not found', 404);
  return readUserOperators(row);
}

export interface OperatorsPreview {
  /** Node names the profile load sees without any pipeline. */
  beforeNames: string[];
  /** Node names after the candidate pipeline. */
  afterNames: string[];
  /** Names the pipeline removed (before-order). */
  droppedNames: string[];
  /** Nodes whose name changed: before -> after. */
  renamed: Array<{ from: string; to: string }>;
  /** Proxy groups that survive with the candidate pipeline applied. */
  groups: string[];
}

/** Tag field used to attribute drops/renames across the two profile loads. */
const TAG = '__opPreviewIdx';

type TaggedNode = ProxyNode & { [TAG]?: number };

/**
 * Dry-run a candidate pipeline against the user's real nodes. "Before" is
 * the profile load with NO pipeline (the built-in info filter still runs —
 * it is not part of the pipeline); "after" is the same load with the
 * candidate. A profile-less user gets the raw-node fallback on both sides.
 */
export async function previewUserOperators(
  db: SubhubDb,
  userId: number,
  input: unknown,
): Promise<OperatorsPreview> {
  const candidate = checkedOperators(input);
  const nodes = collectUserNodes(db, userId);
  const tagged: TaggedNode[] = nodes.map((node, index) => ({ ...node, [TAG]: index }));

  const baseline = await loadUserProfile(db, userId, 'mihomo', tagged, undefined, undefined, []);
  const applied = await loadUserProfile(db, userId, 'mihomo', tagged, undefined, undefined, candidate);

  const beforeNodes = (baseline?.nodes ?? tagged) as TaggedNode[];
  const afterNodes = (applied?.nodes ?? applyOperators(tagged, candidate)) as TaggedNode[];

  const beforeByIdx = new Map<number, string>();
  for (const node of beforeNodes) {
    if (typeof node[TAG] === 'number') beforeByIdx.set(node[TAG], node.name);
  }
  const afterIdx = new Set<number>();
  const renamed: Array<{ from: string; to: string }> = [];
  for (const node of afterNodes) {
    const idx = node[TAG];
    if (typeof idx !== 'number') continue;
    afterIdx.add(idx);
    const from = beforeByIdx.get(idx);
    if (from !== undefined && from !== node.name) renamed.push({ from, to: node.name });
  }
  const droppedNames: string[] = [];
  for (const [idx, name] of beforeByIdx) {
    if (!afterIdx.has(idx)) droppedNames.push(name);
  }

  return {
    beforeNames: beforeNodes.map((node) => node.name),
    afterNames: afterNodes.map((node) => node.name),
    droppedNames,
    renamed,
    groups: applied?.profile.groupNames ?? [],
  };
}
