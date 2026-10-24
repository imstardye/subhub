// SPDX-License-Identifier: AGPL-3.0-only
/**
 * subconverter-style INI parsing and Clash rule generation.
 *
 * The rule/group model follows the public subconverter INI convention used by
 * Sub-Store profile imports. This implementation is original but shares the
 * output conventions of Sub-Store's Clash rule producers:
 * (https://github.com/sub-store-org/Sub-Store), AGPL-3.0.
 * See the repository LICENSE file.
 */

import type {
  BuiltRules,
  ClashProxyGroup,
  ClashRuleProvider,
  ProxyGroupEntry,
  ProxyGroupMember,
  RulesetEntry,
  SubconverterIni,
} from '../types';
import { parse as parseYaml } from 'yaml';

const MAX_YAML_ALIAS_COUNT = 100;

/** Guard against absurdly large user-supplied group regexes. */
const MAX_GROUP_REGEX_LENGTH = 256;

/** Rule options that may trail a classical rule line. */
const RULE_TRAILING_OPTIONS = new Set([
  'no-resolve',
  'src',
  'dport',
  'src-port',
  'dst-port',
  'extended-matching',
]);

const BUILTIN_RULE_TARGETS = new Set([
  'DIRECT',
  'REJECT',
  'REJECT-DROP',
  'PASS',
]);

/** Rule types a legacy Clash kernel can load. */
const LEGACY_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'IP-CIDR',
  'IP-CIDR6',
  'GEOIP',
  'SRC-IP-CIDR',
  'SRC-PORT',
  'DST-PORT',
  'MATCH',
]);

interface ParsedRuleLine {
  type: string;
  content: string;
  options: string[];
  target?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitFirstComma(value: string): [string, string] {
  const index = value.indexOf(',');
  if (index === -1) return [value.trim(), ''];
  return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
}

/**
 * Split a rule line without breaking comma-containing content such as
 * `DOMAIN-REGEX,^a.{0,61}$`. Only the type, trailing known options and an
 * optional policy target are separated from the content.
 */
function parseRuleLine(line: string): ParsedRuleLine | null {
  const firstComma = line.indexOf(',');
  const rawType = (firstComma === -1 ? line : line.slice(0, firstComma)).trim();
  if (!rawType) return null;

  let rest = firstComma === -1 ? '' : line.slice(firstComma + 1);
  const options: string[] = [];

  while (rest) {
    const lastComma = rest.lastIndexOf(',');
    if (lastComma === -1) break;

    const tail = rest.slice(lastComma + 1).trim();
    if (!RULE_TRAILING_OPTIONS.has(tail.toLowerCase())) break;

    options.unshift(tail);
    rest = rest.slice(0, lastComma);
  }

  // After trailing options are removed, a classical rule is `TYPE,payload`
  // or `TYPE,payload,policy`. Peel the last segment only when it is a known
  // policy (the assigned group, or a built-in target) so comma-containing
  // payloads such as `^a.{0,61}$` stay intact.
  let sourceTarget: string | undefined;
  const mappedType = mapRuleType(rawType);
  if (mappedType !== 'MATCH' && mappedType !== 'FINAL') {
    const lastComma = rest.lastIndexOf(',');
    if (lastComma !== -1) {
      const tail = rest.slice(lastComma + 1).trim();
      const payload = rest.slice(0, lastComma).trim();
      // A policy is a single token (group name or DIRECT/REJECT/…).
      // Comma-containing payloads such as `^a.{0,61}$` do not match.
      if (tail && payload && /^[\w][\w .+-]*$/.test(tail)) {
        sourceTarget = tail;
        rest = rest.slice(0, lastComma);
      }
    }
  }

  return {
    type: mappedType,
    content: rest.trim(),
    options,
    ...(sourceTarget ? { target: sourceTarget } : {}),
  };
}

function parseRuleset(raw: string): RulesetEntry {
  const [group, source] = splitFirstComma(raw);
  const entry: RulesetEntry = {
    group,
    source,
    kind: 'unknown',
    raw,
  };

  if (!source) return entry;

  if (source.startsWith('[]')) {
    const body = source.slice(2);
    const parsed = parseRuleLine(body);
    entry.sourceTarget = parsed?.target;
    entry.kind = 'inline';
    entry.inlineType = parsed?.type ?? '';
    entry.inlineValue = parsed
      ? [...(parsed.content ? [parsed.content] : []), ...parsed.options]
      : [];
    return entry;
  }

  if (/^https?:\/\//i.test(source)) {
    entry.kind = 'url';
  }

  return entry;
}

function unwrapOuterParens(pattern: string): string {
  if (!pattern.startsWith('(') || !pattern.endsWith(')')) return pattern;

  let depth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0 && index !== pattern.length - 1) return pattern;
    }
  }

  return depth === 0 ? pattern.slice(1, -1) : pattern;
}

