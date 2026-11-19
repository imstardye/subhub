// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseSubscription, parseSubscriptionDetailed, parseUri, type ProxyNode } from '../core';
import {
  buildLoonProxies, buildMihomoProxyResult, buildShadowrocketConfProxies,
  buildShadowrocketSubscription, buildSingboxOutboundResult, buildSurgeProxies, produceLoon,
} from '../core/producers';
import { buildShareLinkResult } from '../core/producers/uri';
import { renderTargetBody, targetProxyNames } from '../server/utils/export-nodes';

const parseNodes = (...proxies: Record<string, unknown>[]) => parseSubscription(stringifyYaml({ proxies }));

const easytier = {
  name: 'Overlay', type: 'easytier', 'network-name': 'test-net', 'network-secret': 'fixture',
  ipv4: '10.144.0.1/24', peers: ['tcp://192.0.2.10:11010', 'udp://192.0.2.11:11010'],
  'no-listener': true, 'accept-dns': false, 'enable-quic-proxy': false, 'dialer-proxy': 'upstream',
};

const wireguard = {
  name: 'WG', type: 'wireguard', server: '192.0.2.20', port: 51820, ip: '192.0.2.21/32',
  'private-key': 'fixture-private', 'public-key': 'fixture-public',
};

const amnezia = {
  jc: 5, jmin: 500, jmax: 501, s1: 0, s2: 40, h1: 123456, h2: '67543-67600', h3: 123123, h4: '32345',
};

describe('EasyTier', () => {
  it('preserves native YAML without inventing a destination in either YAML target', () => {
    const nodes = parseNodes(easytier);
    expect(nodes).toHaveLength(1);
    for (const target of ['mihomo', 'clash'] as const) {
      for (const pretty of [true, false]) {
        expect(parseYaml(renderTargetBody(target, nodes, { pretty })).proxies).toEqual([easytier]);
        expect(targetProxyNames(target, nodes)).toEqual(['Overlay']);
      }
    }
    expect(parseNodes({ ...easytier, 'network-name': '' })).toEqual([]);
    expect(parseNodes({ ...easytier, name: '' })).toEqual([]);
  });

  it('diagnoses unsupported exports rather than treating it as a malformed TCP node', () => {
    const nodes = parseNodes(easytier);
    for (const build of [buildLoonProxies, buildSurgeProxies, buildShadowrocketSubscription,
      buildShadowrocketConfProxies, buildShareLinkResult, buildSingboxOutboundResult]) {
      expect(build(nodes).skipped).toEqual([{ name: 'Overlay', reason: expect.stringMatching(/easytier/i) }]);
    }
    for (const target of ['loon', 'surge', 'shadowrocket', 'shadowrocket-conf', 'uri', 'singbox'] as const) {
      expect(renderTargetBody(target, nodes)).toBe(renderTargetBody(target, []));
    }
  });
});

describe('AmneziaWG', () => {
  it('retains the exact nested fields in both documented WireGuard layouts', () => {
    const simple = { ...wireguard, 'amnezia-wg-option': amnezia };
    const { server, port, 'public-key': publicKey, ...local } = simple;
    const full = { ...local, name: 'AWG peers', peers: [{ server, port, 'public-key': publicKey, 'allowed-ips': ['0.0.0.0/0'] }] };
    for (const target of ['mihomo', 'clash'] as const) {
      expect(parseYaml(renderTargetBody(target, parseNodes(simple, full))).proxies).toEqual([simple, full]);
    }
  });

  it('never emits flat Amnezia fields or silently downgrades to plain WireGuard', () => {
    const nodes = parseNodes({ ...wireguard, ...amnezia }, { ...wireguard, 'amnezia-wg-option': 'invalid' });
    expect(buildMihomoProxyResult(nodes)).toEqual({
      proxies: [], skipped: [
        { name: 'WG', reason: expect.stringContaining('nested') },
        { name: 'WG', reason: expect.stringContaining('mapping') },
      ],
    });
    const mixed = parseNodes({ ...wireguard, h1: 1, 'amnezia-wg-option': amnezia });
    expect(parseYaml(renderTargetBody('mihomo', mixed)).proxies).toEqual([{ ...wireguard, 'amnezia-wg-option': amnezia }]);
  });

  it('skips AmneziaWG in sing-box while still rendering ordinary WireGuard', () => {
    const nodes = parseNodes({ ...wireguard, name: 'AWG', 'amnezia-wg-option': amnezia }, wireguard);
    expect(JSON.parse(renderTargetBody('singbox', nodes)).endpoints).toEqual([
      expect.objectContaining({ type: 'wireguard', tag: 'WG' }),
    ]);
    expect(buildSingboxOutboundResult(nodes).skipped).toEqual([
      { name: 'AWG', reason: expect.stringContaining('AmneziaWG') },
    ]);
  });
});

