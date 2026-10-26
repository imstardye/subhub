// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shadowrocket producer: base64 of newline-joined share links.
 *
 * Ground truth is the repo's own URI parser: every produced link is parsed back
 * with `parseUri` and must yield the same node, which is what makes the output
 * genuine Shadowrocket input rather than an approximation.
 */
import { describe, expect, it } from 'vitest';
import type { ProxyNode } from '../core/types';
import { parseSubscription, parseUri } from '../core/parsers';
import {
  buildShadowrocketLinks,
  buildShadowrocketSubscription,
  produceShadowrocket,
  shadowrocketLink,
} from '../core/producers';
import { decodeBase64 } from '../core/utils';

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

/** Decode a produced body into its individual links. */
function linksOf(body: string): string[] {
  const decoded = decodeBase64(body);
  return decoded ? decoded.split('\n').filter(Boolean) : [];
}

describe('Shadowrocket producer: link shapes', () => {
  it('emits SIP002 Shadowsocks links', () => {
    expect(
      shadowrocketLink(node({ name: 'SS', cipher: 'aes-256-gcm', password: 'fake-password' })),
    ).toEqual({
      line: `ss://${Buffer.from('aes-256-gcm:fake-password').toString('base64url')}@example.com:8388#SS`,
    });
  });

  it('keeps Shadowsocks plugins (SIP002 plugin=)', () => {
    const built = shadowrocketLink(
      node({
        name: 'SS-OBFS',
        cipher: 'aes-128-gcm',
        password: 'p',
        plugin: 'obfs',
        'plugin-opts': { mode: 'http', host: 'obfs.example.com' },
      }),
    );
    expect(built).toEqual({
      line: `ss://${Buffer.from('aes-128-gcm:p').toString('base64url')}@example.com:8388?plugin=simple-obfs%3Bobfs%3Dhttp%3Bobfs-host%3Dobfs.example.com#SS-OBFS`,
    });
  });

  it('emits V2rayN JSON VMess links', () => {
    const built = shadowrocketLink(
      node({
        type: 'vmess',
        name: 'VM',
        port: 443,
        uuid: UUID,
        tls: true,
        sni: 'vm.example.com',
        network: 'ws',
        'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
      }),
    );
    if (!('line' in built)) throw new Error('expected a link');

    expect(built.line.startsWith('vmess://')).toBe(true);
    const payload = JSON.parse(decodeBase64(built.line.slice('vmess://'.length))) as Record<string, unknown>;
    expect(payload).toMatchObject({
      v: '2',
      ps: 'VM',
      add: 'example.com',
      port: '443',
      id: UUID,
      aid: '0',
      scy: 'auto',
      net: 'ws',
      host: 'cdn.example.com',
      path: '/ws',
      tls: 'tls',
      sni: 'vm.example.com',
    });
  });

  it('emits VLESS, Trojan, Hysteria2, TUIC and AnyTLS URIs', () => {
    expect(
      shadowrocketLink(node({ type: 'vless', name: 'V', port: 443, uuid: UUID, tls: true, sni: 'v.example.com' })),
    ).toEqual({
      line: `vless://${UUID}@example.com:443?encryption=none&security=tls&sni=v.example.com#V`,
    });
    expect(
      shadowrocketLink(node({ type: 'trojan', name: 'T', port: 443, password: 'fake-pw', sni: 't.example.com' })),
    ).toEqual({ line: 'trojan://fake-pw@example.com:443?security=tls&sni=t.example.com#T' });
    expect(
      shadowrocketLink(node({ type: 'hysteria2', name: 'H', port: 443, password: 'fake-pw', sni: 'h.example.com' })),
    ).toEqual({ line: 'hysteria2://fake-pw@example.com:443?sni=h.example.com#H' });
    expect(
      shadowrocketLink(node({ type: 'tuic', name: 'U', port: 443, uuid: UUID, password: 'fake-pw' })),
    ).toEqual({ line: `tuic://${UUID}%3Afake-pw@example.com:443#U` });
    expect(shadowrocketLink(node({ type: 'anytls', name: 'A', port: 443, password: 'fake-pw' }))).toEqual({
      line: 'anytls://fake-pw@example.com:443#A',
    });
  });

  it('emits SSR links', () => {
    const built = shadowrocketLink(
      node({
        type: 'ssr',
        name: 'SSR',
        cipher: 'aes-256-cfb',
        password: 'fake',
        protocol: 'auth_aes128_md5',
        obfs: 'tls1.2_ticket_auth',
      }),
    );
    if (!('line' in built)) throw new Error('expected a link');
    expect(decodeBase64(built.line.slice('ssr://'.length))).toBe(
      `example.com:8388:auth_aes128_md5:aes-256-cfb:tls1.2_ticket_auth:${Buffer.from(
        'fake',
      ).toString('base64')}/?remarks=${Buffer.from('SSR').toString('base64')}`,
    );
  });

  it('emits SOCKS/HTTP proxies and brackets IPv6 hosts', () => {
    expect(shadowrocketLink(node({ type: 'socks5', name: 'S', port: 1080, username: 'u', password: 'p' }))).toEqual({
      line: 'socks://u:p@example.com:1080#S',
    });
    expect(shadowrocketLink(node({ type: 'http', name: 'H', port: 8080 }))).toEqual({
      line: 'http://example.com:8080#H',
    });
    expect(shadowrocketLink(node({ type: 'http', name: 'H', port: 8080, tls: true }))).toEqual({
      line: 'https://example.com:8080#H',
    });
    expect(
      shadowrocketLink(node({ name: 'v6', server: '2001:db8::1', cipher: 'aes-128-gcm', password: 'p' })),
    ).toEqual({
      line: `ss://${Buffer.from('aes-128-gcm:p').toString('base64url')}@[2001:db8::1]:8388#v6`,
    });
  });
});

