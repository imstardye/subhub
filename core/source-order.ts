// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user subscription source ordering.
 *
 * `users.source_order` stores a JSON array of source ids. The order is a
 * preference, not a filter: ids that no longer resolve (deleted sources, ids
 * from another user) are ignored, and any source the user can see that is not
 * listed keeps its default position at the tail. That is what makes "new
 * sources appear last" automatic.
 */

/**
 * Read the stored column defensively. Anything that is not a JSON array of
 * positive integers is ignored; duplicates keep their first occurrence.
 */
export function parseSourceOrderJson(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<number>();
    const order: number[] = [];
    for (const value of parsed) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      order.push(value);
    }
    return order;
  } catch {
    return [];
  }
}

/**
 * Put rows listed in `order` first, in the saved sequence; everything else
 * follows in its incoming (default) relative order. Absent/stale ids are
 * ignored. An empty order returns a copy of the input untouched, so a user
 * without a saved order gets byte-identical exports.
 */
export function applySourceOrder<T extends { id: number }>(
  rows: readonly T[],
  order: readonly number[],
): T[] {
  if (order.length === 0) return [...rows];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const used = new Set<number>();
  const head: T[] = [];
  for (const id of order) {
    if (used.has(id)) continue;
    const row = byId.get(id);
    if (!row) continue;
    used.add(id);
    head.push(row);
  }
  const tail = rows.filter((row) => !used.has(row.id));
  return [...head, ...tail];
}
