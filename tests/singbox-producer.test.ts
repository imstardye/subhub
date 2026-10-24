// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `singbox` producer golden tests.
 *
 * Each major node type has an exact-`outbound` assertion (so an accidental
 * extra/renamed field is caught), plus a mixed list proving that nodes sing-box
 * cannot express are skipped while the others stay intact.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSingboxOutbounds,
  parseSubscription,
  produceSingbox,
  singboxServerPorts,
  SINGBOX_SUPPORTED_TYPES,
} from '../core';
import type { ProxyNode } from '../core/types';

const UUID = '11111111-2222-3333-4444-555555555555';

function node(overrides: Partial<ProxyNode>): ProxyNode {
  return {
    type: 'ss',
    name: 'fixture',
    server: 'example.com',
    port: 8388,
    ...overrides,
  } as ProxyNode;
}

function outboundOf(single: ProxyNode) {
  const [outbound] = buildSingboxOutbounds([single]);
  expect(outbound).toBeDefined();
  return outbound!;
}

describe('singbox producer: document', () => {
  it('emits a parseable { "outbounds": [...] } JSON document', () => {
    const body = produceSingbox([
      node({ type: 'ss', name: 'ss-1', cipher: 'aes-256-gcm', password: 'fake' }),
    ]);
    const parsed = JSON.parse(body) as { outbounds: Array<Record<string, unknown>> };
    expect(Object.keys(parsed)).toEqual(['outbounds']);
    expect(parsed.outbounds).toHaveLength(1);
    expect(parsed.outbounds[0]).toMatchObject({ type: 'shadowsocks', tag: 'ss-1' });
    // Two-space indented, trailing newline (a file a client can write as-is).
    expect(body.endsWith('\n')).toBe(true);
    expect(body.split('\n')[1]).toBe('  "outbounds": [');
  });

  it('returns an empty-but-valid document when nothing is representable', () => {
    expect(JSON.parse(produceSingbox([]))).toEqual({ outbounds: [] });
    expect(JSON.parse(produceSingbox([node({ type: 'snell', psk: 'fake' })]))).toEqual({
      outbounds: [],
    });
  });

  it('lists the supported types', () => {
    expect([...SINGBOX_SUPPORTED_TYPES]).toEqual([
      'ss',
      'vmess',
      'vless',
      'trojan',
      'tuic',
      'hysteria',
      'hysteria2',
      'anytls',
      'wireguard',
      'socks',
      'http',
    ]);
  });
});

