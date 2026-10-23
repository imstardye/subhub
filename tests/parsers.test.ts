// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  parseAnyTLS,
  parseClashYaml,
  parseHysteria2,
  parseShadowsocks,
  parseSsr,
  parseSubscription,
  parseSubscriptionDetailed,
  parseTrojan,
  parseTuic,
  parseUri,
  parseVless,
  parseVmess,
} from '../core/parsers';
import { encodeBase64, parseQuery } from '../core/utils';

const UUID = '11111111-2222-3333-4444-555555555555';

describe('Shadowsocks parser', () => {
  it('parses SIP002 links with base64 user info and URI fragment', () => {
    const node = parseShadowsocks(
      'ss://YWVzLTI1Ni1nY206ZmFrZS1wYXNzd29yZA==@edge.example.com:8388#%F0%9F%87%AD%F0%9F%87%B0%20HK-01',
    );

    expect(node).toMatchObject({
      type: 'ss',
      name: '🇭🇰 HK-01',
      server: 'edge.example.com',
      port: 8388,
      cipher: 'aes-256-gcm',
      password: 'fake-password',
      udp: true,
    });
  });

  it('parses legacy fully-base64 encoded links', () => {
    const payload = encodeBase64('aes-256-gcm:fake-password@edge.example.com:8388');
    const node = parseShadowsocks(`ss://${payload}#Legacy-SS`);

    expect(node.server).toBe('edge.example.com');
    expect(node.port).toBe(8388);
    expect(node.name).toBe('Legacy-SS');
  });

  it('parses simple-obfs plugin options', () => {
    const node = parseShadowsocks(
      'ss://YWVzLTI1Ni1nY206ZmFrZS1wYXNzd29yZA==@edge.example.com:8388?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dcdn.example.com#SS-OBFS',
    );

    expect(node.plugin).toBe('obfs');
    expect(node['plugin-opts']).toEqual({
      mode: 'http',
      host: 'cdn.example.com',
    });
  });

  it('parses udp-over-tcp flags and versions', () => {
    const spv1 = parseShadowsocks(
      'ss://YWVzLTI1Ni1nY206ZmFrZS1wYXNzd29yZA==@edge.example.com:8388?uot=sp.v1#SS-UOT1',
    );
    expect(spv1['udp-over-tcp']).toBe(true);
    expect(spv1['udp-over-tcp-version']).toBe(1);

    const plain = parseShadowsocks(
      'ss://YWVzLTI1Ni1nY206ZmFrZS1wYXNzd29yZA==@edge.example.com:8388?udp-over-tcp=1#SS-UOT',
    );
    expect(plain['udp-over-tcp']).toBe(true);
    expect(plain['udp-over-tcp-version']).toBeUndefined();
  });
});

describe('SSR parser', () => {
  it('parses protocol, obfs params and remarks', () => {
    // ssr://base64(server:port:protocol:cipher:obfs:base64(password)/?params)
    const main = [
      'ssr.example.com:443:auth_aes128_md5:aes-128-cfb:http_simple:',
      encodeBase64('fake-password'),
    ].join('');
    const query = [
      `remarks=${encodeBase64('SSR 香港 01')}`,
      `protoparam=${encodeBase64('32:fake')}`,
      `obfsparam=${encodeBase64('cdn.example.com')}`,
    ].join('&');
    const node = parseSsr(`ssr://${encodeBase64(`${main}/?${query}`)}`);

    expect(node).toMatchObject({
      type: 'ssr',
      name: 'SSR 香港 01',
      server: 'ssr.example.com',
      port: 443,
      protocol: 'auth_aes128_md5',
      cipher: 'aes-128-cfb',
      obfs: 'http_simple',
      password: 'fake-password',
      'protocol-param': '32:fake',
      'obfs-param': 'cdn.example.com',
    });
  });

  it('keeps bracketed IPv6 servers and drops (null) params', () => {
    const main = `[2001:db8::1]:8388:origin:aes-128-cfb:plain:${encodeBase64('fake-pw')}`;
    const node = parseSsr(
      `ssr://${encodeBase64(
        `${main}/?remarks=${encodeBase64('SSR6')}&obfsparam=(null)`,
      )}`,
    );

    expect(node.server).toBe('[2001:db8::1]');
    expect(node.port).toBe(8388);
    expect(node.name).toBe('SSR6');
    expect(node['obfs-param']).toBeUndefined();
  });
});

