// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `uri` producer round-trip tests.
 *
 * The standard is the repo's own share-link parser: every emitted link is
 * decoded again with `parseUri` / `parseSubscription` and the key fields must
 * survive (type, server, port, credential, name, transport/TLS options).
 */
import { describe, expect, it } from 'vitest';
import {
  buildShareLinks,
  encodeBase64,
  isShareLink,
  parseShadowsocks,
  parseSubscription,
  parseUri,
  produceUri,
  URI_SUPPORTED_TYPES,
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

/** Decode the export body and return its lines (what a client would read). */
function linksOf(body: string): string[] {
  const decoded = Buffer.from(body, 'base64').toString('utf8');
  return decoded === '' ? [] : decoded.split('\n');
}

/** Produce a single link and parse it back through the public URI entry point. */
function roundTrip(single: ProxyNode): ProxyNode {
  const [link] = buildShareLinks([single]);
  expect(link).toBeTypeOf('string');
  return parseUri(link!)!;
}

describe('uri producer: body encoding', () => {
  it('base64-encodes newline-joined links with standard, padded output', () => {
    const body = produceUri([
      node({ name: 'one', type: 'ss', cipher: 'aes-256-gcm', password: 'a' }),
      node({ name: 'two', type: 'trojan', password: 'b', port: 443 }),
      node({ name: 'three', type: 'anytls', password: 'c', port: 443 }),
    ]);

    // Standard alphabet, no line breaks, canonical padding.
    expect(body).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect((body.match(/=/g) ?? []).length).toBeLessThanOrEqual(2);
    expect(body.length % 4).toBe(0);
    expect(Buffer.from(body, 'base64').toString('base64')).toBe(body);

    const links = linksOf(body);
    expect(links).toHaveLength(3);
    expect(links[0]!.startsWith('ss://')).toBe(true);
    expect(links[1]!.startsWith('trojan://')).toBe(true);
    expect(links[2]!.startsWith('anytls://')).toBe(true);
  });

  it('returns the base64 of an empty string when nothing is representable', () => {
    expect(produceUri([])).toBe('');
    expect(produceUri([node({ type: 'snell', psk: 'x' })])).toBe('');
    expect(produceUri([node({ type: 'http', username: 'u', password: 'p' })])).toBe('');
    expect(linksOf(produceUri([]))).toEqual([]);
  });

  it('is readable by the repo subscription parser (type order preserved)', () => {
    const nodes = [
      node({ type: 'ss', name: 'a', cipher: 'aes-128-gcm', password: 'fake' }),
      node({ type: 'trojan', name: 'b', password: 'fake', port: 443 }),
      node({ type: 'anytls', name: 'c', password: 'fake', port: 443 }),
    ];
    const parsed = parseSubscription(produceUri(nodes));
    expect(parsed.map((entry) => [entry.type, entry.name])).toEqual([
      ['ss', 'a'],
      ['trojan', 'b'],
      ['anytls', 'c'],
    ]);
  });
});

describe('uri producer: skipped types', () => {
  it('covers exactly the parser-supported set', () => {
    expect([...URI_SUPPORTED_TYPES]).toEqual([
      'ss',
      'ssr',
      'vmess',
      'vless',
      'trojan',
      'hysteria2',
      'tuic',
      'anytls',
      'mieru',
    ]);
  });

  it.each([
    ['socks', { type: 'socks', username: 'user', password: 'fake' }],
    ['socks5', { type: 'socks5' }],
    ['http', { type: 'http', username: 'user', password: 'fake' }],
    ['snell', { type: 'snell', psk: 'fake' }],
    ['wireguard', { type: 'wireguard', 'private-key': 'k', 'public-key': 'p' }],
    ['hysteria (v1)', { type: 'hysteria', password: 'fake' }],
    ['direct', { type: 'direct' }],
  ])('skips %s nodes instead of faking a link', (_label, overrides) => {
    expect(buildShareLinks([node(overrides)])).toEqual([]);
  });

  it('skips the unrepresentable nodes and keeps the rest in order', () => {
    const nodes = [
      node({ type: 'ss', name: 'ss-keep', cipher: 'aes-256-gcm', password: 'fake' }),
      node({ type: 'snell', name: 'snell-drop', psk: 'fake' }),
      node({ type: 'trojan', name: 'trojan-keep', password: 'fake' }),
    ];
    const parsed = parseSubscription(produceUri(nodes));
    expect(parsed.map((entry) => entry.name)).toEqual(['ss-keep', 'trojan-keep']);
  });

  it('skips nodes with an unusable endpoint or missing credential', () => {
    expect(buildShareLinks([node({ server: '' })])).toEqual([]);
    expect(buildShareLinks([node({ port: 0 })])).toEqual([]);
    expect(buildShareLinks([node({ port: 70000 })])).toEqual([]);
    expect(buildShareLinks([node({ name: '' })])).toEqual([]);
    expect(buildShareLinks([node({ type: 'vless', uuid: '' })])).toEqual([]);
    expect(buildShareLinks([node({ type: 'ss', cipher: undefined as unknown as string })])).toEqual([]);
  });

  it('skips a node whose generated link the parser would reject', () => {
    // A port range the parser cannot read must not put a broken link into the
    // subscription; the node is dropped instead.
    const broken = node({
      type: 'hysteria2',
      name: 'bad-range',
      password: 'fake',
      ports: 'not-a-range',
    });
    const good = node({ type: 'tuic', name: 'good', uuid: UUID, password: 'fake', port: 443 });
    const links = buildShareLinks([broken, good]);

    expect(links).toHaveLength(1);
    expect(parseUri(links[0]!)).toMatchObject({ type: 'tuic', name: 'good', uuid: UUID });
  });
});

describe('uri producer: Shadowsocks', () => {
  it('round-trips SIP002 userinfo, name and endpoint', () => {
    const back = roundTrip(
      node({
        type: 'ss',
        name: 'SS 香港 01',
        server: 'ss.example.com',
        port: 8388,
        cipher: 'aes-256-gcm',
        password: 'p@ss:w/ord=x&y#z?',
      }),
    );

    expect(back).toMatchObject({
      type: 'ss',
      name: 'SS 香港 01',
      server: 'ss.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'p@ss:w/ord=x&y#z?',
    });
  });

  it('emits base64url userinfo without padding (SIP002)', () => {
    const [link] = buildShareLinks([
      node({ type: 'ss', cipher: 'aes-128-gcm', password: 'fake-password' }),
    ]);
    const userInfo = link!.slice('ss://'.length).split('@')[0]!;
    expect(userInfo).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseShadowsocks(link!).password).toBe('fake-password');
  });

  it('round-trips the obfs plugin and UDP-over-TCP', () => {
    const back = roundTrip(
      node({
        type: 'ss',
        name: 'SS-obfs',
        cipher: 'aes-256-gcm',
        password: 'fake',
        plugin: 'obfs',
        'plugin-opts': { mode: 'tls', host: 'cdn.example.com' },
        'udp-over-tcp': true,
        'udp-over-tcp-version': 2,
      }),
    );

    expect(back).toMatchObject({
      type: 'ss',
      name: 'SS-obfs',
      plugin: 'obfs',
      'plugin-opts': { mode: 'tls', host: 'cdn.example.com' },
      'udp-over-tcp': true,
      'udp-over-tcp-version': 2,
    });
  });

  it('round-trips the v2ray-plugin options', () => {
    const back = roundTrip(
      node({
        type: 'ss',
        name: 'SS-v2',
        cipher: 'aes-256-gcm',
        password: 'fake',
        plugin: 'v2ray-plugin',
        'plugin-opts': { mode: 'websocket', host: 'cdn.example.com', path: '/ws', tls: true, mux: true },
      }),
    );

    expect(back.plugin).toBe('v2ray-plugin');
    expect(back['plugin-opts']).toEqual({
      mode: 'websocket',
      host: 'cdn.example.com',
      path: '/ws',
      tls: true,
      mux: true,
    });
  });

  it('brackets IPv6 servers', () => {
    const [link] = buildShareLinks([
      node({ type: 'ss', server: '2001:db8::1', cipher: 'aes-128-gcm', password: 'fake' }),
    ]);
    expect(link).toContain('@[2001:db8::1]:8388');
    expect(parseShadowsocks(link!)).toMatchObject({ server: '2001:db8::1', port: 8388 });
  });
});