describe('singbox producer: golden outbounds', () => {
  it('shadowsocks (method/password only)', () => {
    expect(
      outboundOf(
        node({ type: 'ss', name: 'SS', server: 'ss.example.com', port: 8388, cipher: 'aes-256-gcm', password: 'fake-pw' }),
      ),
    ).toEqual({
      type: 'shadowsocks',
      tag: 'SS',
      server: 'ss.example.com',
      server_port: 8388,
      method: 'aes-256-gcm',
      password: 'fake-pw',
    });
  });

  it('shadowsocks with the obfs plugin and UDP-over-TCP', () => {
    expect(
      outboundOf(
        node({
          type: 'ss',
          name: 'SS-obfs',
          server: 'ss.example.com',
          port: 8388,
          cipher: 'aes-256-gcm',
          password: 'fake-pw',
          plugin: 'obfs',
          'plugin-opts': { mode: 'tls', host: 'cdn.example.com' },
          'udp-over-tcp': true,
          'udp-over-tcp-version': 2,
        }),
      ),
    ).toEqual({
      type: 'shadowsocks',
      tag: 'SS-obfs',
      server: 'ss.example.com',
      server_port: 8388,
      method: 'aes-256-gcm',
      password: 'fake-pw',
      plugin: 'obfs-local',
      plugin_opts: 'obfs=tls;obfs-host=cdn.example.com',
      udp_over_tcp: { enabled: true, version: 2 },
    });
  });

  it('vmess with ws transport and tls', () => {
    expect(
      outboundOf(
        node({
          type: 'vmess',
          name: 'VMess WS',
          server: 'vm.example.com',
          port: 443,
          uuid: UUID,
          alterId: 0,
          cipher: 'auto',
          tls: true,
          sni: 'sni.example.com',
          network: 'ws',
          'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
        }),
      ),
    ).toEqual({
      type: 'vmess',
      tag: 'VMess WS',
      server: 'vm.example.com',
      server_port: 443,
      uuid: UUID,
      security: 'auto',
      tls: { enabled: true, server_name: 'sni.example.com' },
      transport: { type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' } },
    });
  });

  it('vmess with a non-zero alterId keeps alter_id', () => {
    expect(
      outboundOf(node({ type: 'vmess', uuid: UUID, alterId: 64, cipher: 'chacha20-poly1305' })),
    ).toEqual({
      type: 'vmess',
      tag: 'fixture',
      server: 'example.com',
      server_port: 8388,
      uuid: UUID,
      security: 'chacha20-poly1305',
      alter_id: 64,
    });
  });

  it('vless with XTLS flow, Reality, utls and grpc', () => {
    expect(
      outboundOf(
        node({
          type: 'vless',
          name: 'VLESS-REALITY',
          server: 'vless.example.com',
          port: 443,
          uuid: UUID,
          flow: 'xtls-rprx-vision',
          tls: true,
          sni: 'www.example.com',
          'client-fingerprint': 'chrome',
          'reality-opts': { 'public-key': 'fake-public-key', 'short-id': 'abcd' },
          network: 'grpc',
          'grpc-opts': { 'grpc-service-name': 'grpc-svc' },
        }),
      ),
    ).toEqual({
      type: 'vless',
      tag: 'VLESS-REALITY',
      server: 'vless.example.com',
      server_port: 443,
      uuid: UUID,
      flow: 'xtls-rprx-vision',
      tls: {
        enabled: true,
        server_name: 'www.example.com',
        reality: { enabled: true, public_key: 'fake-public-key', short_id: 'abcd' },
        utls: { enabled: true, fingerprint: 'chrome' },
      },
      transport: { type: 'grpc', service_name: 'grpc-svc' },
    });
  });

  it('vless plain TLS keeps servername, ALPN and insecure', () => {
    expect(
      outboundOf(
        node({
          type: 'vless',
          name: 'VLESS',
          server: 'vless.example.com',
          port: 443,
          uuid: UUID,
          tls: true,
          servername: 'vless.example.com',
          alpn: ['h2', 'http/1.1'],
          'skip-cert-verify': true,
        }),
      ),
    ).toEqual({
      type: 'vless',
      tag: 'VLESS',
      server: 'vless.example.com',
      server_port: 443,
      uuid: UUID,
      tls: {
        enabled: true,
        server_name: 'vless.example.com',
        insecure: true,
        alpn: ['h2', 'http/1.1'],
      },
    });
  });

  it('vless ws early data maps to max_early_data', () => {
    expect(
      outboundOf(
        node({
          type: 'vless',
          uuid: UUID,
          network: 'ws',
          'ws-opts': { path: '/ws', 'max-early-data': 2048, 'early-data-header-name': 'Sec-WebSocket-Protocol' },
        }),
      ).transport,
    ).toEqual({
      type: 'ws',
      path: '/ws',
      max_early_data: 2048,
      early_data_header_name: 'Sec-WebSocket-Protocol',
    });
  });

  it('trojan with implicit TLS and ws', () => {
    expect(
      outboundOf(
        node({
          type: 'trojan',
          name: 'Trojan',
          server: 'trojan.example.com',
          port: 443,
          password: 'fake-password',
          sni: 'sni.example.com',
          'skip-cert-verify': true,
          network: 'ws',
          'ws-opts': { path: '/t', headers: { Host: 'cdn.example.com' } },
        }),
      ),
    ).toEqual({
      type: 'trojan',
      tag: 'Trojan',
      server: 'trojan.example.com',
      server_port: 443,
      password: 'fake-password',
      tls: { enabled: true, server_name: 'sni.example.com', insecure: true },
      transport: { type: 'ws', path: '/t', headers: { Host: 'cdn.example.com' } },
    });
  });

  it('tuic with congestion control, relay mode and h3 ALPN', () => {
    expect(
      outboundOf(
        node({
          type: 'tuic',
          name: 'TUIC',
          server: 'tuic.example.com',
          port: 443,
          uuid: UUID,
          password: 'fake-pass',
          sni: 'tuic.example.com',
          alpn: ['h3'],
          'congestion-controller': 'bbr',
          'udp-relay-mode': 'native',
          'reduce-rtt': true,
          'udp-over-tcp': true,
        }),
      ),
    ).toEqual({
      type: 'tuic',
      tag: 'TUIC',
      server: 'tuic.example.com',
      server_port: 443,
      uuid: UUID,
      password: 'fake-pass',
      congestion_control: 'bbr',
      udp_relay_mode: 'native',
      udp_over_stream: true,
      zero_rtt_handshake: true,
      tls: { enabled: true, server_name: 'tuic.example.com', alpn: ['h3'] },
    });
  });

  it('hysteria v1 requires both bandwidth hints', () => {
    expect(
      outboundOf(
        node({
          type: 'hysteria',
          name: 'HY',
          server: 'hy.example.com',
          port: 8443,
          'auth-str': 'fake-auth',
          up: '50',
          down: '100',
          sni: 'hy.example.com',
        }),
      ),
    ).toEqual({
      type: 'hysteria',
      tag: 'HY',
      server: 'hy.example.com',
      server_port: 8443,
      auth_str: 'fake-auth',
      up_mbps: 50,
      down_mbps: 100,
      tls: { enabled: true, server_name: 'hy.example.com' },
    });
    // No bandwidth values: sing-box cannot load the outbound.
    expect(buildSingboxOutbounds([node({ type: 'hysteria', password: 'fake' })])).toEqual([]);
  });

  it('hysteria2 with obfs, bandwidth and port hopping', () => {
    expect(
      outboundOf(
        node({
          type: 'hysteria2',
          name: 'HY2',
          server: 'hy2.example.com',
          port: 8443,
          password: 'fake-password',
          sni: 'hy2.example.com',
          obfs: 'salamander',
          'obfs-password': 'fake-obfs',
          up: '50',
          down: '100',
          ports: '8443-8445',
        }),
      ),
    ).toEqual({
      type: 'hysteria2',
      tag: 'HY2',
      server: 'hy2.example.com',
      password: 'fake-password',
      obfs: { type: 'salamander', password: 'fake-obfs' },
      up_mbps: 50,
      down_mbps: 100,
      tls: { enabled: true, server_name: 'hy2.example.com' },
      // Port hopping replaces server_port in sing-box.
      server_ports: ['8443:8445'],
    });
  });

  it('anytls with TLS and idle-session tuning', () => {
    expect(
      outboundOf(
        node({
          type: 'anytls',
          name: 'AnyTLS',
          server: 'anytls.example.com',
          port: 443,
          password: 'fake-password',
          sni: 'anytls.example.com',
          'min-idle-session': 2,
          'idle-session-timeout': 60,
          'idle-session-check-interval': 30,
        }),
      ),
    ).toEqual({
      type: 'anytls',
      tag: 'AnyTLS',
      server: 'anytls.example.com',
      server_port: 443,
      password: 'fake-password',
      tls: { enabled: true, server_name: 'anytls.example.com' },
      idle_session_check_interval: '30s',
      idle_session_timeout: '60s',
      min_idle_session: 2,
    });
  });

  it('wireguard keeps the endpoint on the peer', () => {
    expect(
      outboundOf(
        node({
          type: 'wireguard',
          name: 'WG',
          server: 'wg.example.com',
          port: 51820,
          'private-key': 'fake-private-key',
          'public-key': 'fake-public-key',
          'pre-shared-key': 'fake-psk',
          'local-address': ['10.0.0.2/32', 'fd00::2/128'],
          mtu: 1420,
          reserved: [1, 2, 3],
        }),
      ),
    ).toEqual({
      type: 'wireguard',
      tag: 'WG',
      server: 'wg.example.com',
      server_port: 51820,
      private_key: 'fake-private-key',
      peers: [
        {
          server: 'wg.example.com',
          server_port: 51820,
          public_key: 'fake-public-key',
          pre_shared_key: 'fake-psk',
          reserved: [1, 2, 3],
        },
      ],
      local_address: ['10.0.0.2/32', 'fd00::2/128'],
      mtu: 1420,
    });
  });

  it('unauthenticated socks and http dialers', () => {
    expect(
      outboundOf(node({ type: 'socks', name: 'SOCKS', server: 'socks.example.com', port: 1080 })),
    ).toEqual({
      type: 'socks',
      tag: 'SOCKS',
      server: 'socks.example.com',
      server_port: 1080,
    });
    expect(
      outboundOf(node({ type: 'http', name: 'HTTP', server: 'proxy.example.com', port: 8080, tls: true, sni: 'proxy.example.com' })),
    ).toEqual({
      type: 'http',
      tag: 'HTTP',
      server: 'proxy.example.com',
      server_port: 8080,
      tls: { enabled: true, server_name: 'proxy.example.com' },
    });
  });

  it('normalizes ws defaults and h2 host lists like the mihomo producer', () => {
    // A ws node without a path still gets sing-box's required `path`.
    expect(outboundOf(node({ type: 'trojan', password: 'x', network: 'ws' })).transport).toEqual({
      type: 'ws',
      path: '/',
    });
  });
});

describe('singbox producer: skipped nodes', () => {
  it.each([
    ['ssr', { type: 'ssr', cipher: 'aes-128-cfb', password: 'fake', protocol: 'origin', obfs: 'plain' }],
    ['snell', { type: 'snell', psk: 'fake' }],
    ['direct', {}],
    ['unknown type', { type: 'jsons' }],
  ])('skips %s (no sing-box outbound type)', (_label, overrides) => {
    expect(buildSingboxOutbounds([node(overrides)])).toEqual([]);
  });

  it('skips authenticated socks/http proxies instead of dropping the credentials', () => {
    expect(buildSingboxOutbounds([node({ type: 'http', username: 'user', password: 'fake' })])).toEqual([]);
    expect(buildSingboxOutbounds([node({ type: 'socks5', username: 'user' })])).toEqual([]);
  });

  it('skips nodes with an unusable endpoint or missing credential', () => {
    expect(buildSingboxOutbounds([node({ server: '' })])).toEqual([]);
    expect(buildSingboxOutbounds([node({ port: 0 })])).toEqual([]);
    expect(buildSingboxOutbounds([node({ port: Number.NaN })])).toEqual([]);
    expect(buildSingboxOutbounds([node({ type: 'vless' })])).toEqual([]);
    expect(buildSingboxOutbounds([node({ type: 'wireguard', 'private-key': 'k' })])).toEqual([]);
  });

  it('skips transports sing-box has no field for in that outbound', () => {
    expect(
      buildSingboxOutbounds([node({ type: 'vless', uuid: UUID, network: 'h2', 'h2-opts': { path: '/h2' } })]),
    ).toEqual([]);
    expect(buildSingboxOutbounds([node({ type: 'trojan', password: 'x', network: 'kcp' })])).toEqual([]);
  });

  it('skips Reality without a public key (sing-box would reject it)', () => {
    expect(buildSingboxOutbounds([node({ type: 'vless', uuid: UUID, 'reality-opts': {} })])).toEqual([]);
  });

  it('skips an unknown SIP003 plugin rather than writing a plugin sing-box cannot load', () => {
    expect(buildSingboxOutbounds([node({ type: 'ss', cipher: 'aes-256-gcm', password: 'x', plugin: 'mystery' })])).toEqual([]);
  });

  it('keeps the representable nodes of a mixed list intact and in order', () => {
    const nodes = parseSubscription(`
proxies:
  - {name: SS, type: ss, server: ss.example.com, port: 8388, cipher: "aes-256-gcm", password: "fake"}
  - {name: SSR, type: ssr, server: ssr.example.com, port: 8388, cipher: "aes-128-cfb", password: "fake", protocol: origin, obfs: plain}
  - {name: Snell, type: snell, server: snell.example.com, port: 8388, psk: "fake"}
  - {name: Trojan, type: trojan, server: trojan.example.com, port: 443, password: "fake", sni: trojan.example.com}
  - {name: HY2, type: hysteria2, server: hy2.example.com, port: 443, password: "fake"}
`);

    const parsed = JSON.parse(produceSingbox(nodes)) as { outbounds: Array<Record<string, unknown>> };
    expect(parsed.outbounds.map((entry) => entry.tag)).toEqual(['SS', 'Trojan', 'HY2']);
    expect(parsed.outbounds[0]).toEqual({
      type: 'shadowsocks',
      tag: 'SS',
      server: 'ss.example.com',
      server_port: 8388,
      method: 'aes-256-gcm',
      password: 'fake',
    });
    expect(parsed.outbounds[2]).toEqual({
      type: 'hysteria2',
      tag: 'HY2',
      server: 'hy2.example.com',
      server_port: 443,
      password: 'fake',
      tls: { enabled: true },
    });
  });
});

describe('singbox producer: helpers', () => {
  it.each([
    ['9000-9010', ['9000:9010']],
    ['9000,9002', ['9000', '9002']],
    ['9000-9010,9012', ['9000:9010', '9012']],
  ])('converts port hops %s', (input, expected) => {
    expect(singboxServerPorts(input)).toEqual(expected);
  });

  it.each(['', 'not-a-range', '9010-9000', '0-10', '1-70000', '9000-'])('rejects %s', (input) => {
    expect(singboxServerPorts(input)).toBeUndefined();
  });
});
