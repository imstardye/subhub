// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-user node operator pipeline (Sub-Store-style operators).
 *
 * A user's pipeline is an ordered list of operators that transform their
 * merged node list at export time: filter, dedupe, rename, sort, set
 * properties. It runs inside `loadUserProfile` after the built-in info
 * filter and the profile's `exclude_remarks`, BEFORE the profile's group
 * regexes expand — so groups see the final names (a rename can therefore
 * starve a group; the /my editor's dry-run preview exists for exactly
 * that). It applies to every target, because it acts on nodes themselves.
 *
 * Two defences mirror the custom-rules design:
 *  - save time: `validateOperators` checks structure and compiles every
 *    regex, so a stored pipeline is always runnable;
 *  - export time: `applyOperators` never throws — a failing operator is
 *    skipped, unknown types are ignored, and a final uniqueness pass
 *    guarantees no two emitted nodes share a name (mihomo rejects
 *    duplicate proxy names).
 *
 * `sourceId` is reserved on every operator for a future per-source scope
 * (v2): it is validated and stored, but v1 application ignores it — the
 * merged node list carries no provenance today.
 */
import type { ProxyNode } from './types';

interface OperatorBase {
  /** Disabled operators stay in the list but do not run. Default: enabled. */
  enabled?: boolean;
  /** Reserved for per-source scope (v2). Stored, not applied in v1. */
  sourceId?: number;
}

export interface RegexFilterOperator extends OperatorBase {
  type: 'regex-filter';
  pattern: string;
  /** keep = only matching names survive; drop = matching names are removed. */
  mode: 'keep' | 'drop';
  ignoreCase?: boolean;
}

export interface TypeFilterOperator extends OperatorBase {
  type: 'type-filter';
  /** Lowercase protocol types ('ss', 'vless', 'hysteria2', ...). */
  types: string[];
  mode: 'include' | 'exclude';
}

export interface RegexRenameOperator extends OperatorBase {
  type: 'regex-rename';
  /** Applied in order; each is a JS `String.replace` (supports $1, $&, ...). */
  rules: Array<{ pattern: string; replacement: string; ignoreCase?: boolean }>;
}

export interface SortOperator extends OperatorBase {
  type: 'sort';
  /**
   * name-asc / name-desc: plain code-point name order.
   * regex: nodes matching an earlier pattern rank first (stable within a
   * rank; unmatched nodes go last in their original order).
   */
  mode: 'name-asc' | 'name-desc' | 'regex';
  patterns?: string[];
}

export interface SetPropertyOperator extends OperatorBase {
  type: 'set-property';
  /** Each present field is set on every node; absent fields are untouched. */
  udp?: boolean;
  tfo?: boolean;
  skipCertVerify?: boolean;
}

export interface HandleDuplicateOperator extends OperatorBase {
  type: 'handle-duplicate';
  /** name = same display name; server = same type+server+port. */
  by: 'name' | 'server';
  /** drop = later copies go; rename = later copies get a ` #N` name suffix. */
  mode: 'drop' | 'rename';
}

export type NodeOperator =
  | RegexFilterOperator
  | TypeFilterOperator
  | RegexRenameOperator
  | SortOperator
  | SetPropertyOperator
  | HandleDuplicateOperator;

export type NodeOperatorType = NodeOperator['type'];

export const OPERATOR_MAX_COUNT = 20;
export const OPERATOR_PATTERN_MAX_LENGTH = 256;

export interface OperatorError {
  /** 0-based index of the offending operator in the submitted list. */
  index: number;
  message: string;
}

export interface ValidatedOperators {
  operators: NodeOperator[];
  errors: OperatorError[];
}

function compileRegex(pattern: string, ignoreCase?: boolean): RegExp | null {
  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    return null;
  }
}

