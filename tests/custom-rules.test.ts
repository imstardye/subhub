// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user custom rules: pure core coverage (parse / validate / merge) plus
 * export-level checks through `/s/:token/:target` and the shared save path
 * (`saveUserCustomRules`, used by both the user center and the admin API).
 *
 * The invariants that matter:
 * - prepend lands ahead of the profile rules (behind the built-in QUIC
 *   rule, which the producer always renders first);
 * - append lands after the profile rules but BEFORE the final MATCH;
 * - a rule whose policy does not resolve for the render at hand is dropped
 *   at export time (never a dangling policy — mihomo rejects those whole);
 * - saving validates against the assigned profile and refuses bad lines
 *   with per-line messages; a profile-less user cannot save rules yet.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  CUSTOM_RULES_EXAMPLE_TEXT,
  filterCustomRulesForExport,
  mergeCustomRules,
  parseCustomRulePosition,
  parseCustomRules,
  validateCustomRulePolicies,
} from '../core';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, sources, users } from '../server/db/schema';
import { encrypt } from '../server/db/crypto';
import { handleSubscriptionExport, resetExportRateLimiter } from '../server/utils/subscription';
import { saveUserCustomRules } from '../server/utils/custom-rules';
import { updateUser } from '../server/utils/admin-users';

const TOKEN = 'c'.repeat(32);
const QUIC = 'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT';
const GROUP = '🚀 节点选择';

const PROFILE_INI = [
  '[custom]',
  `custom_proxy_group=${GROUP}\`select\`.*`,
  `ruleset=${GROUP},[]DOMAIN-SUFFIX,profile.com`,
  `ruleset=${GROUP},[]MATCH`,
].join('\n');

const OTHER_INI = [
  '[custom]',
  'custom_proxy_group=🔰 其他组`select`.*',
  'ruleset=🔰 其他组,[]MATCH',
].join('\n');

const SOURCE = [
  'proxies:',
  '  - {name: "🇭🇰 香港 01", type: ss, server: hk.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '  - {name: "🇯🇵 日本 02", type: ss, server: jp.example.com, port: 8388, cipher: aes-128-gcm, password: "fake"}',
  '',
].join('\n');

