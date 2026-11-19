// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify } from 'yaml';
import { parseClashNode, parseClashYaml, parseSubscription } from '../core/parsers/clash';
import { renderTargetBody } from '../server/utils/export-nodes';
import type { ProxyNode } from '../core/types';

// Complete-certificate SHA-256, not an HPKP/public-key hash or uTLS preset.
const PIN = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':');
const BASE: ProxyNode = {
  type: 'anytls', name: 'Pinned AnyTLS', server: 'example.com', port: 443,
  password: 'test-password', 'client-fingerprint': 'chrome',
};

describe('AnyTLS certificate pin fidelity (mihomo and Stash Clash YAML)', () => {
  for (const field of ['fingerprint', 'server-cert-fingerprint', 'tls-fingerprint']) {
    for (const target of ['mihomo', 'clash'] as const) {
      it(`round-trips ${field} through YAML/JSON and ${target}`, () => {
        const input = { ...BASE, [field]: PIN };
        const yaml = stringify({ proxies: [input] });
        const parsed = [
          parseClashNode(JSON.stringify(input)),
          ...parseClashYaml(yaml),
          ...parseSubscription(yaml),
          ...parseSubscription(JSON.stringify([input])),
          ...parseSubscription(Buffer.from(yaml).toString('base64')),
        ];
        for (const node of parsed) {
          expect(node[field]).toBe(PIN);
          expect(node['tls-fingerprint']).toBe(PIN);
          const snapshot = structuredClone(node);
          for (const pretty of [true, false]) {
            const body = renderTargetBody(target, [node], { pretty });
            const [proxy] = parseYaml(body).proxies;
            expect(proxy.fingerprint).toBe(PIN);
            expect(proxy['server-cert-fingerprint']).toBe(PIN);
            expect(proxy['tls-fingerprint']).toBeUndefined();
            expect(proxy['client-fingerprint']).toBe('chrome');
            expect(proxy.certificate).toBeUndefined();
            expect(parseSubscription(body)[0]['tls-fingerprint']).toBe(PIN);
            expect(renderTargetBody(target, parseSubscription(body), { pretty })).toBe(body);
          }
          expect(node).toEqual(snapshot);
        }
      });
    }
  }

  it('bridges native nodes passed directly to the producer too', () => {
    for (const field of ['fingerprint', 'server-cert-fingerprint', 'tls-fingerprint']) {
      const [proxy] = parseYaml(renderTargetBody('clash', [{ ...BASE, [field]: PIN }])).proxies;
      expect(proxy.fingerprint).toBe(PIN);
      expect(proxy['server-cert-fingerprint']).toBe(PIN);
    }
  });

  it('does not invent a pin from a client fingerprint or mTLS certificate', () => {
    const [proxy] = parseYaml(renderTargetBody('clash', [{ ...BASE, certificate: 'client.pem' }])).proxies;
    expect(proxy.fingerprint).toBeUndefined();
    expect(proxy['server-cert-fingerprint']).toBeUndefined();
    expect(proxy['client-fingerprint']).toBe('chrome');
    expect(proxy.certificate).toBe('client.pem');
  });

  it('resolves conflicting aliases consistently: internal, mihomo, then Stash', () => {
    for (const input of [
      { ...BASE, fingerprint: PIN, 'server-cert-fingerprint': 'other' },
      { ...BASE, 'tls-fingerprint': PIN, fingerprint: 'other', 'server-cert-fingerprint': 'other' },
    ]) {
      const [proxy] = parseYaml(renderTargetBody('clash', [parseClashNode(JSON.stringify(input))])).proxies;
      expect(proxy.fingerprint).toBe(PIN);
      expect(proxy['server-cert-fingerprint']).toBe(PIN);
    }
  });
});