export interface CompiledMemberRegex {
  source: string;
  flags: string;
}

export function compileGroupRegex(pattern: string): CompiledMemberRegex {
  let source = unwrapOuterParens(pattern.trim());
  let flags = '';
  if (source.includes('(?i)')) {
    source = source.replace(/\(\?i\)/g, '');
    flags = 'i';
  }
  return { source, flags };
}

function parseMember(raw: string): ProxyGroupMember | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith('[]')) {
    return { kind: 'ref', name: value.slice(2).trim() };
  }

  return { kind: 'regex', pattern: value };
}

function isHealthCheckUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function parseGroup(raw: string): ProxyGroupEntry | null {
  const parts = raw.split('`').map((part) => part.trim());
  if (!parts[0]) return null;

  const name = parts[0];
  const type = (parts[1] || 'select').toLowerCase();
  const optionTokens = parts.slice(2);

  let memberTokens = optionTokens;
  let url: string | undefined;
  let interval: number | undefined;
  let tolerance: number | undefined;
  let timeout: number | undefined;
  let lazy: boolean | undefined;

  if (['url-test', 'fallback', 'load-balance', 'relay'].includes(type)) {
    const urlIndex = optionTokens.findIndex(isHealthCheckUrl);
    if (urlIndex !== -1) {
      url = optionTokens[urlIndex];
      memberTokens = optionTokens.slice(0, urlIndex);
      const fields = optionTokens.slice(urlIndex + 1);
      // subconverter writes health-check values either as separate backtick
      // tokens or as one comma-separated token such as `300,,50`.
      const healthFields = fields
        .flatMap((field) => field.split(','))
        .map((field) => field.trim());

      const intervalField = healthFields[0];
      if (intervalField && /^\d+$/.test(intervalField)) {
        interval = Number.parseInt(intervalField, 10);
      }

      const afterInterval = healthFields.slice(1);
      const toleranceField =
        afterInterval.length >= 2
          ? afterInterval[afterInterval.length - 1]
          : afterInterval.find(Boolean);
      if (toleranceField && /^\d+$/.test(toleranceField)) {
        tolerance = Number.parseInt(toleranceField, 10);
      }

      for (const field of fields) {
        if (/^timeout\s*=/i.test(field)) {
          const value = Number.parseInt(field.split('=')[1] ?? '', 10);
          if (Number.isFinite(value)) timeout = value;
        }
        if (/^lazy\s*=/i.test(field)) {
          lazy = /=\s*(true|1|yes)/i.test(field);
        }
      }
    }
  }

  const members = memberTokens
    .map(parseMember)
    .filter((member): member is ProxyGroupMember => member !== null);

  return {
    name,
    type,
    rawOptions: optionTokens,
    members,
    ...(url ? { url } : {}),
    ...(interval !== undefined ? { interval } : {}),
    ...(tolerance !== undefined ? { tolerance } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(lazy !== undefined ? { lazy } : {}),
    raw,
  };
}

/**
 * Parse a subconverter INI. Both `[common]` and `[custom]` sections are read;
 * multi-value `ruleset=` / `custom_proxy_group=` entries are returned as
 * structured arrays while other keys are exposed as strings.
 */
export function parseIni(raw: string): SubconverterIni {
  const result: SubconverterIni = {
    common: {},
    custom: {},
    rulesets: [],
    groups: [],
  };

  let section = '';
  for (const rawLine of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;

    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim().toLowerCase();
    const value = unquote(line.slice(equalsIndex + 1));

    if (key === 'ruleset') {
      result.rulesets.push(parseRuleset(value));
      continue;
    }

    if (key === 'custom_proxy_group') {
      const group = parseGroup(value);
      if (group) result.groups.push(group);
      continue;
    }

    if (section === 'common') result.common[key] = value;
    else if (section === 'custom') result.custom[key] = value;
  }

  return result;
}

export interface BuildProxyGroupsOptions {
  /** Node names used to expand regex group members. */
  nodeNames?: string[];
}

const BUILTIN_OUTBOUNDS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']);

export interface ResolveGroupResult {
  proxies: string[];
  unresolved: string[];
}

/**
 * Expand a single group's members against node names. References to built-in
 * outbounds and other proxy groups are preserved. Regex members are matched
 * case-insensitively when the subconverter `(?i)` modifier is present.
 */
export function resolveGroupMembers(
  group: ProxyGroupEntry,
  nodeNames: string[],
  knownGroupNames: Set<string> = new Set(),
): ResolveGroupResult {
  const proxies: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  const append = (name: string) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    proxies.push(name);
  };

  for (const member of group.members) {
    if (member.kind === 'ref' || member.kind === 'builtin') {
      const name = member.name;
      if (
        member.kind === 'builtin' ||
        BUILTIN_OUTBOUNDS.has(name.toUpperCase()) ||
        knownGroupNames.has(name) ||
        nodeNames.includes(name)
      ) {
        append(name);
      } else {
        unresolved.push(name);
        append(name);
      }
      continue;
    }

    const { source, flags } = compileGroupRegex(member.pattern);
    if (source.length > MAX_GROUP_REGEX_LENGTH) {
      unresolved.push(member.pattern);
      continue;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(source, flags);
    } catch {
      unresolved.push(member.pattern);
      continue;
    }

    for (const nodeName of nodeNames) {
      if (regex.test(nodeName)) append(nodeName);
    }
  }

  return { proxies, unresolved };
}