describe('uri producer: ShadowsocksR', () => {
  it('round-trips protocol/obfs parameters, name and group', () => {
    const back = roundTrip(
      node({
        type: 'ssr',
        name: 'SSR 节点',
        server: 'ssr.example.com',
        port: 8388,
        cipher: 'aes-128-cfb',
        password: 'fake-password',
        protocol: 'auth_aes128_md5',
        'protocol-param': '1234:abcd',
        obfs: 'tls1.2_ticket_auth',
        'obfs-param': 'cdn.example.com',
        group: 'fixture-group',
      }),
    );

    expect(back).toMatchObject({
      type: 'ssr',
      name: 'SSR 节点',
      server: 'ssr.example.com',
      port: 8388,
      cipher: 'aes-128-cfb',
      password: 'fake-password',
      protocol: 'auth_aes128_md5',
      'protocol-param': '1234:abcd',
      obfs: 'tls1.2_ticket_auth',
      'obfs-param': 'cdn.example.com',
      group: 'fixture-group',
    });
  });
});

describe('uri producer: VMess', () => {
  it('round-trips uuid, aid, cipher, TLS/SNI and ws transport', () => {
    const back = roundTrip(
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
    );

    expect(back).toMatchObject({
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
    });
  });

  it('round-trips ALPN, fingerprint, insecure and grpc service name', () => {
    const back = roundTrip(
      node({
        type: 'vmess',
        name: 'VMess gRPC',
        server: 'vm.example.com',
        port: 443,
        uuid: UUID,
        alterId: 0,
        cipher: 'auto',
        tls: true,
        sni: 'sni.example.com',
        alpn: ['h2', 'http/1.1'],
        'client-fingerprint': 'chrome',
        'skip-cert-verify': true,
        network: 'grpc',
        'grpc-opts': { 'grpc-service-name': 'grpc-svc' },
      }),
    );

    expect(back).toMatchObject({
      type: 'vmess',
      uuid: UUID,
      tls: true,
      sni: 'sni.example.com',
      alpn: ['h2', 'http/1.1'],
      'client-fingerprint': 'chrome',
      'skip-cert-verify': true,
      network: 'grpc',
      'grpc-opts': { 'grpc-service-name': 'grpc-svc' },
    });
  });

  it('uses the V2rayN JSON form clients expect', () => {
    const [link] = buildShareLinks([node({ type: 'vmess', uuid: UUID, alterId: 0 })]);
    const payload = JSON.parse(Buffer.from(link!.slice('vmess://'.length), 'base64').toString('utf8'));
    expect(payload).toMatchObject({ v: '2', add: 'example.com', port: '8388', id: UUID, aid: '0' });
    expect(link!.includes('@')).toBe(false);
  });
});