const sudokuLink = (payload: unknown) => `sudoku://${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

describe('Sudoku', () => {
  it('round-trips the documented upstream short link through the URI subscription', () => {
    const payload = {
      n: '数独', h: '2001:db8::1', p: 443, k: 'fixture', a: 'up_ascii_down_entropy', e: 'chacha20-poly1305',
      m: 1080, x: true, t: 'xpxvvpvv', ts: ['xpxvvpvv'], hd: false, hm: 'stream', ht: true,
      hh: 'example.test', hx: 'auto', hy: 'example',
    };
    const original = sudokuLink(payload);
    const node = parseUri(original)!;
    expect(node).toMatchObject({ name: '数独', type: 'sudoku', server: '2001:db8::1', port: 443, key: 'fixture' });
    expect(Buffer.from(renderTargetBody('uri', [node]), 'base64').toString()).toBe(original);
    expect(parseSubscription(renderTargetBody('uri', [node]))).toEqual([node]);
    expect(renderTargetBody('shadowrocket', [node])).toBe('');
    expect(buildShadowrocketSubscription([node]).skipped[0]?.reason).toContain('no verified');
    expect(targetProxyNames('mihomo', [node])).toEqual([]);
  });

  it('preserves native mihomo Sudoku YAML separately, without guessing a cross-format mapping', () => {
    const proxy = { name: 'Sudoku', type: 'sudoku', server: 'example.test', port: 443, key: 'fixture',
      'table-type': 'prefer_ascii', httpmask: { mode: 'legacy', tls: false }, 'enable-pure-downlink': false };
    const nodes = parseNodes(proxy);
    expect(parseYaml(renderTargetBody('mihomo', nodes)).proxies).toEqual([proxy]);
    expect(renderTargetBody('uri', nodes)).toBe('');
  });

  it.each(['sudoku://??', sudokuLink({ h: 'example.test', p: 443 }),
    sudokuLink({ h: 'example.test', p: 65536, k: 'fixture' }),
    sudokuLink({ h: 'example.test', p: 443, k: 'fixture', ht: 'true' }),
  ])('diagnoses malformed input %s', (link) => {
    const result = parseSubscriptionDetailed(link);
    expect(result.nodes).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});

describe('Loon Tailscale', () => {
  const node: ProxyNode = { name: 'Example', type: 'ss', server: 'example.test', port: 443,
    cipher: 'aes-128-gcm', password: 'fixture' };
  const options = { tailscale: { authKey: 'tskey-auth-fixture', hostname: 'subhub-alice', dialerProxy: 'Pick' } };

  it('appends only the documented proxy line before profile groups', () => {
    const body = produceLoon([node], [{ name: 'Pick', type: 'select', proxies: ['Example'] }], options);
    expect(body).toContain('Tailscale = tailscale,auth-key="tskey-auth-fixture",hostname=subhub-alice\n\nPick = select,Example');
    expect(body).not.toContain('dialer-proxy');
    expect(body).not.toContain('[Rule]');
  });

  it('preserves existing policies and ignores unsafe keys or hostnames', () => {
    const named = { ...node, name: 'tailScale' };
    expect(produceLoon([named], [], options)).toBe(produceLoon([named]));
    const groups = [{ name: 'tailscale', type: 'select', proxies: ['Example'] }];
    expect(produceLoon([node], groups, options)).toBe(produceLoon([node], groups));
    for (const tailscale of [{ ...options.tailscale, authKey: 'bad"\nREJECT = DIRECT' },
      { ...options.tailscale, hostname: 'bad,allow-inbound=true' }]) {
      expect(produceLoon([node], [], { tailscale })).toBe(produceLoon([node]));
    }
  });
});