export function buildProxyGroups(
  ini: SubconverterIni,
  options: BuildProxyGroupsOptions = {},
): ClashProxyGroup[] {
  const nodeNames = options.nodeNames ?? [];
  const knownGroupNames = new Set(ini.groups.map((group) => group.name));

  return ini.groups.map((group) => {
    const { proxies } = resolveGroupMembers(group, nodeNames, knownGroupNames);
    return {
      name: group.name,
      type: group.type,
      proxies,
      ...(group.url ? { url: group.url } : {}),
      ...(group.interval !== undefined ? { interval: group.interval } : {}),
      ...(group.tolerance !== undefined ? { tolerance: group.tolerance } : {}),
      ...(group.timeout !== undefined ? { timeout: group.timeout } : {}),
      ...(group.lazy !== undefined ? { lazy: group.lazy } : {}),
    };
  });
}

function mapRuleType(type: string): string {
  const upper = type.toUpperCase();
  const mapping: Record<string, string> = {
    'DEST-PORT': 'DST-PORT',
    'SRC-IP': 'SRC-IP-CIDR',
    'IN-PORT': 'SRC-PORT',
  };
  return mapping[upper] ?? upper;
}

function inlineRuleToClash(entry: RulesetEntry, target: 'mihomo' | 'legacy'): string | null {
  const type = (entry.inlineType ?? '').toUpperCase();
  const values = entry.inlineValue ?? [];

  if (type === 'FINAL' || type === 'MATCH') {
    return `MATCH,${entry.group}`;
  }
  if (!type) return null;

  const normalizedType = mapRuleType(type);
  if (target === 'legacy' && !LEGACY_RULE_TYPES.has(normalizedType)) {
    return null;
  }

  const content = values[0] ?? '';
  const options = values.slice(1);
  // Keep a policy already present on the inline rule instead of appending
  // the ruleset group as a second one.
  const policy = entry.sourceTarget ?? entry.group;
  const parts = [normalizedType, content, policy, ...options].filter(Boolean);
  return parts.join(',');
}

/**
 * Parse a classical Clash rule list (plain lines or a YAML `payload:` list)
 * into rules pointing at `group`.
 */
export interface ExpandedRuleList {
  rules: string[];
  skipped: string[];
}

