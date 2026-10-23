// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { ProxyNode } from '../core/types';
import {
  parseAnyTLS,
  parseHysteria2,
  parseTrojan,
  parseTuic,
  parseVless,
  parseVmess,
} from '../core/parsers';
import {
  buildLegacyProxies,
  buildMihomoProxies,
  produceLegacy,
  produceMihomo,
} from '../core/producers';

const UUID = '11111111-2222-3333-4444-555555555555';

function node(overrides: Partial<ProxyNode>): ProxyNode {
  return {
    type: 'ss',
    name: 'test',
    server: 'example.com',
    port: 8388,
    ...overrides,
  } as ProxyNode;
}

describe('mihomo producer', () => {
  it('adds AnyTLS idle-session defaults', () => {
    const anytls = parseAnyTLS(
      'anytls://fake-password@anytls.example.com:443?sni=anytls.example.com#AnyTLS',
    );
    const [proxy] = buildMihomoProxies([anytls]);

    expect(proxy).toMatchObject({
      type: 'anytls',
      'min-idle-session': 0,
      'idle-session-timeout': 30,
    });
  });

  it('does not override explicit AnyTLS idle-session options', () => {
    const [proxy] = buildMihomoProxies([
      node({
        type: 'anytls',
        password: 'fake-password',
        'min-idle-session': 2,
        'idle-session-timeout': 60,
      }),
    ]);

    expect(proxy['min-idle-session']).toBe(2);
    expect(proxy['idle-session-timeout']).toBe(60);
  });

  it('converts vmess sni to servername and normalizes ws options', () => {
    const vmess = parseVmess(
      `vmess://${Buffer.from(
        JSON.stringify({
          ps: 'VMess',
          add: 'vm.example.com',
          port: '443',
          id: UUID,
          net: 'ws',
          tls: 'tls',
          sni: 'sni.example.com',
          host: 'cdn.example.com',
        }),
      ).toString('base64')}`,
    );
    const [proxy] = buildMihomoProxies([vmess]);

    expect(proxy.servername).toBe('sni.example.com');
    expect(proxy.sni).toBeUndefined();
    expect(proxy['ws-opts']).toEqual({
      path: '/',
      headers: { Host: 'cdn.example.com' },
    });
  });

  it('adds the default Reality client fingerprint', () => {
    const vless = parseVless(
      `vless://${UUID}@vless.example.com:443?security=reality&pbk=fake-public-key&sid=abcd#Reality`,
    );
    const [proxy] = buildMihomoProxies([vless]);

    expect(proxy['client-fingerprint']).toBe('chrome');
    expect(proxy.servername).toBeUndefined();
    expect(proxy['reality-opts']).toEqual({
      'public-key': 'fake-public-key',
      'short-id': 'abcd',
    });
  });

  it('preserves an explicit Reality fingerprint', () => {
    const vless = parseVless(
      `vless://${UUID}@vless.example.com:443?security=reality&pbk=fake-public-key&fp=firefox#Reality`,
    );
    const [proxy] = buildMihomoProxies([vless]);

    expect(proxy['client-fingerprint']).toBe('firefox');
  });

  it('adds TUIC version 5 when no token/version is supplied', () => {
    const tuic = parseTuic(
      `tuic://${UUID}:fake-pass@tuic.example.com:443?alpn=h3#TUIC`,
    );
    const [proxy] = buildMihomoProxies([tuic]);

    expect(proxy.version).toBe(5);
    expect(proxy.alpn).toEqual(['h3']);
  });

  it('removes transport-only and underscore-prefixed internal fields', () => {
    const [proxy] = buildMihomoProxies([
      node({
        type: 'vless',
        uuid: UUID,
        network: 'grpc',
        'grpc-opts': {
          'grpc-service-name': 'svc',
          '_grpc-type': 'gun',
          '_grpc-authority': 'authority.example.com',
        },
        _internal: 'nope',
      }),
    ]);

    expect(proxy['grpc-opts']).toEqual({ 'grpc-service-name': 'svc' });
    expect(proxy._internal).toBeUndefined();
  });

  it('emits parseable YAML with all supported protocols', () => {
    const nodes = [
      node({
        type: 'ss',
        cipher: 'aes-256-gcm',
        password: 'fake-password',
      }),
      parseVmess(
        `vmess://${Buffer.from(
          JSON.stringify({
            ps: 'VMess',
            add: 'vm.example.com',
            port: '443',
            id: UUID,
          }),
        ).toString('base64')}`,
      ),
      parseVless(
        `vless://${UUID}@vless.example.com:443?security=tls&sni=vless.example.com#VLESS`,
      ),
      parseTrojan(
        'trojan://fake-password@trojan.example.com:443?sni=trojan.example.com#Trojan',
      ),
      parseHysteria2('hysteria2://fake-password@hy2.example.com:443#HY2'),
      parseTuic(`tuic://${UUID}:fake-pass@tuic.example.com:443#TUIC`),
      parseAnyTLS(
        'anytls://fake-password@anytls.example.com:443#AnyTLS',
      ),
    ];

    const output = produceMihomo(nodes, { pretty: true });
    const document = parseYaml(output) as { proxies: ProxyNode[] };

    expect(document.proxies).toHaveLength(7);
    expect(document.proxies.map((proxy) => proxy.type)).toEqual([
      'ss',
      'vmess',
      'vless',
      'trojan',
      'hysteria2',
      'tuic',
      'anytls',
    ]);
  });
});