function checkPattern(
  errors: OperatorError[],
  index: number,
  pattern: unknown,
  label: string,
  ignoreCase?: boolean,
): string | null {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    errors.push({ index, message: `${label}不能为空` });
    return null;
  }
  if (pattern.length > OPERATOR_PATTERN_MAX_LENGTH) {
    errors.push({ index, message: `${label}超过 ${OPERATOR_PATTERN_MAX_LENGTH} 字符上限` });
    return null;
  }
  if (!compileRegex(pattern, ignoreCase)) {
    errors.push({ index, message: `${label}不是有效的正则表达式` });
    return null;
  }
  return pattern;
}

function checkBase(errors: OperatorError[], index: number, raw: Record<string, unknown>): void {
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({ index, message: 'enabled 必须是布尔值' });
  }
  if (
    raw.sourceId !== undefined &&
    (typeof raw.sourceId !== 'number' || !Number.isInteger(raw.sourceId) || raw.sourceId <= 0)
  ) {
    errors.push({ index, message: 'sourceId 必须是正整数' });
  }
}

/**
 * Validate untrusted pipeline input (save + preview share this). Returns
 * the normalized operators alongside per-operator errors; when `errors` is
 * non-empty the caller must refuse the whole list (nothing half-valid is
 * ever stored).
 */
