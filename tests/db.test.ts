// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { decrypt, DEV_SECRET, encrypt, resetCryptoCache } from '../server/db/crypto';
import { openDb } from '../server/db';
import { users } from '../server/db/schema';

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