function expandRuleListDetailed(
  content: string,
  group: string,
  target: 'mihomo' | 'legacy',
): ExpandedRuleList {
  const lines: string[] = [];
  const trimmed = content.trim();

  if (!trimmed) return { rules: [], skipped: [] };

  if (/(^|\n)\s*payload\s*:/.test(trimmed)) {
    try {
      const document = parseYaml(trimmed, {
        maxAliasCount: MAX_YAML_ALIAS_COUNT,
      }) as { payload?: unknown };
      if (Array.isArray(document.payload)) {
        for (const item of document.payload) {
          if (typeof item === 'string') lines.push(item);
        }
      }
    } catch {
      return { rules: [], skipped: [] };
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#') || value.startsWith(';')) continue;
      lines.push(value);
    }
  }

  const rules: string[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const parsed = parseRuleLine(line);
    if (!parsed) continue;

    if (parsed.type === 'MATCH' || parsed.type === 'FINAL') {
      rules.push(`MATCH,${group}`);
      continue;
    }

    if (target === 'legacy' && !LEGACY_RULE_TYPES.has(parsed.type)) {
      skipped.push(line);
      continue;
    }

    // A rule that already names a policy keeps it. Appending `group`
    // would emit a second policy (DOMAIN,example.com,OLD,NEW).
    const policy = parsed.target ?? group;
    const parts = [parsed.type, parsed.content, policy, ...parsed.options]
      .filter(Boolean);
    rules.push(parts.join(','));
  }

  return { rules, skipped };
}

/**
 * Parse a classical Clash rule list (plain lines or a YAML `payload:` list)
 * into rules pointing at `group`. Comma-containing content is preserved.
 */
export function expandRuleList(
  content: string,
  group: string,
  target: 'mihomo' | 'legacy' = 'mihomo',
): string[] {
  return expandRuleListDetailed(content, group, target).rules;
}

export interface BuildRulesOptions extends BuildProxyGroupsOptions {
  target?: 'mihomo' | 'legacy';
  /** Fetch/cache resolver. When provided, URL rulesets are expanded inline. */
  expandRemote?: (url: string) => string | undefined;
  /** rule-provider refresh interval in seconds. */
  providerInterval?: number;
  /** Prefix for generated provider names. */
  providerPrefix?: string;
}

export interface BuiltRulesResult extends BuiltRules {
  /** Rulesets that were skipped because the target does not support them. */
  skipped: RulesetEntry[];
}

/**
 * Build rule-providers, rules and proxy-groups for a target kernel.
 *
 * Without `expandRemote`, URL rulesets become mihomo/Clash `rule-providers`
 * entries and rules reference them with `RULE-SET`. With `expandRemote`, the
 * returned rule list contains the expanded rules instead.
 */
export function buildRules(
  ini: SubconverterIni,
  options: BuildRulesOptions = {},
): BuiltRulesResult {
  const target = options.target ?? 'mihomo';
  const prefix = options.providerPrefix ?? 'rs';
  const interval = options.providerInterval ?? 86400;
  const ruleProviders: Record<string, ClashRuleProvider> = {};
  const providerByUrl = new Map<string, string>();
  const rules: string[] = [];
  const skipped: RulesetEntry[] = [];

  for (const entry of ini.rulesets) {
    if (entry.kind === 'inline') {
      const rule = inlineRuleToClash(entry, target);
      if (rule) rules.push(rule);
      else skipped.push(entry);
      continue;
    }

    if (entry.kind !== 'url') {
      skipped.push(entry);
      continue;
    }

    if (target === 'legacy') {
      // Legacy Clash cannot consume rule-providers, so ruleset contents must be
      // expanded inline. Without a resolver there is nothing safe to emit.
      const content = options.expandRemote?.(entry.source);
      if (content === undefined) {
        skipped.push(entry);
        continue;
      }
      const expanded = expandRuleListDetailed(content, entry.group, 'legacy');
      rules.push(...expanded.rules);
      if (expanded.skipped.length > 0) skipped.push(entry);
      continue;
    }

    if (options.expandRemote) {
      const content = options.expandRemote(entry.source);
      if (content !== undefined) {
        rules.push(...expandRuleList(content, entry.group, 'mihomo'));
        continue;
      }
    }

    let providerName = providerByUrl.get(entry.source);
    if (!providerName) {
      providerName = `${prefix}_${providerByUrl.size + 1}`;
      providerByUrl.set(entry.source, providerName);
      ruleProviders[providerName] = {
        type: 'http',
        behavior: 'classical',
        url: entry.source,
        path: `./ruleset/${providerName}.list`,
        interval,
      };
    }

    rules.push(`RULE-SET,${providerName},${entry.group}`);
  }

  return {
    ruleProviders,
    rules,
    proxyGroups: buildProxyGroups(ini, options),
    skipped,
  };
}