export function validateOperators(input: unknown): ValidatedOperators {
  if (input === null || input === undefined) return { operators: [], errors: [] };
  if (!Array.isArray(input)) {
    return { operators: [], errors: [{ index: -1, message: '算子列表必须是数组' }] };
  }
  const errors: OperatorError[] = [];
  const operators: NodeOperator[] = [];
  if (input.length > OPERATOR_MAX_COUNT) {
    errors.push({ index: OPERATOR_MAX_COUNT, message: `算子总数超过 ${OPERATOR_MAX_COUNT} 个上限` });
  }
  input.slice(0, OPERATOR_MAX_COUNT).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ index, message: '算子必须是对象' });
      return;
    }
    const record = raw as Record<string, unknown>;
    checkBase(errors, index, record);
    const base: OperatorBase = {
      ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
      ...(typeof record.sourceId === 'number' ? { sourceId: record.sourceId } : {}),
    };
    switch (record.type) {
      case 'regex-filter': {
        const pattern = checkPattern(errors, index, record.pattern, '过滤正则', record.ignoreCase === true);
        if (record.mode !== 'keep' && record.mode !== 'drop') {
          errors.push({ index, message: '过滤模式只能是 keep 或 drop' });
        }
        if (pattern !== null && (record.mode === 'keep' || record.mode === 'drop')) {
          operators.push({
            ...base,
            type: 'regex-filter',
            pattern,
            mode: record.mode,
            ...(record.ignoreCase === true ? { ignoreCase: true } : {}),
          });
        }
        break;
      }
      case 'type-filter': {
        if (record.mode !== 'include' && record.mode !== 'exclude') {
          errors.push({ index, message: '类型过滤模式只能是 include 或 exclude' });
        }
        if (!Array.isArray(record.types) || record.types.length === 0) {
          errors.push({ index, message: '类型列表不能为空' });
          break;
        }
        const types = [
          ...new Set(
            record.types
              .filter((value): value is string => typeof value === 'string')
              .map((value) => value.trim().toLowerCase())
              .filter((value) => value !== '' && value.length <= 32),
          ),
        ];
        if (types.length === 0) {
          errors.push({ index, message: '类型列表不能为空' });
        } else if (record.mode === 'include' || record.mode === 'exclude') {
          operators.push({ ...base, type: 'type-filter', types, mode: record.mode });
        }
        break;
      }
      case 'regex-rename': {
        if (!Array.isArray(record.rules) || record.rules.length === 0) {
          errors.push({ index, message: '改名规则不能为空' });
          break;
        }
        if (record.rules.length > 20) {
          errors.push({ index, message: '改名规则超过 20 组上限' });
          break;
        }
        const rules: RegexRenameOperator['rules'] = [];
        let valid = true;
        record.rules.forEach((rule, ruleIndex) => {
          if (!rule || typeof rule !== 'object') {
            errors.push({ index, message: `改名规则第 ${ruleIndex + 1} 组必须是对象` });
            valid = false;
            return;
          }
          const entry = rule as Record<string, unknown>;
          const pattern = checkPattern(
            errors,
            index,
            entry.pattern,
            `改名规则第 ${ruleIndex + 1} 组的正则`,
            entry.ignoreCase === true,
          );
          if (typeof entry.replacement !== 'string' || entry.replacement.length > OPERATOR_PATTERN_MAX_LENGTH) {
            errors.push({ index, message: `改名规则第 ${ruleIndex + 1} 组的替换文本无效` });
            valid = false;
            return;
          }
          if (pattern !== null) {
            rules.push({
              pattern,
              replacement: entry.replacement,
              ...(entry.ignoreCase === true ? { ignoreCase: true } : {}),
            });
          } else {
            valid = false;
          }
        });
        if (valid && rules.length > 0) operators.push({ ...base, type: 'regex-rename', rules });
        break;
      }
      case 'sort': {
        if (record.mode !== 'name-asc' && record.mode !== 'name-desc' && record.mode !== 'regex') {
          errors.push({ index, message: '排序模式只能是 name-asc、name-desc 或 regex' });
          break;
        }
        if (record.mode === 'regex') {
          if (!Array.isArray(record.patterns) || record.patterns.length === 0) {
            errors.push({ index, message: '正则排序至少需要一个正则' });
            break;
          }
          const patterns: string[] = [];
          let valid = true;
          record.patterns.forEach((pattern, patternIndex) => {
            const checked = checkPattern(errors, index, pattern, `排序正则第 ${patternIndex + 1} 个`);
            if (checked === null) valid = false;
            else patterns.push(checked);
          });
          if (valid) operators.push({ ...base, type: 'sort', mode: 'regex', patterns });
        } else {
          operators.push({ ...base, type: 'sort', mode: record.mode });
        }
        break;
      }
      case 'set-property': {
        const errorsBefore = errors.length;
        const fields: Array<'udp' | 'tfo' | 'skipCertVerify'> = ['udp', 'tfo', 'skipCertVerify'];
        const picked: Partial<Record<(typeof fields)[number], boolean>> = {};
        for (const field of fields) {
          if (record[field] !== undefined) {
            if (typeof record[field] !== 'boolean') {
              errors.push({ index, message: `${field} 必须是布尔值` });
            } else {
              picked[field] = record[field];
            }
          }
        }
        if (Object.keys(picked).length === 0 && errors.length === errorsBefore) {
          errors.push({ index, message: '改属性至少要设置一项（udp / tfo / skipCertVerify）' });
        }
        if (Object.keys(picked).length > 0) {
          operators.push({ ...base, type: 'set-property', ...picked });
        }
        break;
      }
      case 'handle-duplicate': {
        if (record.by !== 'name' && record.by !== 'server') {
          errors.push({ index, message: '去重依据只能是 name 或 server' });
        }
        if (record.mode !== 'drop' && record.mode !== 'rename') {
          errors.push({ index, message: '去重模式只能是 drop 或 rename' });
        }
        if (
          (record.by === 'name' || record.by === 'server') &&
          (record.mode === 'drop' || record.mode === 'rename')
        ) {
          operators.push({ ...base, type: 'handle-duplicate', by: record.by, mode: record.mode });
        }
        break;
      }
      default:
        errors.push({ index, message: `不支持的算子类型「${String(record.type ?? '?')}」` });
    }
  });
  return { operators: errors.length > 0 ? [] : operators, errors };
}

/** Parse the stored JSON column; anything unusable reads as "no pipeline". */
export function parseOperatorsJson(text: string | null | undefined): NodeOperator[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const { operators, errors } = validateOperators(parsed);
    return errors.length > 0 ? [] : operators;
  } catch {
    return [];
  }
}

function duplicateKey(node: ProxyNode, by: 'name' | 'server'): string {
  return by === 'name' ? `n:${node.name}` : `s:${node.type}|${node.server}|${node.port}`;
}