describe('legacy Clash producer', () => {
  it('filters protocols and features unsupported by legacy Clash', () => {
    const nodes: ProxyNode[] = [
      node({ type: 'ss', cipher: 'aes-256-gcm', password: 'fake-password' }),
      node({
        type: 'ss',
        name: 'unsupported-cipher',
        cipher: '2022-blake3-aes-128-gcm',
        password: 'fake-password',
      }),
      node({ type: 'vmess', uuid: UUID, cipher: 'auto', alterId: 0 }),
      node({ type: 'vless', uuid: UUID }),
      node({
        type: 'vless',
        name: 'vless-reality',
        uuid: UUID,
        'reality-opts': { 'public-key': 'fake-public-key' },
      }),
      node({ type: 'vless', name: 'vless-flow', uuid: UUID, flow: 'xtls-rprx-vision' }),
      node({ type: 'trojan', password: 'fake-password' }),
      node({ type: 'hysteria2', password: 'fake-password' }),
      node({ type: 'tuic', uuid: UUID, password: 'fake-password' }),
      node({ type: 'anytls', password: 'fake-password' }),
      node({
        type: 'vmess',
        name: 'vmess-httpupgrade',
        uuid: UUID,
        network: 'ws',
        'ws-opts': { path: '/', 'v2ray-http-upgrade': true },
      }),
    ];

    const proxies = buildLegacyProxies(nodes);

    expect(proxies.map((proxy) => proxy.name)).toEqual([
      'test',
      'test',
      'test',
      'test',
    ]);
    expect(proxies.map((proxy) => proxy.type)).toEqual([
      'ss',
      'vmess',
      'vless',
      'trojan',
    ]);
  });

  it('uses servername for vmess/vless and drops reality/flow fields', () => {
    const [vmess, vless] = buildLegacyProxies([
      node({
        type: 'vmess',
        uuid: UUID,
        cipher: 'auto',
        alterId: 0,
        sni: 'sni.example.com',
      }),
      node({
        type: 'vless',
        name: 'vless',
        uuid: UUID,
        sni: 'sni.example.com',
        'reality-opts': { 'public-key': 'fake' },
        flow: 'xtls-rprx-vision',
      }),
    ], { includeUnsupported: true });

    expect(vmess.servername).toBe('sni.example.com');
    expect(vmess.sni).toBeUndefined();
    expect(vless.servername).toBe('sni.example.com');
    expect(vless['reality-opts']).toBeUndefined();
    expect(vless.flow).toBeUndefined();
  });

  it('does not emit a tls field for Trojan nodes', () => {
    const [trojan] = buildLegacyProxies([
      node({ type: 'trojan', password: 'fake-password', tls: true }),
    ]);

    expect(trojan.tls).toBeUndefined();
  });

  it('keeps tls for VMess and VLESS nodes', () => {
    const [vmess, vless] = buildLegacyProxies([
      node({ type: 'vmess', uuid: UUID, cipher: 'auto', alterId: 0, tls: true }),
      node({ type: 'vless', name: 'vless', uuid: UUID, tls: true }),
    ]);

    expect(vmess.tls).toBe(true);
    expect(vless.tls).toBe(true);
  });

  it('emits parseable YAML and excludes unsupported nodes by default', () => {
    const output = produceLegacy(
      [
        node({ type: 'ss', cipher: 'aes-256-gcm', password: 'fake-password' }),
        node({ type: 'hysteria2', password: 'fake-password' }),
        node({ type: 'anytls', password: 'fake-password' }),
      ],
      { pretty: true },
    );
    const document = parseYaml(output) as { proxies: ProxyNode[] };

    expect(document.proxies).toHaveLength(1);
    expect(document.proxies[0].type).toBe('ss');
  });
});