describe('VMess parser', () => {
  it('parses V2rayN JSON links and transport options', () => {
    const payload = {
      v: '2',
      ps: 'VMess WS',
      add: 'vm.example.com',
      port: '443',
      id: UUID,
      aid: '0',
      scy: 'auto',
      net: 'ws',
      type: 'none',
      host: 'cdn.example.com',
      path: '/ws',
      tls: 'tls',
      sni: 'sni.example.com',
      alpn: 'h2,http/1.1',
      fp: 'chrome',
    };
    const node = parseVmess(`vmess://${encodeBase64(JSON.stringify(payload))}`);

    expect(node).toMatchObject({
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
      'client-fingerprint': 'chrome',
      alpn: ['h2', 'http/1.1'],
    });
    expect(node['ws-opts']).toEqual({
      path: '/ws',
      headers: { Host: 'cdn.example.com' },
    });
  });

  it('accepts URI-style vmess links', () => {
    const node = parseVmess(
      `vmess://${UUID}@vm-uri.example.com:443?encryption=auto&security=tls&type=grpc&serviceName=grpc-svc#VMess-URI`,
    );

    expect(node.type).toBe('vmess');
    expect(node.name).toBe('VMess-URI');
    expect(node.network).toBe('grpc');
    expect(node['grpc-opts']).toMatchObject({ 'grpc-service-name': 'grpc-svc' });
  });

  it('parses h2 transports with host lists from JSON links', () => {
    const node = parseVmess(
      `vmess://${encodeBase64(
        JSON.stringify({
          ps: 'VMess H2',
          add: 'vm.example.com',
          port: '443',
          id: UUID,
          net: 'h2',
          host: 'a.example.com,b.example.com',
          path: '/h2',
          tls: 'tls',
        }),
      )}`,
    );

    expect(node.network).toBe('h2');
    expect(node.tls).toBe(true);
    expect(node['h2-opts']).toEqual({
      host: ['a.example.com', 'b.example.com'],
      path: '/h2',
    });
  });
});

describe('VLESS parser', () => {
  it('parses Reality, flow and websocket options', () => {
    const node = parseVless(
      'vless://11111111-2222-3333-4444-555555555555@vless.example.com:443?encryption=none&security=reality&sni=www.example.com&fp=chrome&pbk=fake-public-key&sid=abcd&type=ws&host=cdn.example.com&path=%2Fws&flow=xtls-rprx-vision#VLESS-REALITY',
    );

    expect(node).toMatchObject({
      type: 'vless',
      name: 'VLESS-REALITY',
      server: 'vless.example.com',
      port: 443,
      uuid: UUID,
      tls: true,
      flow: 'xtls-rprx-vision',
      sni: 'www.example.com',
      network: 'ws',
    });
    expect(node['reality-opts']).toEqual({
      'public-key': 'fake-public-key',
      'short-id': 'abcd',
    });
    expect(node['ws-opts']).toEqual({
      path: '/ws',
      headers: { Host: 'cdn.example.com' },
    });
  });

  it('converts ws path early data into max-early-data', () => {
    const node = parseVless(
      `vless://${UUID}@vless.example.com:443?security=tls&type=ws&host=cdn.example.com&path=%2Fws%3Fed%3D2048#VLESS-ED`,
    );

    expect(node['ws-opts']).toMatchObject({
      path: '/ws',
      'max-early-data': 2048,
      'early-data-header-name': 'Sec-WebSocket-Protocol',
    });
  });

  it('parses reality spider-x and allowInsecure aliases', () => {
    const node = parseVless(
      `vless://${UUID}@vless.example.com:443?security=reality&pbk=fake-public-key&sid=abcd&spx=%2F&allowInsecure=1#VLESS-SPX`,
    );

    expect(node['reality-opts']).toEqual({
      'public-key': 'fake-public-key',
      'short-id': 'abcd',
      '_spider-x': '/',
    });
    expect(node['skip-cert-verify']).toBe(true);
  });

  it('parses bracketed IPv6 hosts', () => {
    const node = parseVless(
      `vless://${UUID}@[2001:db8::10]:443?security=tls#VLESS-IPV6`,
    );

    expect(node.server).toBe('[2001:db8::10]');
    expect(node.port).toBe(443);
  });

  it('parses HTTP/2 host lists', () => {
    const node = parseVless(
      'vless://11111111-2222-3333-4444-555555555555@vless.example.com:443?security=tls&type=http&host=a.example.com,b.example.com&path=%2Fh2#VLESS-H2',
    );

    expect(node.network).toBe('h2');
    expect(node['h2-opts']).toMatchObject({
      path: '/h2',
      host: ['a.example.com', 'b.example.com'],
    });
  });
});

