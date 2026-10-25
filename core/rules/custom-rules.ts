// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user custom Clash rules (user center feature).
 *
 * A user can attach their own rule lines to their subscription, in the
 * spirit of Clash Verge's `prepend-rules` / `append-rules`: the lines are
 * plain classical Clash rules (`TYPE,payload,policy[,options]`), merged
 * into the profile's rule list when a mihomo/clash export renders.
 *
 * Two defences keep one bad line from breaking the whole config (mihomo
 * rejects the entire document over a dangling policy):
 *
 *  1. Save time (`parseCustomRules` + `validateCustomRulePolicies`):
 *     syntax is checked line by line and every policy must resolve to a
 *     group of the user's profile, an emitted node, or a built-in.
 *  2. Export time (`filterCustomRulesForExport`): the same resolution is
 *     re-checked against the groups that actually survived pruning for
 *     *this* render (a different profile may be selected per request), and
 *     unresolvable lines are dropped silently.
 *
 * Policy extraction reuses `rulePolicy` from the prune module so "what is
 * this rule's policy" has exactly one definition in the codebase.
 */
import { BUILTIN_GROUP_MEMBERS, rulePolicy } from './prune-groups';

export type CustomRulePosition = 'prepend' | 'append';

export const CUSTOM_RULE_MAX_COUNT = 200;
export const CUSTOM_RULE_MAX_LENGTH = 512;

/** Rule types a user may write (mihomo's classical set, minus SUB-RULE). */
export const CUSTOM_RULE_TYPES = new Set([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'GEOIP',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'IP-ASN',
  'SRC-IP-CIDR',
  'SRC-IP-ASN',
  'SRC-GEOIP',
  'SRC-PORT',
  'DST-PORT',
  'IN-PORT',
  'IN-TYPE',
  'IN-NAME',
  'PROCESS-NAME',
  'PROCESS-NAME-REGEX',
  'PROCESS-PATH',
  'PROCESS-PATH-REGEX',
  'NETWORK',
  'RULE-SET',
  'AND',
  'OR',
  'NOT',
  'MATCH',
]);

const LOGIC_TYPES = new Set(['AND', 'OR', 'NOT']);

export interface CustomRuleEntry {
  /** 1-based line number in the submitted text (for error messages). */
  line: number;
  /** The normalized rule line (type uppercased, FINAL written as MATCH). */
  rule: string;
}

export interface CustomRuleError {
  line: number;
  message: string;
}

export interface ParsedCustomRules {
  entries: CustomRuleEntry[];
  errors: CustomRuleError[];
}

/** The rule's type (first field, uppercased; FINAL reads as MATCH). */
export function customRuleType(rule: string): string {
  const type = (rule.split(',', 1)[0] ?? '').trim().toUpperCase();
  return type === 'FINAL' ? 'MATCH' : type;
}

/** `prepend` | `append` from user input; `null` for anything else. */
export function parseCustomRulePosition(value: unknown): CustomRulePosition | null {
  if (value === undefined || value === null || value === '') return 'prepend';
  if (value === 'prepend' || value === 'append') return value;
  return null;
}

function syntaxError(line: string): string | null {
  const type = customRuleType(line);
  if (!CUSTOM_RULE_TYPES.has(type)) return `不支持的规则类型「${type || '?'}」`;
  const policy = rulePolicy(line);
  if (type === 'MATCH') {
    if (line.split(',').length < 2 || !policy) return 'MATCH 规则缺少策略，如 MATCH,全球代理';
    return null;
  }
  if (LOGIC_TYPES.has(type)) {
    if (!line.includes('((')) return `${type} 规则缺少 ((条件)) 部分`;
    if (!policy) return `${type} 规则缺少策略`;
    return null;
  }
  const segments = line.split(',');
  if (segments.length < 3) return '格式应为 类型,内容,策略，如 DOMAIN-SUFFIX,example.com,DIRECT';
  if ((segments[1] ?? '').trim() === '') return '规则内容不能为空';
  if (!policy) return '规则缺少策略';
  return null;
}

/**
 * Parse the textarea content into rule entries. Blank lines and comments
 * (`#`, `;`, `//`) are skipped; every other line is syntax-checked. The
 * stored form is the normalized line (trimmed, type uppercased, a leading
 * FINAL rewritten to MATCH); payload and options pass through untouched.
 */
