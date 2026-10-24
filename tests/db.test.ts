// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { decrypt, DEV_SECRET, encrypt, resetCryptoCache } from '../server/db/crypto';
import Database from 'better-sqlite3';
import { ensureSchema, openDb } from '../server/db';
import { sources, users } from '../server/db/schema';

const TOKEN = 'f'.repeat(32);
const dirs: string[] = [];

afterEach(() => {
  resetCryptoCache();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sqlite schema', () => {
  it('inserts a fake user into a temp file database and looks them up by token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-db-'));
    dirs.push(dir);
    const dbPath = join(dir, 'nested', 'subhub.sqlite');
    const db = openDb({ path: dbPath });
    expect(existsSync(dbPath)).toBe(true);

    db.insert(users)
      .values({
        name: 'fixture-user',
        token: TOKEN,
        enabled: true,
        note: 'test only',
      })
      .run();

    const found = db.select().from(users).where(eq(users.token, TOKEN)).get();
    expect(found).toMatchObject({
      name: 'fixture-user',
      token: TOKEN,
      enabled: true,
      note: 'test only',
    });
    expect(found?.id).toBeTypeOf('number');
    expect(found?.createdAt).toBeInstanceOf(Date);

    expect(db.select().from(users).where(eq(users.token, 'no-such-token')).get()).toBeUndefined();
  });
});

describe('guarded migration: sources.owner_user_id', () => {
  it('adds the column to a pre-existing database and is safe to re-run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-migrate-'));
    dirs.push(dir);
    const dbPath = join(dir, 'legacy.sqlite');

    // A database created by the first release: no owner_user_id anywhere.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        token TEXT NOT NULL,
        profile_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        created_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'remote',
        ua TEXT,
        refresh_minutes INTEGER NOT NULL DEFAULT 60,
        last_ok_at INTEGER,
        last_error TEXT,
        cache_blob TEXT
      );
      INSERT INTO sources (name, url) VALUES ('legacy-source', 'v1:placeholder');
    `);
    legacy.close();

    // openDb runs the guarded ALTER TABLE once; a second open must not throw.
    const first = openDb({ path: dbPath });
    const rows = first.select().from(sources).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ownerUserId).toBeNull();
    first.insert(sources).values({ name: 'owned', url: 'v1:placeholder2', ownerUserId: null }).run();

    const second = openDb({ path: dbPath });
    expect(second.select().from(sources).all()).toHaveLength(2);

    // And directly: ensureSchema on an already migrated handle is a no-op.
    const raw = new Database(dbPath);
    ensureSchema(raw);
    ensureSchema(raw);
    const columns = raw.pragma('table_info(sources)') as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === 'owner_user_id')).toHaveLength(1);
    raw.close();
  });

  it('creates the owner column on a fresh database too', () => {
    const db = openDb({ path: ':memory:' });
    const columns = (db as unknown as { $client: Database.Database }).$client
      .pragma('table_info(sources)') as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'owner_user_id')).toBe(true);
  });
});

describe('guarded migration: sources.access_mode + source_allowed_users', () => {
  function legacyDb(dbPath: string) {
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        token TEXT NOT NULL,
        profile_id INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT,
        created_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'remote',
        ua TEXT,
        refresh_minutes INTEGER NOT NULL DEFAULT 60,
        last_ok_at INTEGER,
        last_error TEXT,
        cache_blob TEXT,
        owner_user_id INTEGER
      );
      INSERT INTO sources (name, url, owner_user_id) VALUES ('legacy-public', 'v1:placeholder', NULL);
    `);
    legacy.close();
  }

  it('creates the json-visible column with the public default on existing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-migrate-access-'));
    dirs.push(dir);
    const dbPath = join(dir, 'legacy.sqlite');
    legacyDb(dbPath);

    const db = openDb({ path: dbPath });
    // Pre-v2 rows keep today's behaviour: public, no allowlist.
    const row = db.select().from(sources).all()[0]!;
    expect(row.accessMode).toBe('all');
    expect(row.ownerUserId).toBeNull();

    // The join table exists and is queryable.
    const raw = new Database(dbPath);
    const table = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_allowed_users'")
      .get() as { name?: string } | undefined;
    expect(table?.name).toBe('source_allowed_users');
    raw.close();

    // Restrictive mode can be written, restored and re-opened idempotently.
    const publicId = db.select().from(sources).all()[0]!.id;
    db.update(sources).set({ accessMode: 'restricted' }).where(eq(sources.id, publicId)).run();
    const again = openDb({ path: dbPath });
    expect(again.select().from(sources).all()[0]!.accessMode).toBe('restricted');

    const handle = new Database(dbPath);
    ensureSchema(handle);
    ensureSchema(handle);
    const columns = handle.pragma('table_info(sources)') as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === 'access_mode')).toHaveLength(1);
    handle.close();
  });

  it('creates the column and the join table on a fresh database', () => {
    const db = openDb({ path: ':memory:' });
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const columns = sqlite.pragma('table_info(sources)') as Array<{ name: string }>;
    const accessMode = columns.find((column) => column.name === 'access_mode');
    expect(accessMode).toBeDefined();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toContain('source_allowed_users');
  });
});

