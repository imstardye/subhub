// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Wiring of the real `uri` / `singbox` producers into the export plumbing
 * (`renderTargetBody`, content types, fallback set) — the parts that are not
 * the producers themselves.
 */
import { describe, expect, it } from 'vitest';
import {
  contentTypeForTarget,
  EXPORT_TARGETS,
  fileNameExtensionFor,
  isFallbackTarget,
  type ExportTarget,
} from '../server/utils/targets';
import { renderTargetBody, type ExportProfile } from '../server/utils/export-nodes';
import { buildShareLinks, parseSubscription, SINGBOX_SUPPORTED_TYPES } from '../core';
import type { ProxyNode } from '../core/types';

const UUID = '11111111-2222-3333-4444-555555555555';

const MIXED: ProxyNode[] = [
  { type: 'ss', name: 'SS', server: 'ss.example.com', port: 8388, cipher: 'aes-256-gcm', password: 'fake' },
  { type: 'trojan', name: 'Trojan', server: 'trojan.example.com', port: 443, password: 'fake' },
  { type: 'snell', name: 'Snell', server: 'snell.example.com', port: 8388, version: 6, psk: 'fixture-snell-psk' },
  { type: 'vless', name: 'VLESS', server: 'vless.example.com', port: 443, uuid: UUID },
] as ProxyNode[];

const PROFILE: ExportProfile = {
  ruleProviders: {},
  rules: ['MATCH,DIRECT'],
  proxyGroups: [{ name: 'PROXY', type: 'select', proxies: ['SS'] }],
  groupNames: ['PROXY'],
  dnsTemplate: null,
};

describe('target metadata', () => {
  it('keeps every target in the list', () => {
    expect([...EXPORT_TARGETS]).toEqual([
      'mihomo',
      'clash',
      'shadowrocket',
      'shadowrocket-conf',
      'singbox',
      'surge',
      'loon',
      'uri',
    ]);
  });

  it('treats no target as a mihomo fallback anymore', () => {
    for (const target of EXPORT_TARGETS) {
      expect(isFallbackTarget(target)).toBe(false);
    }
  });

  it.each([
    ['mihomo', 'text/yaml; charset=utf-8', 'yaml'],
    ['clash', 'text/yaml; charset=utf-8', 'yaml'],
    ['shadowrocket', 'text/plain; charset=utf-8', 'txt'],
    ['shadowrocket-conf', 'text/plain; charset=utf-8', 'conf'],
    ['surge', 'text/plain; charset=utf-8', 'conf'],
    ['loon', 'text/plain; charset=utf-8', 'conf'],
    ['singbox', 'application/json; charset=utf-8', 'json'],
    ['uri', 'text/plain; charset=utf-8', 'txt'],
  ] as const)('%s -> %s / .%s', (target, contentType, extension) => {
    expect(contentTypeForTarget(target)).toBe(contentType);
    expect(fileNameExtensionFor(target)).toBe(extension);
  });
});

describe('renderTargetBody', () => {
  it('renders a base64 share-link body for uri (not YAML)', () => {
    const body = renderTargetBody('uri', MIXED);
    expect(body).not.toContain('proxies:');
    const links = Buffer.from(body, 'base64').toString('utf8').split('\n');
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.split('://')[0])).toEqual(['ss', 'trojan', 'vless']);
    expect(parseSubscription(body).map((node) => node.name)).toEqual(['SS', 'Trojan', 'VLESS']);
  });

  it('renders a sing-box JSON document (not YAML)', () => {
    const body = renderTargetBody('singbox', MIXED);
    expect(body).not.toContain('proxies:');
    const parsed = JSON.parse(body) as { outbounds: Array<{ tag: string; type: string }> };
    expect(parsed.outbounds.map((outbound) => outbound.tag)).toEqual(['SS', 'Trojan', 'Snell', 'VLESS']);
    expect(parsed.outbounds.map((outbound) => outbound.type)).toEqual([
      'shadowsocks',
      'trojan',
      'snell',
      'vless',
    ]);
  });

  it.each(['mihomo', 'clash'] as const)('preserves Snell v1–v6 through YAML input and %s export', (target) => {
    const nodes: ProxyNode[] = [1, 2, 3, 4, 5, 6].map((version) => ({
      ...MIXED[2]!,
      name: `Snell v${version}`,
      version,
      udp: version >= 3,
      ...(version >= 4 ? { reuse: false } : {}),
      ...(version === 6
        ? { mode: 'unshaped', userkey: 'fixture-id', 'obfs-opts': { mode: 'shadow-tls', host: 'example.com', version: 3, password: 'fixture' } }
        : { 'obfs-opts': { mode: 'http', host: 'example.com' } }),
    }));
    const parsed = parseSubscription(`proxies:\n${nodes.map((entry) => `  - ${JSON.stringify(entry)}`).join('\n')}`);
    expect(parsed).toEqual(nodes);
    for (const pretty of [true, false]) {
      expect(parseSubscription(renderTargetBody(target, parsed, { pretty }))).toEqual(nodes);
    }
  });

  it('ignores a rule profile for uri and singbox (groups/rules are out of scope)', () => {
    expect(renderTargetBody('uri', MIXED, {}, PROFILE)).toBe(renderTargetBody('uri', MIXED));
    expect(renderTargetBody('singbox', MIXED, {}, PROFILE)).toBe(
      renderTargetBody('singbox', MIXED),
    );
    expect(renderTargetBody('singbox', MIXED, {}, PROFILE)).not.toContain('PROXY');
  });

  it('emits valid empty documents for an empty node list', () => {
    expect(renderTargetBody('uri', [])).toBe('');
    expect(JSON.parse(renderTargetBody('singbox', []))).toEqual({ outbounds: [] });
  });

  it('the uri body only contains links the parser accepts', () => {
    const links = buildShareLinks(MIXED);
    expect(links).toHaveLength(3);
    expect(links.every((link) => parseSubscription(link).length === 1)).toBe(true);
    // Snell is supported in sing-box JSON but has no documented share link.
    expect(SINGBOX_SUPPORTED_TYPES).toContain('snell');
  });
});
