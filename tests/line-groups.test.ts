// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared proxy-group machinery for the line-based clients (`buildLineGroups`,
 * `lineGroup`, `joinSections`). The per-client tests (surge/loon) own the
 * keyword mapping; this file pins the generic invariants both rely on:
 * nothing in an emitted group may reference an undefined policy, and the
 * pruning must reach a fixpoint.
 */
import { describe, expect, it } from 'vitest';
import type { ClashProxyGroup } from '../core/types';
import { buildLineGroups, joinSections, lineGroup, type LineGroup } from '../core/producers';
import { isWritableName } from '../core/producers/groups';

const OPTIONS = { typeMap: { select: 'select' }, builtins: ['DIRECT'] };

function group(overrides: Partial<ClashProxyGroup>): ClashProxyGroup {
  return { name: 'group', type: 'select', proxies: [], ...overrides };
}

/** Every member of every group must be an emitted node, a kept group or a built-in. */
function assertNoDanglingReferences(groups: LineGroup[], nodes: string[]): void {
  const defined = new Set([...nodes, ...groups.map((entry) => entry.name), 'DIRECT']);
  for (const entry of groups) {
    for (const member of entry.members) {
      expect(defined.has(member), `${entry.name} -> ${member}`).toBe(true);
    }
  }
}

describe('buildLineGroups: pruning to a fixpoint', () => {
  it('drops a chain of groups whose only node is not emitted', () => {
    const groups = buildLineGroups(
      [
        group({ name: 'a', proxies: ['b'] }),
        group({ name: 'b', proxies: ['c'] }),
        group({ name: 'c', proxies: ['gone'] }),
        group({ name: 'keep', proxies: ['node-1'] }),
      ],
      ['node-1'],
      OPTIONS,
    );

    expect(groups.map((entry) => entry.name)).toEqual(['keep']);
    assertNoDanglingReferences(groups, ['node-1']);
  });

  it('keeps a cycle that still reaches a real node, and drops one that does not', () => {
    const groups = buildLineGroups(
      [
        group({ name: 'loop-a', proxies: ['loop-b', 'node-1'] }),
        group({ name: 'loop-b', proxies: ['loop-a'] }),
        group({ name: 'dead-a', proxies: ['dead-b'] }),
        group({ name: 'dead-b', proxies: ['dead-a'] }),
      ],
      ['node-1'],
      OPTIONS,
    );

    expect(groups.map((entry) => entry.name)).toEqual(['loop-a', 'loop-b']);
    assertNoDanglingReferences(groups, ['node-1']);
  });

  it('removes a cycle with no node behind it (never a dangling pair)', () => {
    // A pure cycle looks "alive" to a single pass; it is kept only because
    // clients tolerate it while nothing else references it. It must not keep
    // an otherwise-dead group alive through its reference.
    const groups = buildLineGroups(
      [
        group({ name: 'dead', proxies: ['cycle-a'] }),
        group({ name: 'cycle-a', proxies: ['cycle-b'] }),
        group({ name: 'cycle-b', proxies: ['cycle-a'] }),
      ],
      [],
      OPTIONS,
    );
    expect(groups.map((entry) => entry.name)).not.toContain('dead');
    assertNoDanglingReferences(groups, []);
  });

  it('keeps a leaf service group that only rules point at', () => {
    // The 💬 Ai平台 shape: a select group whose members are all other
    // groups, referenced by nothing but rules. It is useful because it
    // reaches a node through its members — usefulness floods UP from the
    // outbound, not down from whichever group happens to reference it.
    const groups = buildLineGroups(
      [
        group({ name: 'ai', proxies: ['us', 'main'] }),
        group({ name: 'us', proxies: ['node-1'] }),
        group({ name: 'main', proxies: ['DIRECT'] }),
      ],
      ['node-1'],
      OPTIONS,
    );

    expect(groups.map((entry) => entry.name)).toEqual(['ai', 'us', 'main']);
    assertNoDanglingReferences(groups, ['node-1']);
  });

  it('does not mistake a missing node for a group of the same name', () => {
    // `node-x` is a *node name* the producer dropped; referencing it must be
    // pruned, and the group keeps only its built-in.
    const [only] = buildLineGroups([group({ name: 'g', proxies: ['node-x', 'DIRECT'] })], [], OPTIONS);
    expect(only!.members).toEqual(['DIRECT']);
    const none = buildLineGroups([group({ name: 'g', proxies: ['node-x'] })], [], OPTIONS);
    expect(none).toEqual([]);
  });

  it('normalizes built-in outbounds to the client spelling, once per case', () => {
    const [only] = buildLineGroups(
      [group({ name: 'g', proxies: ['direct', 'DIRECT', 'Direct'] })],
      [],
      OPTIONS,
    );
    expect(only!.members).toEqual(['DIRECT']);
  });

  it('preserves health-check fields and the lazy flag', () => {
    const [only] = buildLineGroups(
      [
        group({
          name: 'auto',
          proxies: ['node-1'],
          url: 'https://example.com/generate_204',
          interval: 300,
          tolerance: 50,
          lazy: true,
        }),
      ],
      ['node-1'],
      OPTIONS,
    );
    expect(only).toEqual({
      name: 'auto',
      type: 'select',
      members: ['node-1'],
      url: 'https://example.com/generate_204',
      interval: 300,
      tolerance: 50,
      noAlert: true,
    });
  });

  it('keeps the profile order of the surviving groups', () => {
    const groups = buildLineGroups(
      [
        group({ name: 'third', proxies: ['node-1'] }),
        group({ name: 'first', proxies: ['node-1'] }),
        group({ name: 'second', proxies: ['node-1'] }),
      ],
      ['node-1'],
      OPTIONS,
    );
    expect(groups.map((entry) => entry.name)).toEqual(['third', 'first', 'second']);
  });

  it('ignores an empty member, a non-string member and a group with no name', () => {
    const groups = buildLineGroups(
      [
        group({ name: 'g', proxies: ['', '  ', 'node-1', 42 as unknown as string] }),
        group({ name: '', proxies: ['node-1'] }),
      ],
      ['node-1'],
      OPTIONS,
    );
    expect(groups).toEqual([{ name: 'g', type: 'select', members: ['node-1'] }]);
  });
});

describe('lineGroup / joinSections', () => {
  it('writes the type, members and options in client order', () => {
    expect(
      lineGroup({
        name: '⚡ auto',
        type: 'url-test',
        members: ['a', 'b'],
        url: 'https://example.com/generate_204',
        interval: 300,
        tolerance: 50,
        noAlert: false,
      }),
    ).toBe('⚡ auto = url-test,a,b,url=https://example.com/generate_204,interval=300,tolerance=50,no-alert=0');
  });

  it('joins sections with exactly one blank line and a trailing newline', () => {
    expect(joinSections([['a', 'b'], [], ['c']])).toBe('a\nb\n\nc\n');
    expect(joinSections([[], []])).toBe('');
  });

  it('rejects names that cannot live on one config line', () => {
    expect(isWritableName('hk-01')).toBe(true);
    expect(isWritableName('  ')).toBe(false);
    expect(isWritableName('a\nb')).toBe(false);
    expect(isWritableName('a=b')).toBe(false);
  });
});