/** Append ` #2`, ` #3`, ... until `name` is not in `used`. */
function suffixedName(name: string, used: Set<string>): string {
  let counter = 2;
  let candidate = `${name} #${counter}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${name} #${counter}`;
  }
  return candidate;
}

/**
 * Guarantee unique display names: later duplicates get a ` #N` suffix.
 * Runs at the end of every `applyOperators` call (and is exported for the
 * producers' own call sites if they ever need it).
 */
export function ensureUniqueNodeNames(nodes: ProxyNode[]): ProxyNode[] {
  const used = new Set<string>();
  return nodes.map((node) => {
    if (!used.has(node.name)) {
      used.add(node.name);
      return node;
    }
    const renamed = { ...node, name: suffixedName(node.name, used) };
    used.add(renamed.name);
    return renamed;
  });
}

function applyOne(nodes: ProxyNode[], operator: NodeOperator): ProxyNode[] {
  switch (operator.type) {
    case 'regex-filter': {
      const regex = compileRegex(operator.pattern, operator.ignoreCase);
      if (!regex) return nodes;
      return nodes.filter((node) => regex.test(node.name) === (operator.mode === 'keep'));
    }
    case 'type-filter': {
      const types = new Set(operator.types);
      return nodes.filter(
        (node) => types.has(String(node.type).toLowerCase()) === (operator.mode === 'include'),
      );
    }
    case 'regex-rename': {
      const compiled = operator.rules.map((rule) => ({
        regex: compileRegex(rule.pattern, rule.ignoreCase),
        replacement: rule.replacement,
      }));
      return nodes.map((node) => {
        let name = node.name;
        for (const { regex, replacement } of compiled) {
          if (!regex) continue;
          const next = name.replace(regex, replacement);
          if (next.trim() !== '') name = next;
        }
        return name === node.name ? node : { ...node, name };
      });
    }
    case 'sort': {
      if (operator.mode === 'name-asc' || operator.mode === 'name-desc') {
        const direction = operator.mode === 'name-asc' ? 1 : -1;
        return [...nodes].sort((a, b) =>
          a.name === b.name ? 0 : (a.name < b.name ? -1 : 1) * direction,
        );
      }
      const regexes = (operator.patterns ?? [])
        .map((pattern) => compileRegex(pattern))
        .filter((regex): regex is RegExp => regex !== null);
      const rank = (node: ProxyNode): number => {
        const found = regexes.findIndex((regex) => regex.test(node.name));
        return found === -1 ? regexes.length : found;
      };
      return [...nodes].sort((a, b) => rank(a) - rank(b));
    }
    case 'set-property': {
      return nodes.map((node) => {
        const next = { ...node };
        if (operator.udp !== undefined) next.udp = operator.udp;
        if (operator.tfo !== undefined) next.tfo = operator.tfo;
        if (operator.skipCertVerify !== undefined) next['skip-cert-verify'] = operator.skipCertVerify;
        return next;
      });
    }
    case 'handle-duplicate': {
      const seen = new Map<string, number>();
      const result: ProxyNode[] = [];
      for (const node of nodes) {
        const key = duplicateKey(node, operator.by);
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count === 1) {
          result.push(node);
        } else if (operator.mode === 'rename') {
          result.push({ ...node, name: `${node.name} #${count}` });
        }
      }
      return result;
    }
  }
}

/**
 * Run a pipeline over a node list. Disabled operators are skipped; a
 * failing operator is skipped rather than failing the export. The result
 * always passes the name-uniqueness guarantee.
 */
export function applyOperators(
  nodes: ProxyNode[],
  operators: readonly NodeOperator[],
): ProxyNode[] {
  let current = nodes;
  for (const operator of operators) {
    if (!operator || operator.enabled === false) continue;
    try {
      const next = applyOne(current, operator);
      // `applyOne` is exhaustive over the validated union; a malformed
      // runtime object falls through it, so only a real list is accepted.
      if (Array.isArray(next)) current = next;
    } catch {
      // A stored pipeline was validated at save time; this is only a
      // last-resort guard so an operator can never break an export.
    }
  }
  return ensureUniqueNodeNames(current);
}