describe('guarded migration: sources.userinfo_* columns', () => {
  const USERINFO_COLUMNS = [
    'userinfo_upload',
    'userinfo_download',
    'userinfo_total',
    'userinfo_expire',
    'userinfo_refreshed_at',
  ];

  it('adds every nullable column to a database from before the feature', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-migrate-userinfo-'));
    dirs.push(dir);
    const dbPath = join(dir, 'legacy.sqlite');

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'remote',
        ua TEXT,
        refresh_minutes INTEGER NOT NULL DEFAULT 60,
        last_ok_at INTEGER,
        last_error TEXT,
        cache_blob TEXT,
        owner_user_id INTEGER,
        access_mode TEXT NOT NULL DEFAULT 'all'
      );
      INSERT INTO sources (name, url) VALUES ('legacy-source', 'v1:placeholder');
    `);
    legacy.close();

    const db = openDb({ path: dbPath });
    // Existing rows read as "no userinfo", never as zeros.
    const row = db.select().from(sources).all()[0]!;
    expect(row).toMatchObject({
      userinfoUpload: null,
      userinfoDownload: null,
      userinfoTotal: null,
      userinfoExpire: null,
      userinfoRefreshedAt: null,
    });

    db.update(sources)
      .set({ userinfoUpload: 1, userinfoExpire: 1_700_000_000, userinfoRefreshedAt: new Date(0) })
      .where(eq(sources.id, row.id))
      .run();
    const reopened = openDb({ path: dbPath });
    expect(reopened.select().from(sources).all()[0]).toMatchObject({
      userinfoUpload: 1,
      userinfoExpire: 1_700_000_000,
    });

    // Idempotent: no duplicate column errors on repeated migrations.
    const handle = new Database(dbPath);
    ensureSchema(handle);
    ensureSchema(handle);
    const columns = handle.pragma('table_info(sources)') as Array<{ name: string }>;
    for (const name of USERINFO_COLUMNS) {
      expect(columns.filter((column) => column.name === name)).toHaveLength(1);
    }
    handle.close();
  });

  it('creates the columns on a fresh database', () => {
    const db = openDb({ path: ':memory:' });
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    const columns = (sqlite.pragma('table_info(sources)') as Array<{ name: string }>).map(
      (column) => column.name,
    );
    for (const name of USERINFO_COLUMNS) expect(columns).toContain(name);
  });
});

describe('source url crypto', () => {
  it('round-trips a placeholder string and does not embed the plaintext', () => {
    const plain = 'placeholder-not-a-subscription';
    const encoded = encrypt(plain, { secret: 'unit-test-secret' });
    expect(encoded.startsWith('v1:')).toBe(true);
    expect(encoded).not.toContain(plain);
    expect(decrypt(encoded, { secret: 'unit-test-secret' })).toBe(plain);
  });

  it('uses the development key only outside production', () => {
    const encoded = encrypt('dev-placeholder', { secret: undefined, nodeEnv: 'test' });
    expect(decrypt(encoded, { secret: DEV_SECRET, nodeEnv: 'test' })).toBe('dev-placeholder');
    expect(() => encrypt('x', { secret: '', nodeEnv: 'production' })).toThrow(/SUBHUB_SECRET/);
  });
});

describe('db robustness', () => {
  it('rejects duplicate tokens and tolerates reopening the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-db-'));
    dirs.push(dir);
    const dbPath = join(dir, 'again.sqlite');
    const first = openDb({ path: dbPath });
    first.insert(users).values({ name: 'a', token: TOKEN }).run();
    expect(() => first.insert(users).values({ name: 'b', token: TOKEN }).run()).toThrow();
    const second = openDb({ path: dbPath });
    expect(second.select().from(users).where(eq(users.token, TOKEN)).get()?.name).toBe('a');
  });
});

describe('crypto tampering', () => {
  it('rejects a modified ciphertext or a wrong key', () => {
    const encoded = encrypt('payload', { secret: 'secret-a' });
    expect(() => decrypt(encoded, { secret: 'secret-b' })).toThrow();
    const tampered = encoded.slice(0, -4) + (encoded.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decrypt(tampered, { secret: 'secret-a' })).toThrow();
  });
});