describe('Shadowrocket producer: mieru', () => {
  const fixture = node({
    type: 'mieru',
    name: 'JP mieru',
    server: 'jp.example.com',
    port: 8443,
    username: 'user-1',
    password: 'fake-password',
    transport: 'TCP',
  });
  const expected =
    'mierus://user-1:fake-password@jp.example.com?profile=JP%20mieru&port=8443&protocol=TCP';

  it('emits the mierus link in the subscription output', () => {
    expect(shadowrocketLink(fixture)).toEqual({ line: expected });
    expect(buildShadowrocketSubscription([fixture])).toMatchObject({
      lines: [expected],
      names: ['JP mieru'],
    });
    expect(linksOf(produceShadowrocket([fixture]))).toEqual([expected]);
  });

  it('counts a password-less mieru node as skipped', () => {
    const result = buildShadowrocketSubscription([
      { ...fixture, password: undefined } as ProxyNode,
    ]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'JP mieru', reason: 'missing or unrepresentable protocol options' },
    ]);
  });
});

describe('Shadowrocket producer: round trip through the repo URI parser', () => {
  const nodes: ProxyNode[] = [
    node({ name: 'SS', cipher: 'chacha20-ietf-poly1305', password: 'fake-password' }),
    node({
      name: 'SS-Plugin',
      cipher: 'aes-128-gcm',
      password: 'p',
      plugin: 'v2ray-plugin',
      'plugin-opts': { mode: 'websocket', host: 'cdn.example.com', path: '/v2', tls: true },
    }),
    node({
      name: 'SSR',
      type: 'ssr',
      cipher: 'aes-256-cfb',
      password: 'fake',
      protocol: 'origin',
      obfs: 'plain',
    }),
    node({
      name: 'VM-WS',
      type: 'vmess',
      port: 443,
      uuid: UUID,
      tls: true,
      sni: 'vm.example.com',
      network: 'ws',
      'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    }),
    node({
      name: 'VLESS',
      type: 'vless',
      port: 443,
      uuid: UUID,
      tls: true,
      sni: 'v.example.com',
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': 'svc' },
    }),
    node({ name: 'Trojan', type: 'trojan', port: 443, password: 'fake-pw', sni: 't.example.com' }),
    node({ name: 'HY2', type: 'hysteria2', port: 443, password: 'fake-pw', sni: 'h.example.com' }),
    node({ name: 'TUIC', type: 'tuic', port: 443, uuid: UUID, password: 'fake-pw', sni: 'u.example.com' }),
    node({ name: 'AnyTLS', type: 'anytls', port: 443, password: 'fake-pw', sni: 'a.example.com' }),
    node({
      name: 'Mieru',
      type: 'mieru',
      port: 8443,
      username: 'user-1',
      password: 'fake-pw',
      transport: 'UDP',
    }),
  ];

  it('produces one parseable link per node with the same name and server', () => {
    const links = buildShadowrocketLinks(nodes);
    expect(links).toHaveLength(nodes.length);

    const parsed = links.map((line) => parseUri(line)!);
    expect(parsed.map((entry) => entry.name)).toEqual(nodes.map((entry) => entry.name));
    expect(parsed.map((entry) => entry.type)).toEqual(nodes.map((entry) => entry.type));
    for (const [index, entry] of parsed.entries()) {
      expect(entry.server).toBe(nodes[index]!.server);
      expect(entry.port).toBe(nodes[index]!.port);
    }
  });

  it('preserves credentials and transport details across the round trip', () => {
    const [ss, vm] = buildShadowrocketLinks([nodes[0]!, nodes[3]!]).map((line) => parseUri(line)!);
    expect(ss).toMatchObject({ cipher: 'chacha20-ietf-poly1305', password: 'fake-password' });
    expect(vm).toMatchObject({
      uuid: UUID,
      tls: true,
      sni: 'vm.example.com',
      network: 'ws',
      'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    });
  });
});

describe('Shadowrocket producer: Hysteria2 port hopping and bandwidth', () => {
  it('emits mport for a node with `ports` instead of skipping it', () => {
    const built = shadowrocketLink(
      node({ type: 'hysteria2', name: 'HY2-hop', port: 443, password: 'fake-pw', ports: '60000-62000' }),
    );
    if (!('line' in built)) throw new Error('expected a link');
    expect(built.line).toBe('hysteria2://fake-pw@example.com:443?mport=60000-62000#HY2-hop');

    // Round trip: the repo's own parser reads the range back.
    expect(parseUri(built.line)).toMatchObject({
      type: 'hysteria2',
      name: 'HY2-hop',
      server: 'example.com',
      port: 443,
      password: 'fake-pw',
      ports: '60000-62000',
    });
  });

  it('keeps every hop/bandwidth variant in the round trip', () => {
    const links = buildShadowrocketLinks([
      node({ type: 'hysteria2', name: 'hy-range', password: 'pw', ports: '60000-62000' }),
      node({ type: 'hysteria2', name: 'hy-list', password: 'pw', ports: '60000,61000-62000' }),
      node({ type: 'hysteria2', name: 'hy-bw', password: 'pw', up: 50, down: '200' }),
      node({
        type: 'hysteria2',
        name: 'hy-all',
        password: 'pw',
        ports: '443-65535',
        up: '30',
        down: '120',
        'hop-interval': 30,
        sni: 'h.example.com',
      }),
    ]);
    expect(links).toHaveLength(4);

    const parsed = links.map((line) => parseUri(line)!);
    expect(parsed.map((entry) => entry.name)).toEqual(['hy-range', 'hy-list', 'hy-bw', 'hy-all']);
    expect(parsed[0]).toMatchObject({ ports: '60000-62000' });
    expect(parsed[1]).toMatchObject({ ports: '60000,61000-62000' });
    expect(parsed[2]).toMatchObject({ up: '50', down: '200' });
    expect(parsed[3]).toMatchObject({
      ports: '443-65535',
      up: '30',
      down: '120',
      'hop-interval': '30',
      sni: 'h.example.com',
    });
    expect(parsed[2]!.ports).toBeUndefined();
  });

  it('matches uri.ts field for field for hy2 port hopping', () => {
    const nodes = [
      node({ type: 'hysteria2', name: 'hy-hop', password: 'pw', ports: '60000,61000-62000' }),
      node({ type: 'hysteria2', name: 'hy-bw', password: 'pw', up: 10, down: 20 }),
    ];
    const links = buildShadowrocketLinks(nodes);
    const [hop, bw] = links;
    expect(hop).toContain('mport=60000%2C61000-62000');
    expect(bw).toContain('upmbps=10');
    expect(bw).toContain('downmbps=20');
  });
});

describe('Shadowrocket producer: document', () => {
  it('returns base64 of newline-joined links (Content-Type text/plain owners)', () => {
    const body = produceShadowrocket([
      node({ name: 'A', cipher: 'aes-128-gcm', password: 'p' }),
      node({ name: 'B', cipher: 'aes-128-gcm', password: 'p' }),
    ]);

    // Nothing but base64: no YAML, no raw `://`.
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const links = linksOf(body);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('#A');
    expect(links[1]).toContain('#B');
    // And the base64 payload is itself a valid subscription.
    expect(parseSubscription(body).map((entry) => entry.name)).toEqual(['A', 'B']);
  });

  it('skips nodes without a share-link form and never fakes one', () => {
    const result = buildShadowrocketLinks([
      node({ type: 'snell', name: 'snell', cipher: 'aes-128-gcm', password: 'p', psk: 'k' }),
      node({ name: 'chained', cipher: 'aes-128-gcm', password: 'p', 'dialer-proxy': 'other' }),
      node({ name: 'kept', cipher: 'aes-128-gcm', password: 'p' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('#kept');
  });

  it('returns an empty (valid) document when nothing is representable', () => {
    const body = produceShadowrocket([node({ type: 'snell', name: 'snell', password: 'p' })]);
    expect(body).toBe('');
    expect(linksOf(body)).toEqual([]);
  });
});

describe('Shadowrocket producer: link validity regressions', () => {
  it('emits SSR links with no #fragment (the base64 payload is the whole link)', () => {
    const built = shadowrocketLink(
      node({
        type: 'ssr',
        name: 'SSR',
        cipher: 'aes-256-cfb',
        password: 'fake',
        protocol: 'origin',
        obfs: 'plain',
      }),
    );
    if (!('line' in built)) throw new Error('expected a link');

    expect(built.line).not.toContain('#');
    // A fragment would make the payload undecodable — this is the regression
    // this test exists for: parse-back must still see the node (and its name).
    expect(parseUri(built.line)).toMatchObject({ type: 'ssr', name: 'SSR', server: 'example.com' });
  });

  it('skips nodes whose options the link format cannot carry faithfully', () => {
    const skipped = [
      // Hysteria2 has no UUID: such a node is not a hy2 link at all.
      node({ type: 'hysteria2', name: 'hy-uuid', password: 'p', uuid: UUID }),
      // TUIC needs `uuid:password`; a bare password has no user info.
      node({ type: 'tuic', name: 'tuic-pw', password: 'p' }),
      node({ type: 'anytls', name: 'anytls-uuid', password: 'p', uuid: UUID }),
      // `http` transport options live in `http-opts`, which the V2Ray query
      // writer does not read (it would emit the ws values instead).
      node({ type: 'vless', name: 'vless-http', uuid: UUID, network: 'http' }),
      node({ type: 'vmess', name: 'vmess-http', uuid: UUID, network: 'http' }),
      node({ type: 'trojan', name: 'trojan-http', password: 'p', network: 'http' }),
    ];

    for (const entry of skipped) {
      expect(shadowrocketLink(entry), String(entry.name)).toEqual({
        skipped: 'missing or unrepresentable protocol options',
      });
    }
  });

  it('keeps the transports it does write (ws/grpc/h2) round-tripping', () => {
    const links = buildShadowrocketLinks([
      node({
        type: 'vmess',
        name: 'vm-h2',
        uuid: UUID,
        port: 443,
        network: 'h2',
        'h2-opts': { host: ['a.example.com'], path: '/h2' },
      }),
      node({
        type: 'vless',
        name: 'vless-grpc',
        uuid: UUID,
        port: 443,
        network: 'grpc',
        'grpc-opts': { 'grpc-service-name': 'svc' },
      }),
    ]);
    const parsed = links.map((line) => parseUri(line)!);
    expect(parsed[0]).toMatchObject({ network: 'h2', 'h2-opts': { path: '/h2' } });
    expect(parsed[1]).toMatchObject({ network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'svc' } });
  });

  it('drops duplicate names (Shadowrocket keeps one entry per name)', () => {
    const result = buildShadowrocketSubscription([
      node({ name: 'dup', cipher: 'aes-128-gcm', password: 'first' }),
      node({ name: 'dup', cipher: 'aes-128-gcm', password: 'second' }),
    ]);
    expect(result.names).toEqual(['dup']);
    expect(result.skipped).toEqual([{ name: 'dup', reason: 'duplicate name' }]);
    // The kept link is the first one, not a silent last-wins.
    expect(parseUri(result.lines[0]!)).toMatchObject({ name: 'dup', password: 'first' });
  });
});