describe('uri producer: VLESS (incl. Reality)', () => {
  it('round-trips Reality pbk/sid, flow, sni, fp and ws transport', () => {
    const back = roundTrip(
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
        network: 'ws',
        'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
      }),
    );

    expect(back).toMatchObject({
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
      network: 'ws',
      'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
    });
  });

  it('emits the standard query keys (security/sni/pbk/sid/flow/type)', () => {
    const [link] = buildShareLinks([
      node({
        type: 'vless',
        uuid: UUID,
        port: 443,
        flow: 'xtls-rprx-vision',
        'reality-opts': { 'public-key': 'pbk-value', 'short-id': 'abcd' },
        'client-fingerprint': 'firefox',
      }),
    ]);
    const url = new URL(link!);
    expect(url.protocol).toBe('vless:');
    expect(url.username).toBe(UUID);
    expect(url.searchParams.get('security')).toBe('reality');
    expect(url.searchParams.get('pbk')).toBe('pbk-value');
    expect(url.searchParams.get('sid')).toBe('abcd');
    expect(url.searchParams.get('fp')).toBe('firefox');
    expect(url.searchParams.get('flow')).toBe('xtls-rprx-vision');
    expect(url.searchParams.get('encryption')).toBe('none');
  });

  it('round-trips plain TLS, early data, ALPN and h2 host lists', () => {
    const back = roundTrip(
      node({
        type: 'vless',
        name: 'VLESS-H2',
        server: 'vless.example.com',
        port: 443,
        uuid: UUID,
        tls: true,
        sni: 'vless.example.com',
        alpn: ['h2'],
        network: 'h2',
        'h2-opts': { host: ['a.example.com', 'b.example.com'], path: '/h2' },
      }),
    );
    expect(back).toMatchObject({
      type: 'vless',
      tls: true,
      sni: 'vless.example.com',
      alpn: ['h2'],
      network: 'h2',
      'h2-opts': { host: ['a.example.com', 'b.example.com'], path: '/h2' },
    });

    const ws = roundTrip(
      node({
        type: 'vless',
        name: 'VLESS-ED',
        server: 'vless.example.com',
        port: 443,
        uuid: UUID,
        tls: true,
        network: 'ws',
        'ws-opts': { path: '/ws', 'max-early-data': 2048 },
      }),
    );
    expect(ws['ws-opts']).toMatchObject({ path: '/ws', 'max-early-data': 2048 });
  });

  it('keeps an insecure flag and IPv6 servers', () => {
    const back = roundTrip(
      node({
        type: 'vless',
        name: 'VLESS-v6',
        server: '2001:db8::10',
        port: 443,
        uuid: UUID,
        tls: true,
        'skip-cert-verify': true,
      }),
    );
    expect(back).toMatchObject({ server: '2001:db8::10', 'skip-cert-verify': true });
  });
});