describe('custom rules: parsing', () => {
  it('the editor examples are all comments, and each works once uncommented', () => {
    const asShipped = parseCustomRules(CUSTOM_RULES_EXAMPLE_TEXT);
    expect(asShipped.errors).toEqual([]);
    expect(asShipped.entries).toEqual([]);
    const uncommented = CUSTOM_RULES_EXAMPLE_TEXT.split('\n')
      .filter((line) => line.startsWith('# ') && line.includes(','))
      .map((line) => line.slice(2))
      .join('\n');
    const parsed = parseCustomRules(uncommented);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(5);
  });

  it('skips blanks/comments and normalizes the type (incl. FINAL -> MATCH)', () => {
    const parsed = parseCustomRules(
      ['# 注释', '', 'domain-suffix,Example.com,DIRECT', 'FINAL,REJECT', '  DOMAIN-KEYWORD,ads,REJECT  '].join('\n'),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.map((entry) => entry.rule)).toEqual([
      'DOMAIN-SUFFIX,Example.com,DIRECT',
      'MATCH,REJECT',
      'DOMAIN-KEYWORD,ads,REJECT',
    ]);
    // Original line numbers survive for error messages.
    expect(parsed.entries.map((entry) => entry.line)).toEqual([3, 4, 5]);
  });

  it('reports per-line syntax errors and keeps the good lines', () => {
    const parsed = parseCustomRules(
      ['DOMAIN-SUFFIX,ok.com,DIRECT', 'WTAF,x,DIRECT', 'DOMAIN-ONLY', 'MATCH'].join('\n'),
    );
    expect(parsed.entries.map((entry) => entry.rule)).toEqual(['DOMAIN-SUFFIX,ok.com,DIRECT']);
    expect(parsed.errors.map((error) => error.line)).toEqual([2, 3, 4]);
    expect(parsed.errors[0]!.message).toContain('不支持的规则类型');
  });

  it('accepts logic rules and port/ip forms', () => {
    const parsed = parseCustomRules(
      ['AND,((NETWORK,UDP),(DST-PORT,443)),REJECT', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'DST-PORT,8443,REJECT'].join('\n'),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(3);
  });

  it('enforces the count and length caps', () => {
    const many = Array.from({ length: 201 }, (_, i) => `DOMAIN-SUFFIX,d${i}.com,DIRECT`).join('\n');
    const parsed = parseCustomRules(many);
    expect(parsed.entries).toHaveLength(200);
    expect(parsed.errors.at(-1)?.message).toContain('200');
    const long = parseCustomRules(`DOMAIN-SUFFIX,${'a'.repeat(600)}.com,DIRECT`);
    expect(long.entries).toEqual([]);
    expect(long.errors[0]?.message).toContain('512');
  });

  it('parses the position strictly', () => {
    expect(parseCustomRulePosition(undefined)).toBe('prepend');
    expect(parseCustomRulePosition('append')).toBe('append');
    expect(parseCustomRulePosition('middle')).toBeNull();
    expect(parseCustomRulePosition(42)).toBeNull();
  });
});

describe('custom rules: policy validation', () => {
  const allowed = new Set([GROUP, '🇭🇰 香港 01', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']);
  const providers = new Set(['profile-rules']);

  it('accepts group, node and built-in policies', () => {
    const { entries } = parseCustomRules(
      [`DOMAIN-SUFFIX,a.com,${GROUP}`, 'DOMAIN,b.com,🇭🇰 香港 01', 'MATCH,DIRECT', 'RULE-SET,profile-rules,REJECT'].join('\n'),
    );
    expect(validateCustomRulePolicies(entries, allowed, providers)).toEqual([]);
  });

  it('rejects unknown policies and unknown rule-sets with line numbers', () => {
    const { entries } = parseCustomRules(
      ['DOMAIN-SUFFIX,a.com,不存在的组', 'RULE-SET,ghost,DIRECT'].join('\n'),
    );
    const errors = validateCustomRulePolicies(entries, allowed, providers);
    expect(errors.map((error) => error.line)).toEqual([1, 2]);
    expect(errors[0]!.message).toContain('不存在的组');
    expect(errors[1]!.message).toContain('ghost');
  });
});

describe('custom rules: export filter + merge', () => {
  it('drops rules whose policy or provider is not alive for this render', () => {
    const kept = filterCustomRulesForExport(
      ['DOMAIN-SUFFIX,a.com,DIRECT', 'DOMAIN-SUFFIX,b.com,已删分组', 'RULE-SET,ghost,DIRECT', 'RULE-SET,profile-rules,REJECT'],
      new Set(['DIRECT', 'REJECT']),
      new Set(['profile-rules']),
    );
    expect(kept).toEqual(['DOMAIN-SUFFIX,a.com,DIRECT', 'RULE-SET,profile-rules,REJECT']);
  });

  it('prepend puts custom rules ahead of the profile rules', () => {
    expect(mergeCustomRules(['DOMAIN-SUFFIX,p.com,G', 'MATCH,G'], ['DOMAIN-SUFFIX,c.com,DIRECT'], 'prepend')).toEqual([
      'DOMAIN-SUFFIX,c.com,DIRECT',
      'DOMAIN-SUFFIX,p.com,G',
      'MATCH,G',
    ]);
  });

  it('append inserts before the final MATCH (a rule after MATCH never matches)', () => {
    expect(mergeCustomRules(['DOMAIN-SUFFIX,p.com,G', 'MATCH,G'], ['DOMAIN-SUFFIX,c.com,DIRECT'], 'append')).toEqual([
      'DOMAIN-SUFFIX,p.com,G',
      'DOMAIN-SUFFIX,c.com,DIRECT',
      'MATCH,G',
    ]);
  });

  it('append without a MATCH goes last; empty custom rules change nothing', () => {
    const profile = ['DOMAIN-SUFFIX,p.com,G'];
    expect(mergeCustomRules(profile, ['DOMAIN-SUFFIX,c.com,DIRECT'], 'append')).toEqual([
      'DOMAIN-SUFFIX,p.com,G',
      'DOMAIN-SUFFIX,c.com,DIRECT',
    ]);
    expect(mergeCustomRules(profile, [], 'append')).toBe(profile);
  });
});

describe('custom rules: export integration', () => {
  const dirs: string[] = [];
  let db: SubhubDb;
  let userId: number;

  beforeEach(() => {
    resetExportRateLimiter();
    const dir = mkdtempSync(join(tmpdir(), 'subhub-crules-'));
    dirs.push(dir);
    db = openDb({ path: join(dir, 'subhub.sqlite') });
    userId = db
      .insert(users)
      .values({ name: 'rules-user', token: TOKEN, enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    const profile = db
      .insert(profiles)
      .values({ name: 'main', iniText: PROFILE_INI })
      .returning({ id: profiles.id })
      .get()!;
    db.insert(profiles).values({ name: 'other', iniText: OTHER_INI }).run();
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();
    db.insert(sources)
      .values({
        name: 'public-source',
        url: encrypt('placeholder-source-not-a-real-subscription'),
        type: 'local',
        cacheBlob: SOURCE,
        ownerUserId: null,
        accessMode: 'all',
      })
      .run();
  });

  afterEach(() => {
    resetExportRateLimiter();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function exportRules(target = 'mihomo', profile?: string) {
    resetExportRateLimiter();
    const response = await handleSubscriptionExport(
      { token: TOKEN, target, userAgent: 'clash-verge/v2.0', ip: '127.0.0.1', ...(profile ? { profile } : {}) },
      { db, resolveProfileIni: async (row) => row.iniText },
    );
    expect(response.status).toBe(200);
    return response;
  }

  function setRules(text: string | null, position?: string) {
    db.update(users)
      .set({ customRules: text, customRulesPosition: position ?? null })
      .where(eq(users.id, userId))
      .run();
  }

  it('prepend: custom rules sit behind QUIC and ahead of the profile rules', async () => {
    setRules(`DOMAIN-SUFFIX,custom.com,${GROUP}\nDOMAIN-KEYWORD,ads,REJECT`);
    const response = await exportRules();
    const document = parseYaml(response.body) as { rules: string[] };
    expect(document.rules).toEqual([
      QUIC,
      `DOMAIN-SUFFIX,custom.com,${GROUP}`,
      'DOMAIN-KEYWORD,ads,REJECT',
      `DOMAIN-SUFFIX,profile.com,${GROUP}`,
      `MATCH,${GROUP}`,
    ]);
  });

  it('append: custom rules land after the profile rules, before MATCH', async () => {
    setRules('DOMAIN-SUFFIX,custom.com,DIRECT', 'append');
    const response = await exportRules();
    const document = parseYaml(response.body) as { rules: string[] };
    expect(document.rules).toEqual([
      QUIC,
      `DOMAIN-SUFFIX,profile.com,${GROUP}`,
      'DOMAIN-SUFFIX,custom.com,DIRECT',
      `MATCH,${GROUP}`,
    ]);
  });

  it('drops custom rules whose policy died with the render (no dangling policy)', async () => {
    setRules(`DOMAIN-SUFFIX,dead.com,不存在的组\nDOMAIN-SUFFIX,live.com,DIRECT\nRULE-SET,ghost,DIRECT`);
    const response = await exportRules();
    const document = parseYaml(response.body) as { rules: string[] };
    expect(document.rules).toContain('DOMAIN-SUFFIX,live.com,DIRECT');
    expect(document.rules.join('\n')).not.toContain('dead.com');
    expect(document.rules.join('\n')).not.toContain('ghost');
  });

  it('follows the per-request profile: policies of the other profile drop out', async () => {
    setRules(`DOMAIN-SUFFIX,custom.com,${GROUP}\nDOMAIN-SUFFIX,any.com,DIRECT`);
    const response = await exportRules('mihomo', 'other');
    const document = parseYaml(response.body) as { rules: string[] };
    // 🚀 节点选择 does not exist under `other`; the DIRECT rule survives.
    expect(document.rules).toEqual([QUIC, 'DOMAIN-SUFFIX,any.com,DIRECT', 'MATCH,🔰 其他组']);
  });

  it('leaves the node-only targets untouched', async () => {
    setRules('DOMAIN-SUFFIX,custom.com,DIRECT');
    const singbox = await exportRules('singbox');
    expect(singbox.body).not.toContain('custom.com');
    const surge = await exportRules('surge');
    expect(surge.body).not.toContain('custom.com');
  });

  it('no custom rules: the export is exactly the profile output', async () => {
    const response = await exportRules();
    const document = parseYaml(response.body) as { rules: string[] };
    expect(document.rules).toEqual([QUIC, `DOMAIN-SUFFIX,profile.com,${GROUP}`, `MATCH,${GROUP}`]);
  });
});

describe('custom rules: the shared save path', () => {
  const dirs: string[] = [];
  let db: SubhubDb;
  let userId: number;
  let plainId: number;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'subhub-crules-save-'));
    dirs.push(dir);
    db = openDb({ path: join(dir, 'subhub.sqlite') });
    userId = db
      .insert(users)
      .values({ name: 'saver', token: 'd'.repeat(32), enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    plainId = db
      .insert(users)
      .values({ name: 'plain', token: 'e'.repeat(32), enabled: true })
      .returning({ id: users.id })
      .get()!.id;
    const profile = db
      .insert(profiles)
      .values({ name: 'main', iniText: PROFILE_INI })
      .returning({ id: profiles.id })
      .get()!;
    db.update(users).set({ profileId: profile.id }).where(eq(users.id, userId)).run();
    db.insert(sources)
      .values({
        name: 'public-source',
        url: encrypt('placeholder-source-not-a-real-subscription'),
        type: 'local',
        cacheBlob: SOURCE,
        ownerUserId: null,
        accessMode: 'all',
      })
      .run();
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('saves normalized rules and reports them back', async () => {
    const saved = await saveUserCustomRules(
      db,
      userId,
      `domain-suffix,custom.com,${GROUP}\n# 注释\nDOMAIN-KEYWORD,ads,REJECT`,
      'append',
    );
    expect(saved).toEqual({
      text: `DOMAIN-SUFFIX,custom.com,${GROUP}\nDOMAIN-KEYWORD,ads,REJECT`,
      position: 'append',
      count: 2,
    });
    const row = db.select().from(users).where(eq(users.id, userId)).get()!;
    expect(row.customRules).toBe(saved.text);
    expect(row.customRulesPosition).toBe('append');
  });

  it('rejects bad syntax and unknown policies with line numbers, writing nothing', async () => {
    await expect(saveUserCustomRules(db, userId, 'WTAF,x,DIRECT')).rejects.toThrow(/第 1 行/);
    await expect(saveUserCustomRules(db, userId, 'DOMAIN-SUFFIX,a.com,没有这组')).rejects.toThrow(
      /没有这组/,
    );
    const row = db.select().from(users).where(eq(users.id, userId)).get()!;
    expect(row.customRules).toBeNull();
  });

  it('a profile-less user cannot save rules, but can always clear them', async () => {
    await expect(saveUserCustomRules(db, plainId, 'DOMAIN-SUFFIX,a.com,DIRECT')).rejects.toThrow(
      /尚未分配规则档/,
    );
    const cleared = await saveUserCustomRules(db, plainId, '');
    expect(cleared).toEqual({ text: '', position: 'prepend', count: 0 });
  });

  it('the admin update path shares the same validation', async () => {
    const item = await updateUser(db, userId, {
      customRules: 'DOMAIN-SUFFIX,admin.com,DIRECT',
      customRulesPosition: 'prepend',
    });
    expect(item.customRules).toBe('DOMAIN-SUFFIX,admin.com,DIRECT');
    expect(item.customRulesPosition).toBe('prepend');
    await expect(
      updateUser(db, userId, { customRules: 'DOMAIN-SUFFIX,admin.com,没有这组' }),
    ).rejects.toThrow(/没有这组/);
  });
});
