// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user subscription source ordering (`feat/source-order`).
 *
 * Covers the pure overlay, the one export seam (`loadUserSourceCaches`), the
 * password-gated save path, the /my effective-order payload and the admin
 * clear-only surface.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { applySourceOrder, parseSourceOrderJson, type ProxyNode } from '../core';
import { openDb, type SubhubDb } from '../server/db';
import { encrypt } from '../server/db/crypto';
import { profiles, sources, userSourceChoices, users } from '../server/db/schema';
import { collectUserNodes, loadUserSourceCaches } from '../server/utils/export-nodes';
import { loadUserCenterData } from '../server/utils/user-center';
import { saveUserSourceOrder } from '../server/utils/source-order';
import { updateUser, toAdminUser } from '../server/utils/admin-users';
import { hashPassword } from '../server/utils/user-password';
import { issueUserSession, USER_SESSION_COOKIE } from '../server/utils/user-session';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { requestFromEvent } from '../server/utils/export-handler';
import userSourceOrderHandler from '../server/api/user/[token]/source-order.put';
import { makeApiEvent } from './helpers/admin-api';
import type { AdminApiEvent } from '../server/utils/admin-api';

const TOKEN = 'a'.repeat(32);
const PASSWORD = 'source-order-test-password';
const NODE_D1 = 'DEDICATED-ONE 节点';
const NODE_D2 = 'DEDICATED-TWO 节点';
const NODE_PUBLIC = 'PUBLIC-NODE 节点';

function cacheWith(name: string): string {
  return [
    'proxies:',
    `  - {name: "${name}", type: ss, server: ${name.length}.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}`,
    '',
  ].join('\n');
}

const dirs: string[] = [];
let db: SubhubDb;
let userId: number;
let d1Id: number;
let d2Id: number;
let publicId: number;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'subhub-source-order-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
  userId = db
    .insert(users)
    .values({
      name: 'alice',
      token: TOKEN,
      enabled: true,
      passwordHash: hashPassword(PASSWORD),
      passwordVersion: 1,
    })
    .returning({ id: users.id })
    .get()!.id;

  const addSource = (row: {
    name: string;
    ownerUserId: number | null;
    cache: string;
    enabled?: boolean;
  }) =>
    db
      .insert(sources)
      .values({
        name: row.name,
        url: encrypt(`https://${row.name}.example.com/sub`),
        type: 'remote',
        ownerUserId: row.ownerUserId,
        ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
        cacheBlob: cacheWith(row.cache),
      })
      .returning({ id: sources.id })
      .get()!.id;

  d1Id = addSource({ name: '私有一', ownerUserId: userId, cache: NODE_D1 });
  d2Id = addSource({ name: '私有二', ownerUserId: userId, cache: NODE_D2 });
  publicId = addSource({ name: '公共源', ownerUserId: null, cache: NODE_PUBLIC });
});