export function parseCustomRules(text: unknown): ParsedCustomRules {
  if (typeof text !== 'string') {
    return { entries: [], errors: [{ line: 0, message: '规则内容必须是文本' }] };
  }
  const entries: CustomRuleEntry[] = [];
  const errors: CustomRuleError[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('//')) return;
    if (line.length > CUSTOM_RULE_MAX_LENGTH) {
      errors.push({ line: lineNumber, message: `超过 ${CUSTOM_RULE_MAX_LENGTH} 字符上限` });
      return;
    }
    if (entries.length >= CUSTOM_RULE_MAX_COUNT) {
      errors.push({ line: lineNumber, message: `规则总数超过 ${CUSTOM_RULE_MAX_COUNT} 条上限` });
      return;
    }
    const problem = syntaxError(line);
    if (problem) {
      errors.push({ line: lineNumber, message: problem });
      return;
    }
    const firstComma = line.indexOf(',');
    const type = customRuleType(line);
    const normalized =
      firstComma === -1 ? type : `${type}${line.slice(firstComma)}`;
    entries.push({ line: lineNumber, rule: normalized });
  });
  return { entries, errors };
}

/**
 * Save-time policy check: every entry's policy must be in `allowedPolicies`
 * (profile groups + node names + built-ins), and a RULE-SET entry must name
 * a rule-provider the profile actually defines.
 */
export function validateCustomRulePolicies(
  entries: CustomRuleEntry[],
  allowedPolicies: ReadonlySet<string>,
  ruleProviderNames: ReadonlySet<string>,
): CustomRuleError[] {
  const errors: CustomRuleError[] = [];
  for (const entry of entries) {
    const policy = rulePolicy(entry.rule);
    if (!policy || !allowedPolicies.has(policy)) {
      errors.push({
        line: entry.line,
        message: `策略「${policy ?? ''}」不存在（须是规则档分组、节点名或 DIRECT/REJECT）`,
      });
      continue;
    }
    if (customRuleType(entry.rule) === 'RULE-SET') {
      const provider = (entry.rule.split(',')[1] ?? '').trim();
      if (!ruleProviderNames.has(provider)) {
        errors.push({ line: entry.line, message: `规则集「${provider}」在当前规则档中不存在` });
      }
    }
  }
  return errors;
}

/**
 * Export-time liveness filter: keep only the rules whose policy resolves
 * against what this render actually defines (surviving groups, emitted
 * nodes, built-ins) and whose RULE-SET provider exists. Order is kept.
 */
export function filterCustomRulesForExport(
  rules: string[],
  alivePolicies: ReadonlySet<string>,
  ruleProviderNames: ReadonlySet<string>,
): string[] {
  return rules.filter((rule) => {
    const policy = rulePolicy(rule);
    if (!policy || !alivePolicies.has(policy)) return false;
    if (customRuleType(rule) === 'RULE-SET') {
      const provider = (rule.split(',')[1] ?? '').trim();
      if (!ruleProviderNames.has(provider)) return false;
    }
    return true;
  });
}

/**
 * Merge custom rules into a profile's rule list.
 *
 * - prepend: custom rules first (the caller renders the built-in QUIC rule
 *   ahead of the whole list, so prepended rules keep top priority without
 *   ever outranking the anti-leak rule).
 * - append: custom rules after the profile's rules but BEFORE the final
 *   MATCH — a rule placed after MATCH can never match anything.
 */
export function mergeCustomRules(
  profileRules: string[],
  customRules: string[],
  position: CustomRulePosition,
): string[] {
  if (customRules.length === 0) return profileRules;
  if (position === 'prepend') return [...customRules, ...profileRules];
  let matchIndex = -1;
  profileRules.forEach((rule, index) => {
    if (customRuleType(rule) === 'MATCH') matchIndex = index;
  });
  if (matchIndex === -1) return [...profileRules, ...customRules];
  return [
    ...profileRules.slice(0, matchIndex),
    ...customRules,
    ...profileRules.slice(matchIndex),
  ];
}

/** Policies that always resolve (client built-ins). */
export function builtinRulePolicies(): ReadonlySet<string> {
  return BUILTIN_GROUP_MEMBERS;
}