describe('uri producer: Trojan', () => {
  it('round-trips password, TLS/SNI, insecure and ws transport', () => {
    const back = roundTrip(
      node({
        type: 'trojan',
        name: 'Trojan-WS',
        server: 'trojan.example.com',
        port: 443,
        password: 'fake-password',
        sni: 'sni.example.com',
        'skip-cert-verify': true,
        network: 'ws',
        'ws-opts': { path: '/t', headers: { Host: 'cdn.example.com' } },
      }),
    );

    expect(back).toMatchObject({
      type: 'trojan',
      name: 'Trojan-WS',
      server: 'trojan.example.com',
      port: 443,
      password: 'fake-password',
      tls: true,
      sni: 'sni.example.com',
      'skip-cert-verify': true,
      network: 'ws',
      'ws-opts': { path: '/t', headers: { Host: 'cdn.example.com' } },
    });
  });

  it('round-trips ALPN and a bracketed IPv6 server', () => {
    const back = roundTrip(
      node({
        type: 'trojan',
        name: 'Trojan-ALPN',
        server: '2001:db8::1',
        port: 443,
        password: 'pw@example.com',
        alpn: ['h2', 'http/1.1'],
      }),
    );
    expect(back).toMatchObject({
      server: '2001:db8::1',
      password: 'pw@example.com',
      alpn: ['h2', 'http/1.1'],
    });
  });
});

describe('uri producer: TUIC', () => {
  it('round-trips uuid/password, ALPN, congestion and relay mode', () => {
    const back = roundTrip(
      node({
        type: 'tuic',
        name: 'TUIC',
        server: 'tuic.example.com',
        port: 443,
        uuid: UUID,
        password: 'fake-pass:with-colon',
        sni: 'tuic.example.com',
        alpn: ['h3'],
        'congestion-controller': 'bbr',
        'udp-relay-mode': 'native',
        'skip-cert-verify': true,
        'reduce-rtt': true,
        'disable-sni': false,
      }),
    );

    expect(back).toMatchObject({
      type: 'tuic',
      name: 'TUIC',
      server: 'tuic.example.com',
      port: 443,
      uuid: UUID,
      password: 'fake-pass:with-colon',
      sni: 'tuic.example.com',
      alpn: ['h3'],
      'congestion-controller': 'bbr',
      'udp-relay-mode': 'native',
      'skip-cert-verify': true,
      'reduce-rtt': true,
    });
  });

  it('round-trips heartbeat, tfo and UDP-over-TCP', () => {
    const back = roundTrip(
      node({
        type: 'tuic',
        name: 'TUIC-tuning',
        server: 'tuic.example.com',
        port: 443,
        uuid: UUID,
        password: 'fake',
        tfo: true,
        'heartbeat-interval': '10000',
        'udp-over-tcp': true,
        'udp-over-tcp-version': 2,
        token: 'fake-token',
      }),
    );
    expect(back).toMatchObject({
      tfo: true,
      'heartbeat-interval': '10000',
      'udp-over-tcp': true,
      'udp-over-tcp-version': 2,
      token: 'fake-token',
    });
  });
});