afterEach(() => {
  resetExportRateLimiter();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ids = (rows: Array<{ id: number }>) => rows.map((row) => row.id);
const names = (nodes: ProxyNode[]) => nodes.map((node) => node.name);

describe('source order: pure helpers', () => {
  it('reads garbage in the stored column as no order', () => {
    expect(parseSourceOrderJson(null)).toEqual([]);
    expect(parseSourceOrderJson('')).toEqual([]);
    expect(parseSourceOrderJson('not json')).toEqual([]);
    expect(parseSourceOrderJson('{"id":1}')).toEqual([]);
    expect(parseSourceOrderJson('"1"')).toEqual([]);
  });

  it('keeps positive integers only and dedupes preserving the first occurrence', () => {
    expect(parseSourceOrderJson('[3,1,3,"2",-1,0,1.5,2]')).toEqual([3, 1, 2]);
  });

  it('moves listed rows first, keeps unlisted rows stable at the tail and ignores stale ids', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    expect(applySourceOrder(rows, [3, 1])).toEqual([{ id: 3 }, { id: 1 }, { id: 2 }, { id: 4 }]);
    expect(applySourceOrder(rows, [99, 2])).toEqual([{ id: 2 }, { id: 1 }, { id: 3 }, { id: 4 }]);
    expect(applySourceOrder(rows, [])).toEqual(rows);
  });
});

describe('source order: export seam', () => {
  it('keeps the default bucket order when no order is saved', () => {
    expect(names(collectUserNodes(db, userId))).toEqual([NODE_D1, NODE_D2, NODE_PUBLIC]);
    expect(ids(loadUserSourceCaches(db, userId))).toEqual([d1Id, d2Id, publicId]);
  });

  it('applies the saved order across buckets and ignores stale ids', () => {
    expect(saveUserSourceOrder(db, userId, [publicId, d2Id, d1Id])).toEqual([
      publicId,
      d2Id,
      d1Id,
    ]);
    expect(names(collectUserNodes(db, userId))).toEqual([NODE_PUBLIC, NODE_D2, NODE_D1]);

    db.update(users)
      .set({ sourceOrder: JSON.stringify([publicId, 999_999, d1Id]) })
      .where(eq(users.id, userId))
      .run();
    expect(names(collectUserNodes(db, userId))).toEqual([NODE_PUBLIC, NODE_D1, NODE_D2]);
  });

  it('drives loadUserProfile and the rendered export through the same order', async () => {
    db.insert(profiles)
      .values({
        name: 'basic',
        iniText: '[Proxy Group]\nProxy = select, .*\n',
        variant: 'mihomo',
      })
      .run();
    const profileId = db.select({ id: profiles.id }).from(profiles).get()!.id;
    db.update(users).set({ profileId }).where(eq(users.id, userId)).run();
    saveUserSourceOrder(db, userId, [publicId, d2Id, d1Id]);

    const body = await exportProxyNames();
    expect(body).toEqual([NODE_PUBLIC, NODE_D2, NODE_D1]);
  });

  it('shows the /my card the same effective order, without paused/excluded sources', () => {
    saveUserSourceOrder(db, userId, [publicId, d2Id, d1Id]);
    db.update(sources).set({ enabled: false }).where(eq(sources.id, d2Id)).run();
    db.insert(userSourceChoices)
      .values({ userId, sourceId: publicId, included: false })
      .run();

    const data = loadUserCenterData(db, TOKEN);
    expect('sourceOrder' in data && data.sourceOrder.map((item) => item.id)).toEqual([d1Id]);
    expect('sourceOrder' in data && data.sourceOrder[0]).toMatchObject({
      name: '私有一',
      kind: 'dedicated',
      nodeCount: 1,
    });
  });
});

async function exportProxyNames(): Promise<string[]> {
  resetExportRateLimiter();
  const event = {
    path: `/s/${TOKEN}/mihomo`,
    context: {},
    node: {
      req: { headers: { 'user-agent': 'subhub-source-order-test/1.0' } },
      res: { statusCode: 200, setHeader() {} },
    },
  };
  const result = await handleSubscriptionExport(requestFromEvent(event as never), { db });
  expect(result.status).toBe(200);
  const document = parseYaml(result.body) as { proxies: Array<{ name: string }> };
  return document.proxies.map((proxy) => proxy.name);
}

async function callPut(
  body: unknown,
  behavior: { session?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { event } = makeApiEvent({
    url: `/api/user/${TOKEN}/source-order`,
    method: 'PUT',
    body,
  });
  if (behavior.session !== false) {
    const session = issueUserSession({ id: userId, passwordVersion: 1 });
    event.node.req.headers.cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
  }
  const result = (await userSourceOrderHandler(event as AdminApiEvent, { db })) as Record<
    string,
    unknown
  >;
  return { status: event.node.res.statusCode, body: result };
}

describe('source order API (PUT /api/user/:token/source-order)', () => {
  it('is locked without a valid /my session', async () => {
    const result = await callPut({ sourceIds: [d1Id] }, { session: false });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ status: 'needs-password' });
  });

  it('rejects a non-array or non-positive-integer body', async () => {
    for (const body of [
      {},
      { sourceIds: 'nope' },
      { sourceIds: [d1Id, '2'] },
      { sourceIds: [0] },
      { sourceIds: [1.5] },
    ]) {
      const result = await callPut(body);
      expect(result.status).toBe(400);
    }
  });

  it('rejects an id outside the user’s visible set', async () => {
    const result = await callPut({ sourceIds: [d1Id, 999_999] });
    expect(result.status).toBe(400);
  });

  it('accepts a paused/excluded source (visibility is independent of inclusion)', async () => {
    db.update(sources).set({ enabled: false }).where(eq(sources.id, publicId)).run();
    db.insert(userSourceChoices)
      .values({ userId, sourceId: publicId, included: false })
      .run();
    const result = await callPut({ sourceIds: [publicId, d1Id] });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ sourceIds: [publicId, d1Id] });
  });

  it('round-trips through the real export and clears with []', async () => {
    const put = await callPut({ sourceIds: [publicId, d2Id, d1Id] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ sourceIds: [publicId, d2Id, d1Id] });
    expect(await exportProxyNames()).toEqual([NODE_PUBLIC, NODE_D2, NODE_D1]);

    const cleared = await callPut({ sourceIds: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ sourceIds: [] });
    expect(db.select({ sourceOrder: users.sourceOrder }).from(users).where(eq(users.id, userId)).get()?.sourceOrder).toBeNull();
    expect(await exportProxyNames()).toEqual([NODE_D1, NODE_D2, NODE_PUBLIC]);
  });

  it('admin surface counts the saved order and can clear it only', async () => {
    saveUserSourceOrder(db, userId, [publicId, d2Id]);
    const row = db.select().from(users).where(eq(users.id, userId)).get()!;
    expect(toAdminUser(row).sourceOrderCount).toBe(2);

    const updated = await updateUser(db, userId, { sourceOrder: [] });
    expect(updated.sourceOrderCount).toBe(0);
    expect(db.select({ sourceOrder: users.sourceOrder }).from(users).where(eq(users.id, userId)).get()?.sourceOrder).toBeNull();
  });
});