describe('Trojan parser', () => {
  it('parses TLS + websocket links', () => {
    const node = parseTrojan(
      'trojan://fake-password@trojan.example.com:443?security=tls&sni=sni.example.com&type=ws&host=cdn.example.com&path=%2Ft#Trojan-WS',
    );

    expect(node).toMatchObject({
      type: 'trojan',
      name: 'Trojan-WS',
      server: 'trojan.example.com',
      port: 443,
      password: 'fake-password',
      tls: true,
      sni: 'sni.example.com',
      network: 'ws',
    });
    expect(node['ws-opts']).toEqual({
      path: '/t',
      headers: { Host: 'cdn.example.com' },
    });
  });
});

describe('Hysteria2 parser', () => {
  it('parses obfuscation, port hopping and bandwidth limits', () => {
    const node = parseHysteria2(
      'hysteria2://fake-password@hy2.example.com:8443?obfs=salamander&obfs-password=fake-obfs&sni=hy2.example.com&insecure=1&mport=8443-8445&upmbps=50&downmbps=100#HY2',
    );

    expect(node).toMatchObject({
      type: 'hysteria2',
      name: 'HY2',
      server: 'hy2.example.com',
      port: 8443,
      ports: '8443-8445',
      password: 'fake-password',
      sni: 'hy2.example.com',
      obfs: 'salamander',
      'obfs-password': 'fake-obfs',
      'skip-cert-verify': true,
      up: '50',
      down: '100',
    });
  });

  it('supports the hy2 alias and port ranges', () => {
    const node = parseHysteria2('hy2://fake-password@hy2.example.com:9000-9010#HY2-RANGE');

    expect(node.port).toBe(9000);
    expect(node.ports).toBe('9000-9010');
  });
});

describe('TUIC parser', () => {
  it('parses credentials and congestion options', () => {
    const node = parseTuic(
      'tuic://11111111-2222-3333-4444-555555555555:fake-pass@tuic.example.com:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=tuic.example.com&allow_insecure=1#TUIC',
    );

    expect(node).toMatchObject({
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
      'skip-cert-verify': true,
    });
  });

  it('copies only whitelisted URI fields onto the node', () => {
    const node = parseTuic(
      `tuic://${UUID}:fake-pass@tuic.example.com:443?token=fake-token&version=5&totally-unknown-param=evil&alpn=h3#TUIC-FIELDS`,
    );

    expect(node.token).toBe('fake-token');
    expect(node.version).toBe(5);
    // Unknown query parameters must not end up on the node.
    const record = node as Record<string, unknown>;
    expect(record['totally-unknown-param']).toBeUndefined();
    expect(Object.keys(node)).not.toContain('totally-unknown-param');
  });
});

describe('AnyTLS parser', () => {
  it('parses password, SNI, ALPN and verification options', () => {
    const node = parseAnyTLS(
      'anytls://fake-password@anytls.example.com:443?sni=anytls.example.com&insecure=1&alpn=h2,http/1.1#AnyTLS',
    );

    expect(node).toMatchObject({
      type: 'anytls',
      name: 'AnyTLS',
      server: 'anytls.example.com',
      port: 443,
      password: 'fake-password',
      sni: 'anytls.example.com',
      'skip-cert-verify': true,
      alpn: ['h2', 'http/1.1'],
    });
  });

  it('parses idle session tuning options', () => {
    const node = parseAnyTLS(
      'anytls://fake-password@anytls.example.com:443?idle-session-check-interval=30&idle-session-timeout=60#AnyTLS-Idle',
    );

    expect(node['idle-session-check-interval']).toBe(30);
    expect(node['idle-session-timeout']).toBe(60);
  });
});