describe('uri producer: Hysteria2', () => {
  it('round-trips password, obfs, SNI, insecure and bandwidth hints', () => {
    const back = roundTrip(
      node({
        type: 'hysteria2',
        name: 'HY2',
        server: 'hy2.example.com',
        port: 8443,
        password: 'fake-password',
        sni: 'hy2.example.com',
        obfs: 'salamander',
        'obfs-password': 'fake-obfs',
        'skip-cert-verify': true,
        up: '50',
        down: '100',
        alpn: ['h3'],
      }),
    );

    expect(back).toMatchObject({
      type: 'hysteria2',
      name: 'HY2',
      server: 'hy2.example.com',
      port: 8443,
      password: 'fake-password',
      sni: 'hy2.example.com',
      obfs: 'salamander',
      'obfs-password': 'fake-obfs',
      'skip-cert-verify': true,
      up: '50',
      down: '100',
      alpn: ['h3'],
    });
  });

  it('round-trips port hopping and the TLS pin', () => {
    const back = roundTrip(
      node({
        type: 'hysteria2',
        name: 'HY2-hop',
        server: '2001:db8::1',
        port: 9000,
        password: 'fake',
        ports: '9000-9010',
        'tls-fingerprint': 'AA:BB:CC',
        tfo: true,
        keepalive: 30,
      }),
    );
    expect(back).toMatchObject({
      server: '2001:db8::1',
      port: 9000,
      ports: '9000-9010',
      'tls-fingerprint': 'AA:BB:CC',
      tfo: true,
      keepalive: 30,
    });
  });
});

describe('uri producer: AnyTLS', () => {
  it('round-trips password, SNI, ALPN, insecure and idle-session tuning', () => {
    const back = roundTrip(
      node({
        type: 'anytls',
        name: 'AnyTLS',
        server: 'anytls.example.com',
        port: 443,
        password: 'fake-password',
        sni: 'anytls.example.com',
        alpn: ['h2', 'http/1.1'],
        'skip-cert-verify': true,
        'min-idle-session': 2,
        'idle-session-timeout': 60,
        'idle-session-check-interval': 30,
      }),
    );

    expect(back).toMatchObject({
      type: 'anytls',
      name: 'AnyTLS',
      server: 'anytls.example.com',
      port: 443,
      password: 'fake-password',
      sni: 'anytls.example.com',
      alpn: ['h2', 'http/1.1'],
      'skip-cert-verify': true,
      'min-idle-session': 2,
      'idle-session-timeout': 60,
      'idle-session-check-interval': 30,
    });
  });
});

describe('uri producer: mieru', () => {
  const fixture = node({
    type: 'mieru',
    name: 'JP mieru',
    server: 'jp.example.com',
    port: 8443,
    username: 'user-1',
    password: 'fake-password',
    transport: 'TCP',
  });

  it('emits the official mierus simple URL (name in profile, no fragment)', () => {
    const [link] = buildShareLinks([fixture]);
    expect(link).toBe(
      'mierus://user-1:fake-password@jp.example.com?profile=JP%20mieru&port=8443&protocol=TCP',
    );
  });

  it('uppercases transport and maps UDP to protocol=UDP', () => {
    const [link] = buildShareLinks([{ ...fixture, transport: 'udp' } as ProxyNode]);
    expect(link).toContain('protocol=UDP');
  });

  it('skips a node without credentials', () => {
    expect(buildShareLinks([{ ...fixture, password: undefined } as ProxyNode])).toEqual([]);
    expect(buildShareLinks([{ ...fixture, username: '' } as ProxyNode])).toEqual([]);
  });

  it('round-trips through the mierus parser', () => {
    const [link] = buildShareLinks([fixture]);
    expect(parseUri(link!)).toMatchObject({
      type: 'mieru',
      name: 'JP mieru',
      server: 'jp.example.com',
      port: 8443,
      username: 'user-1',
      password: 'fake-password',
      transport: 'TCP',
    });
  });

  it('uses the first port/protocol binding and the first number of a range', () => {
    expect(
      parseUri(
        'mierus://user-1:fake-password@jp.example.com?profile=range&port=8000-9000&protocol=UDP&port=443&protocol=TCP',
      ),
    ).toMatchObject({ port: 8000, transport: 'UDP', name: 'range' });
  });

  it('percent-decodes credentials and falls back to a name when profile is absent', () => {
    expect(
      parseUri('mierus://user%20name:p%40ss%3Aword@jp.example.com?port=8443'),
    ).toMatchObject({
      type: 'mieru',
      username: 'user name',
      password: 'p@ss:word',
      name: 'mieru jp.example.com',
      transport: 'TCP',
    });
  });

  it('never treats the whole-config mieru:// scheme as a node link', () => {
    const wholeConfig = 'mieru://CgZqcC5leGFtcGxl'; // base64 protobuf, not a node
    expect(isShareLink(wholeConfig)).toBe(false);
    expect(parseSubscription(wholeConfig)).toEqual([]);
  });
});

