// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Display helpers for the /my operator-pipeline editor: type labels,
 * factory defaults for a newly added operator, and the one-line summary
 * each operator card shows when collapsed. Pure functions over the core
 * operator DTOs so the page stays wiring-only and this is unit-testable.
 */
import type { NodeOperator, NodeOperatorType } from '../operators';

export const OPERATOR_TYPE_LABELS: Record<NodeOperatorType, string> = {
  'regex-filter': '名称过滤',
  'type-filter': '类型过滤',
  'handle-duplicate': '重复处理',
  'regex-rename': '正则改名',
  sort: '排序',
  'set-property': '改属性',
};

/** Add-menu order: the recommended pipeline order (filter → dedupe → rename → sort → property). */
export const OPERATOR_TYPE_ORDER: NodeOperatorType[] = [
  'regex-filter',
  'type-filter',
  'handle-duplicate',
  'regex-rename',
  'sort',
  'set-property',
];

/** Protocol types the type-filter offers (free-form values still validate). */
export const OPERATOR_PROTOCOL_TYPES = [
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'anytls',
  'wireguard',
  'snell',
  'socks5',
  'http',
];

/** A fresh operator of the given type, with args a user can immediately edit. */
export function defaultOperator(type: NodeOperatorType): NodeOperator {
  switch (type) {
    case 'regex-filter':
      return { type, pattern: '', mode: 'drop' };
    case 'type-filter':
      return { type, types: [], mode: 'exclude' };
    case 'handle-duplicate':
      return { type, by: 'server', mode: 'drop' };
    case 'regex-rename':
      return { type, rules: [{ pattern: '', replacement: '' }] };
    case 'sort':
      return { type, mode: 'regex', patterns: [] };
    case 'set-property':
      return { type, skipCertVerify: true };
  }
}

/** One-line human summary of what an operator will do. */
export function operatorSummary(operator: NodeOperator): string {
  switch (operator.type) {
    case 'regex-filter':
      return `${operator.mode === 'keep' ? '只保留' : '剔除'}名称匹配 /${operator.pattern}/${operator.ignoreCase ? 'i' : ''} 的节点`;
    case 'type-filter':
      return operator.types.length === 0
        ? '尚未选择类型'
        : `${operator.mode === 'include' ? '只保留' : '剔除'} ${operator.types.join(' / ')} 类型`;
    case 'handle-duplicate':
      return `按${operator.by === 'name' ? '名称' : '服务器'}判重，${operator.mode === 'drop' ? '丢弃' : '改名保留'}重复节点`;
    case 'regex-rename':
      return `${operator.rules.length} 组改名：${operator.rules
        .map((rule) => `/${rule.pattern}/ → ${rule.replacement || '（空）'}`)
        .join('；')}`;
    case 'sort':
      if (operator.mode === 'name-asc') return '按名称升序';
      if (operator.mode === 'name-desc') return '按名称降序';
      return `按正则优先级：${(operator.patterns ?? []).join(' → ') || '（未填）'}`;
    case 'set-property': {
      const parts: string[] = [];
      if (operator.udp !== undefined) parts.push(`udp ${operator.udp ? '开' : '关'}`);
      if (operator.tfo !== undefined) parts.push(`tfo ${operator.tfo ? '开' : '关'}`);
      if (operator.skipCertVerify !== undefined) {
        parts.push(`跳过证书校验 ${operator.skipCertVerify ? '开' : '关'}`);
      }
      return parts.length > 0 ? parts.join('，') : '尚未设置任何属性';
    }
  }
}
