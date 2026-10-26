// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Remote rule-list inlining on the real export path: the shipped v2 legacy INI
 * references ~40 remote rulesets, which must become literal rules when their
 * bodies are available. An unavailable body keeps only that provider's remote
 * reference (the old behaviour).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { buildRules, parseIni, type ProxyNode } from '../core';
import { openDb, type SubhubDb } from '../server/db';
import { profiles, users } from '../server/db/schema';
import { loadUserProfile, renderTargetBody } from '../server/utils/export-nodes';

const OPENAI_URL =
  'https://raw.githubusercontent.com/jhxxr/script/main/rule/list/openai.list';
const DIRECT_URL =
  'https://raw.githubusercontent.com/jhxxr/script/main/rule/list/direct.list';
const CLAUDE_URL =
  'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Claude/Claude.list';

const INI = readFileSync(
  fileURLToPath(new URL('./fixtures/xr_all_config_v2_legacy.ini', import.meta.url)),
  'utf8',
);

function nodes(): ProxyNode[] {
  return [
    ...Array.from({ length: 4 }, (_, index) => ({
      type: 'ss' as const,
      name: `🇭🇰 香港 ${String(index + 1).padStart(2, '0')}`,
      server: `hk${index + 1}.example.com`,
      port: 8388,
      cipher: 'aes-128-gcm',
      password: 'fake',
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      type: 'trojan' as const,
      name: `🇯🇵 日本 ${String(index + 1).padStart(2, '0')}`,
      server: `jp${index + 1}.example.com`,
      port: 443,
      password: 'fake',
    })),
  ] as ProxyNode[];
}

function bodyFor(url: string): string {
  if (url === OPENAI_URL) return 'DOMAIN-SUFFIX,openai.com\nDOMAIN-SUFFIX,chatgpt.com';
  if (url === DIRECT_URL) return 'DOMAIN-SUFFIX,msftconnecttest.com,DIRECT';
  return 'DOMAIN-SUFFIX,list.example.com\nDOMAIN,second.example.com';
}

function ok(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}

function failure(): Response {
  return { ok: false, status: 503, text: async () => '' } as Response;
}

const dirs: string[] = [];
let db: SubhubDb;
let userId: number;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'subhub-inline-rules-'));
  dirs.push(dir);
  db = openDb({ path: join(dir, 'subhub.sqlite') });
  const profileId = db
    .insert(profiles)
    .values({ name: 'v2-legacy', iniText: INI })
    .returning({ id: profiles.id })
    .get()!.id;
  userId = db
    .insert(users)
    .values({ name: 'inline-user', token: 'i'.repeat(32), enabled: true, profileId })
    .returning({ id: users.id })
    .get()!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stubFetch(failUrl?: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const value = String(url);
    if (failUrl && value === failUrl) return failure();
    return ok(bodyFor(value));
  });
}

async function renderInlined() {
  const list = nodes();
  const loaded = await loadUserProfile(db, userId, 'mihomo', list, async () => INI);
  expect(loaded).not.toBeNull();
  const body = renderTargetBody('mihomo', loaded!.nodes, {}, loaded!.profile);
  return { loaded: loaded!, body, document: parseYaml(body) as Record<string, unknown> };
}

describe('rule-list inlining on loadUserProfile', () => {
  it('expands every list and drops the whole rule-providers section', async () => {
    stubFetch();
    const list = nodes();
    const built = buildRules(parseIni(INI), {
      target: 'mihomo',
      nodeNames: list.map((node) => node.name),
    });

    const { loaded, document } = await renderInlined();
    const rules = document.rules as string[];

    expect(document['rule-providers']).toBeUndefined();
    expect(loaded.profile.ruleProviders).toEqual({});
    expect(loaded.ruleProviderNames.length).toBeGreaterThan(30);
    expect(rules).toContain('DOMAIN-SUFFIX,openai.com,💬 Ai平台');
    expect(rules).toContain('DOMAIN-SUFFIX,chatgpt.com,💬 Ai平台');
    expect(rules).toContain('DOMAIN-SUFFIX,msftconnecttest.com,DIRECT');
    expect(loaded.profile.rules.length).toBeGreaterThan(built.rules.length);
  });

  it('keeps only the unavailable provider and its RULE-SET line', async () => {
    stubFetch(CLAUDE_URL);
    const { loaded, document } = await renderInlined();

    const providers = document['rule-providers'] as Record<string, { url: string }>;
    expect(Object.keys(providers)).toHaveLength(1);
    const entry = Object.entries(providers)[0]!;
    expect(entry[1].url).toBe(CLAUDE_URL);
    expect(document.rules).toContain(`RULE-SET,${entry[0]},💬 Ai平台`);
    expect(document.rules).toContain('DOMAIN-SUFFIX,openai.com,💬 Ai平台');
    expect(loaded.profile.ruleProviders).toEqual({ [entry[0]]: providers[entry[0]] });
    expect(loaded.ruleProviderNames).toContain(entry[0]);
  });
});