describe('uri producer: whole subscription round-trip', () => {
  it('parses every supported type back and keeps the key fields', () => {
    const nodes: ProxyNode[] = [
      node({ type: 'ss', name: 'ss-1', cipher: 'aes-256-gcm', password: 'fake' }),
      node({
        type: 'vmess',
        name: 'vmess-1',
        server: 'vm.example.com',
        port: 443,
        uuid: UUID,
        alterId: 0,
        tls: true,
      }),
      node({
        type: 'vless',
        name: 'vless-1',
        server: 'vl.example.com',
        port: 443,
        uuid: UUID,
        'reality-opts': { 'public-key': 'pbk', 'short-id': 'sid' },
        'client-fingerprint': 'chrome',
      }),
      node({ type: 'trojan', name: 'trojan-1', password: 'fake', port: 443 }),
      node({ type: 'tuic', name: 'tuic-1', uuid: UUID, password: 'fake', port: 443 }),
      node({ type: 'hysteria2', name: 'hy2-1', password: 'fake', port: 443 }),
      node({ type: 'anytls', name: 'anytls-1', password: 'fake', port: 443 }),
      node({
        type: 'mieru',
        name: 'mieru-1',
        server: 'mieru.example.com',
        port: 8443,
        username: 'user-1',
        password: 'fake',
        transport: 'UDP',
      }),
    ];

    const parsed = parseSubscription(produceUri(nodes));
    expect(parsed.map((entry) => entry.type)).toEqual(nodes.map((entry) => entry.type));
    for (const [index, original] of nodes.entries()) {
      const back = parsed[index]!;
      expect(back.name).toBe(original.name);
      expect(back.server).toBe(original.server);
      expect(back.port).toBe(original.port);
      const credential = original.uuid ?? original.password;
      expect(back.uuid ?? back.password).toBe(credential);
    }
  });
});

describe('uri producer: encoding safety', () => {
  it('URL-encodes the fragment and query values', () => {
    const [link] = buildShareLinks([
      node({
        type: 'trojan',
        name: '香港 01 & "quoted" #tag',
        password: 'pw',
        sni: 'sni.example.com',
        'ws-opts': { path: '/a b?x=1&y=2' },
        network: 'ws',
      }),
    ]);
    expect(link).not.toContain(' ');
    expect(link!.endsWith('#%E9%A6%99%E6%B8%AF%2001%20%26%20%22quoted%22%20%23tag')).toBe(true);
    expect(parseUri(link!)).toMatchObject({
      name: '香港 01 & "quoted" #tag',
      'ws-opts': { path: '/a b?x=1&y=2' },
    });
  });

  it('never throws for a malformed node; the node is simply skipped', () => {
    expect(() => produceUri([node({ port: NaN })])).not.toThrow();
    expect(produceUri([node({ port: NaN })])).toBe('');
  });

  it('the body is pure ASCII base64 (no charset surprises)', () => {
    const body = produceUri([node({ type: 'trojan', name: '日本', password: 'pw', port: 443 })]);
    expect(/^[A-Za-z0-9+/=]*$/.test(body)).toBe(true);
    expect(body).toBe(encodeBase64(linksOf(body).join('\n')));
    expect(parseSubscription(body)[0]!.name).toBe('日本');
  });
});