describe('query parsing', () => {
  it('uses a null prototype and skips dangerous keys', () => {
    const query = parseQuery(
      'sni=example.com&__proto__=%7B%7D&constructor=x&prototype=y&insecure=1',
    );

    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(Object.keys(query)).toEqual(['sni', 'insecure']);
    expect(query.sni).toBe('example.com');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('Clash YAML parser', () => {
  it('parses proxies from a full config', () => {
    const nodes = parseClashYaml(`
mixed-port: 7890
proxies:
  - name: Clash-VMess
    type: vmess
    server: vm.example.com
    port: 443
    uuid: ${UUID}
    alterId: 0
    cipher: auto
    tls: true
    servername: sni.example.com
    network: ws
    ws-opts:
      path: /ws
      headers:
        Host: cdn.example.com
  - name: Clash-AnyTLS
    type: anytls
    server: anytls.example.com
    port: 443
    password: fake-password
    sni: anytls.example.com
`);

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      type: 'vmess',
      name: 'Clash-VMess',
      port: 443,
      uuid: UUID,
    });
    expect(nodes[1]).toMatchObject({ type: 'anytls', name: 'Clash-AnyTLS' });
  });

  it('ignores unsupported and malformed proxy entries', () => {
    const nodes = parseClashYaml(`
proxies:
  - name: bad
    type: unknown-protocol
    server: example.com
    port: 1
  - name: missing-port
    type: ss
    server: example.com
  - name: good
    type: trojan
    server: trojan.example.com
    port: 443
    password: fake-password
`);

    expect(nodes.map((node) => node.name)).toEqual(['good']);
  });
});

describe('Subscription parser', () => {
  it('decodes base64 subscriptions containing multiple links', () => {
    const links = [
      'ss://YWVzLTI1Ni1nY206ZmFrZS1wYXNzd29yZA==@edge.example.com:8388#SS',
      `vless://${UUID}@vless.example.com:443?security=tls&sni=vless.example.com#VLESS`,
      'trojan://fake-password@trojan.example.com:443#TROJAN',
    ].join('\n');
    const nodes = parseSubscription(encodeBase64(links));

    expect(nodes.map((node) => node.type)).toEqual(['ss', 'vless', 'trojan']);
  });

  it('decodes twice-encoded base64 subscriptions', () => {
    const links = 'ss://YWVzLTI1Ni1nY206ZmFrZS1wYXNzd29yZA==@edge.example.com:8388#SS';
    const nodes = parseSubscription(encodeBase64(encodeBase64(links)));

    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('ss');
    expect(nodes[0].name).toBe('SS');
  });

  it('parses plain mixed subscriptions and skips comments', () => {
    const nodes = parseSubscription(`
# comment
ss://YWVzLTI1Ni1nY206ZmFrZS1wYXNzd29yZA==@edge.example.com:8388#SS
hysteria2://fake-password@hy2.example.com:443#HY2
`);

    expect(nodes).toHaveLength(2);
    expect(nodes[1].type).toBe('hysteria2');
  });

  it('parses a Clash YAML subscription', () => {
    const nodes = parseSubscription(`
proxies:
  - name: yaml-ss
    type: ss
    server: edge.example.com
    port: 8388
    cipher: aes-256-gcm
    password: fake-password
`);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('yaml-ss');
  });

  it('reports malformed supported links while keeping valid ones', () => {
    const result = parseSubscriptionDetailed(
      'ss://not-a-valid-link\nanytls://fake-password@anytls.example.com:443#OK',
    );

    expect(result.nodes).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it('parseUri returns null for comments and throws for unknown schemes', () => {
    expect(parseUri('# comment')).toBeNull();
    expect(() => parseUri('wireguard://example.com:51820')).toThrow(
      /Unsupported share link/,
    );
  });

  it('rejects inputs larger than the 10MB limit', () => {
    const oversized = 'ss://not-a-real-link\n'.repeat(1024 * 1024);
    const result = parseSubscriptionDetailed(oversized);

    expect(result.nodes).toHaveLength(0);
    expect(result.errors[0]?.message).toMatch(/10MB/);
  });

  it('refuses YAML documents with too many aliases', () => {
    const aliases = Array.from({ length: 150 }, (_, i) => `key${i}: *anchor`).join('\n');
    const payload = `anchor: &anchor [1]\n${aliases}\nproxies:\n  - name: yaml-ss\n    type: ss\n    server: edge.example.com\n    port: 8388\n    cipher: aes-256-gcm\n    password: fake-password`;
    const result = parseSubscriptionDetailed(payload);

    expect(result.nodes).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  });
});
