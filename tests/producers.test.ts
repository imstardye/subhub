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
import { buildMihomoProxies, produceMihomo } from '../core/producers';

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

describe('legacy Clash producer removal', () => {
  it('no longer exports a filtering legacy Clash producer', async () => {
    // `clash` is rendered by the mihomo producer (see export-nodes.ts), so the
    // legacy whitelist that dropped vless/anytls/tuic/hysteria2 is gone rather
    // than left behind as dead code.
    const producers = await import('../core/producers');
    expect('buildLegacyProxies' in producers).toBe(false);
    expect('produceLegacy' in producers).toBe(false);
  });
});
