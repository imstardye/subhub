// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shadowrocket full-config producer (`shadowrocket-conf`): native `[Proxy]`
 * lines per protocol, `[Proxy Group]` mapping/pruning, and the Clash -> conf
 * rule translation table.
 *
 * Line fixtures are the contract: they are the exact text Shadowrocket loads,
 * so they are asserted as whole lines, not just fragments.
 */
import { describe, expect, it } from 'vitest';
import type { ClashProxyGroup, ProxyNode } from '../core/types';
import {
  buildShadowrocketConfGroups,
  buildShadowrocketConfProxies,
  produceShadowrocketConf,
  shadowrocketConfProxyLine,
  translateShadowrocketConfRules,
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

function group(overrides: Partial<ClashProxyGroup>): ClashProxyGroup {
  return { name: 'group', type: 'select', proxies: [], ...overrides };
}

describe('Shadowrocket conf producer: [Proxy] golden lines', () => {
  it('emits Shadowsocks with positional cipher/password and obfs options', () => {
    expect(
      shadowrocketConfProxyLine(
        node({ name: 'SS', cipher: 'aes-256-gcm', password: 'fake-password' }),
      ),
    ).toEqual({ line: 'SS = ss, example.com, 8388, aes-256-gcm, fake-password' });

    expect(
      shadowrocketConfProxyLine(
        node({
          name: 'SS-OBFS',
          cipher: 'aes-128-gcm',
          password: 'pw',
          plugin: 'obfs',
          'plugin-opts': { mode: 'http', host: 'cdn.example.com' },
        }),
      ),
    ).toEqual({
      line: 'SS-OBFS = ss, example.com, 8388, aes-128-gcm, pw, obfs=http, obfs-host=cdn.example.com',
    });
  });

  it('emits VMess over WebSocket with username/tls/ws and AEAD', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          type: 'vmess',
          name: 'VM',
          port: 443,
          uuid: UUID,
          tls: true,
          sni: 'sni.example.com',
          network: 'ws',
          'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
        }),
      ),
    ).toEqual({
      line: `VM = vmess, example.com, 443, username=${UUID}, tls=true, sni=sni.example.com, ws=true, ws-path=/ws, ws-host=cdn.example.com, aead=true`,
    });
  });

  it('emits plain TCP VMess with method for a non-auto cipher', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          type: 'vmess',
          name: 'VM',
          uuid: UUID,
          cipher: 'aes-128-gcm',
          'skip-cert-verify': true,
        }),
      ),
    ).toEqual({
      line: `VM = vmess, example.com, 8388, username=${UUID}, allow-insecure=true, method=aes-128-gcm, aead=true`,
    });
  });

  it('emits VLESS with Reality, flow and WebSocket', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          type: 'vless',
          name: 'VLESS',
          port: 443,
          uuid: UUID,
          tls: true,
          sni: 'vless.example.com',
          flow: 'xtls-rprx-vision',
          network: 'ws',
          'ws-opts': { path: '/v', headers: { Host: 'cdn.example.com' } },
          'reality-opts': { 'public-key': 'pub-key', 'short-id': 'abcd' },
          'skip-cert-verify': false,
        }),
      ),
    ).toEqual({
      line: `VLESS = vless, example.com, 443, username=${UUID}, tls=true, reality-public-key=pub-key, reality-short-id=abcd, sni=vless.example.com, flow=xtls-rprx-vision, allow-insecure=false, ws=true, ws-path=/v, ws-host=cdn.example.com`,
    });
  });

  it('emits Trojan with password and shared TLS/ws options', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          type: 'trojan',
          name: 'TJ',
          port: 443,
          password: 'fake-password',
          sni: 'trojan.example.com',
          network: 'ws',
          'ws-opts': { path: '/t' },
          'skip-cert-verify': false,
        }),
      ),
    ).toEqual({
      line: 'TJ = trojan, example.com, 443, password=fake-password, sni=trojan.example.com, allow-insecure=false, ws=true, ws-path=/t',
    });
  });

  it('emits Hysteria2 with obfs/sni and only the base port', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          type: 'hysteria2',
          name: 'HY2',
          port: 443,
          password: 'pw',
          obfs: 'salamander',
          'obfs-password': 'op',
          sni: 'hy.example.com',
          ports: '60000-62000',
          'hop-interval': 15,
        }),
      ),
    ).toEqual({
      line: 'HY2 = hysteria2, example.com, 443, password=pw, obfs=salamander, obfs-password=op, sni=hy.example.com',
    });
  });

  it('emits TUIC with username/password plus congestion/alpn', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          type: 'tuic',
          name: 'TUIC',
          port: 443,
          uuid: UUID,
          password: 'pw',
          sni: 'tuic.example.com',
          alpn: ['h3'],
          'congestion-controller': 'bbr',
          'skip-cert-verify': false,
        }),
      ),
    ).toEqual({
      line: `TUIC = tuic, example.com, 443, username=${UUID}, password=pw, sni=tuic.example.com, alpn=h3, congestion-controller=bbr, allow-insecure=false`,
    });
  });

  it('emits only the first ALPN value (a comma-join would corrupt the line)', () => {
    const built = shadowrocketConfProxyLine(
      node({
        type: 'tuic',
        name: 'TUIC2',
        port: 443,
        uuid: UUID,
        password: "pw2",
        alpn: ['h3', 'h2'],
      }),
    );
    expect(built).toEqual({
      line: `TUIC2 = tuic, example.com, 443, username=${UUID}, password=pw2, alpn=h3`,
    });
  });

  it('emits AnyTLS with password/sni', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          type: 'anytls',
          name: 'AT',
          port: 443,
          password: 'pw',
          sni: 'at.example.com',
          'skip-cert-verify': false,
        }),
      ),
    ).toEqual({
      line: 'AT = anytls, example.com, 443, password=pw, sni=at.example.com, allow-insecure=false',
    });
  });

  it.each(['socks5', 'socks'])('emits SOCKS credentials for %s', (type) => {
    expect(
      shadowrocketConfProxyLine(
        node({ type, name: 'SOCKS', port: 1080, username: 'user', password: 'fake' }),
      ),
    ).toEqual({ line: 'SOCKS = socks5, example.com, 1080, user, fake' });
    expect(shadowrocketConfProxyLine(node({ type, name: 'SOCKS', port: 1080 }))).toEqual({
      line: 'SOCKS = socks5, example.com, 1080',
    });
  });

  it('emits HTTP and marks TLS proxies as https', () => {
    expect(shadowrocketConfProxyLine(node({ type: 'http', name: 'HTTP', port: 8080 }))).toEqual({
      line: 'HTTP = http, example.com, 8080',
    });
    expect(
      shadowrocketConfProxyLine(
        node({ type: 'http', name: 'HTTPS', port: 443, tls: true, username: 'u', password: 'p' }),
      ),
    ).toEqual({ line: 'HTTPS = https, example.com, 443, u, p' });
  });
});

describe('Shadowrocket conf producer: skipped nodes', () => {
  it('skips WireGuard and unknown protocols with a diagnostic', () => {
    const result = buildShadowrocketConfProxies([
      node({ type: 'wireguard', name: 'WG' }),
      node({ type: 'snell', name: 'SNELL' }),
      node({ name: 'kept', cipher: 'aes-128-gcm', password: 'p' }),
    ]);
    expect(result.names).toEqual(['kept']);
    expect(result.skipped).toEqual([
      { name: 'WG', reason: 'WireGuard conf syntax is out of scope' },
      { name: 'SNELL', reason: 'unsupported protocol: snell' },
    ]);
  });

  it('skips nodes missing credentials or with an unrepresentable transport', () => {
    const result = buildShadowrocketConfProxies([
      node({ name: 'ss-no-password', cipher: 'aes-128-gcm' }),
      node({ type: 'vmess', name: 'vmess-no-uuid' }),
      node({ type: 'vless', name: 'vless-grpc', uuid: UUID, network: 'grpc' }),
      node({ type: 'trojan', name: 'trojan-no-password' }),
    ]);
    expect(result.lines).toEqual([]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      'missing or unrepresentable protocol options',
      'missing or unrepresentable protocol options',
      'missing or unrepresentable protocol options',
      'missing or unrepresentable protocol options',
    ]);
  });

  it('skips an ungrounded Shadowsocks plugin instead of dropping it silently', () => {
    expect(
      shadowrocketConfProxyLine(
        node({
          name: 'ss-v2ray',
          cipher: 'aes-128-gcm',
          password: 'p',
          plugin: 'v2ray-plugin',
          'plugin-opts': { mode: 'websocket' },
        }),
      ),
    ).toEqual({ skipped: 'missing or unrepresentable protocol options' });
  });
});

describe('Shadowrocket conf producer: [Proxy Group]', () => {
  const nodes = [
    node({ name: 'hk-01', cipher: 'aes-128-gcm', password: 'p' }),
    node({ type: 'trojan', name: 'us-01', password: 'p' }),
  ];
  const names = buildShadowrocketConfProxies(nodes).names;

  it('maps select/url-test/fallback/load-balance and fills health-check defaults', () => {
    const body = produceShadowrocketConf(nodes, [
      group({ name: 'sel', type: 'select', proxies: ['hk-01', 'us-01', 'DIRECT'] }),
      group({
        name: 'auto',
        type: 'url-test',
        proxies: ['hk-01'],
        url: 'https://example.com/generate_204',
        interval: 120,
      }),
      group({ name: 'fb', type: 'fallback', proxies: ['us-01'] }),
      group({ name: 'lb', type: 'load-balance', proxies: ['hk-01', 'us-01'] }),
    ]);

    expect(body).toContain('sel = select, hk-01, us-01, DIRECT');
    expect(body).toContain(
      'auto = url-test, hk-01, url = https://example.com/generate_204, interval = 120',
    );
    expect(body).toContain(
      'fb = fallback, us-01, url = http://www.gstatic.com/generate_204, interval = 300',
    );
    expect(body).toContain('lb = load-balance, hk-01, us-01');
  });

  it('drops a relay group and removes references to it from survivors', () => {
    const groups = buildShadowrocketConfGroups(
      [
        group({ name: 'relay', type: 'relay', proxies: ['hk-01', 'us-01'] }),
        group({ name: 'outer', type: 'select', proxies: ['relay', 'hk-01'] }),
        group({ name: 'nodes', type: 'select', proxies: ['hk-01', 'us-01'] }),
      ],
      names,
    );
    expect(groups.map((entry) => entry.name)).toEqual(['outer', 'nodes']);
    expect(groups[0]!.members).toEqual(['hk-01']);

    const body = produceShadowrocketConf(nodes, [
      group({ name: 'relay', type: 'relay', proxies: ['hk-01', 'us-01'] }),
      group({ name: 'outer', type: 'select', proxies: ['relay', 'hk-01'] }),
    ]);
    expect(body).not.toContain('relay');
    expect(body).toContain('outer = select, hk-01');
  });

  it('drops an empty group and prunes unknown members', () => {
    const groups = buildShadowrocketConfGroups(
      [
        group({ name: 'empty', type: 'select', proxies: ['missing-node'] }),
        group({ name: 'nodes', type: 'select', proxies: ['missing-node', 'hk-01', 'REJECT'] }),
      ],
      names,
    );
    expect(groups.map((entry) => entry.name)).toEqual(['nodes']);
    expect(groups[0]!.members).toEqual(['hk-01', 'REJECT']);
  });

  it('drops a group whose name contains a comma (line syntax)', () => {
    expect(
      buildShadowrocketConfGroups([group({ name: 'bad,name', type: 'select', proxies: ['hk-01'] })], names),
    ).toEqual([]);
  });
});

describe('Shadowrocket conf producer: rule translation', () => {
  const providers = {
    rs_1: { url: 'https://rules.example.com/proxy.list' },
    inline: { url: '[GEOIP,CN]' },
  } as Record<string, unknown>;
  const nodes = ['hk-01'];
  const groups = ['🚀 节点选择'];

  it('keeps the supported types and rewrites IP-CIDR6', () => {
    const rules = [
      'DOMAIN,example.com,🚀 节点选择',
      'DOMAIN-SUFFIX,example.org,DIRECT',
      'DOMAIN-KEYWORD,ads,REJECT',
      'DOMAIN-WILDCARD,*.example.net,DIRECT',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR6,2001:db8::/32,DIRECT',
      'GEOIP,CN,DIRECT',
      'DST-PORT,443,🚀 节点选择',
      'SRC-PORT,1234,DIRECT',
      'IN-PORT,7890,DIRECT',
      'SRC-IP-CIDR,192.168.0.0/16,DIRECT',
      'USER-AGENT,Example*,🚀 节点选择',
      'URL-REGEX,^https?://example\\.com,DIRECT',
      'MATCH,🚀 节点选择',
    ];
    expect(translateShadowrocketConfRules(rules, providers, nodes, groups)).toEqual([
      'DOMAIN,example.com,🚀 节点选择',
      'DOMAIN-SUFFIX,example.org,DIRECT',
      'DOMAIN-KEYWORD,ads,REJECT',
      'DOMAIN-WILDCARD,*.example.net,DIRECT',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,2001:db8::/32,DIRECT',
      'GEOIP,CN,DIRECT',
      'DST-PORT,443,🚀 节点选择',
      'SRC-PORT,1234,DIRECT',
      'IN-PORT,7890,DIRECT',
      'SRC-IP-CIDR,192.168.0.0/16,DIRECT',
      'USER-AGENT,Example*,🚀 节点选择',
      'URL-REGEX,^https?://example\\.com,DIRECT',
      'FINAL,🚀 节点选择',
    ]);
  });

  it('maps RULE-SET to the provider URL and drops inline providers', () => {
    expect(
      translateShadowrocketConfRules(
        ['RULE-SET,rs_1,🚀 节点选择', 'RULE-SET,inline,🚀 节点选择', 'RULE-SET,missing,🚀 节点选择'],
        providers,
        nodes,
        groups,
      ),
    ).toEqual(['RULE-SET,https://rules.example.com/proxy.list,🚀 节点选择']);
  });

  it('drops GEOSITE/logic/process rules and rules pointing at a missing policy', () => {
    expect(
      translateShadowrocketConfRules(
        [
          'GEOSITE,openai,🚀 节点选择',
          'AND,((NETWORK,UDP),(DST-PORT,443)),REJECT',
          'OR,((DOMAIN,a.example),(DOMAIN,b.example)),🚀 节点选择',
          'NOT,((DOMAIN,ads.example)),REJECT',
          'PROCESS-NAME,example,DIRECT',
          'PROCESS-PATH,/usr/bin/example,DIRECT',
          'DOMAIN,old.example.com,已删除组',
          'DOMAIN,kept.example.com,DIRECT',
        ],
        providers,
        nodes,
        groups,
      ),
    ).toEqual(['DOMAIN,kept.example.com,DIRECT']);
  });

  it('keeps built-in policies and final rules', () => {
    expect(
      translateShadowrocketConfRules(
        ['DOMAIN,x.example,PROXY', 'MATCH,REJECT', 'FINAL,DIRECT'],
        providers,
        nodes,
        groups,
      ),
    ).toEqual(['DOMAIN,x.example,PROXY', 'FINAL,REJECT', 'FINAL,DIRECT']);
  });
});

describe('Shadowrocket conf producer: document shape', () => {
  it('always emits [General] and [Host], omitting empty sections', () => {
    expect(produceShadowrocketConf([])).toBe(
      ['[General]', 'bypass-system = true', '', '[Host]', 'localhost = 127.0.0.1', ''].join('\n'),
    );
  });

  it('emits the sections in order with blank lines between them', () => {
    const body = produceShadowrocketConf(
      [node({ name: 'hk', cipher: 'aes-128-gcm', password: 'p' })],
      [group({ name: 'nodes', type: 'select', proxies: ['hk'] })],
      ['MATCH,nodes'],
    );
    expect(body.split('\n').filter(Boolean)).toEqual([
      '[General]',
      'bypass-system = true',
      '[Proxy]',
      'hk = ss, example.com, 8388, aes-128-gcm, p',
      '[Proxy Group]',
      'nodes = select, hk',
      '[Rule]',
      'FINAL,nodes',
      '[Host]',
      'localhost = 127.0.0.1',
    ]);
  });
});

describe('Shadowrocket conf producer: name sanitization', () => {
  const raw = 'HK,01=fast';

  it('replaces comma/equals/newline in [Proxy] and group members', () => {
    const sanitized = 'HK 01 fast';
    // The real export expands groups against `targetProxyNames`, i.e. these
    // sanitized names; here we mirror that with the already-sanitized member.
    const body = produceShadowrocketConf(
      [node({ name: raw, cipher: 'aes-128-gcm', password: 'p' })],
      [group({ name: 'nodes', type: 'select', proxies: [sanitized] })],
      ['MATCH,nodes'],
    );

    expect(body).toContain(`[Proxy]\n${sanitized} = ss, example.com, 8388, aes-128-gcm, p`);
    expect(body).toContain('nodes = select, HK 01 fast');
    expect(body).not.toContain('HK,01');
    expect(body).not.toContain('=fast');
    // No stray fields: the proxy line still has exactly five comma fields.
    const proxyLine = body.split('\n').find((line) => line.startsWith(`${sanitized} = `))!;
    expect(proxyLine.split(' = ')[1]!.split(', ')).toHaveLength(5);
  });

  it('sanitizes a newline instead of letting it start a new config line', () => {
    expect(
      shadowrocketConfProxyLine(
        node({ name: 'evil\n[Rule]\nFINAL,DIRECT', cipher: 'aes-128-gcm', password: 'p' }),
      ),
    ).toEqual({ line: 'evil [Rule] FINAL DIRECT = ss, example.com, 8388, aes-128-gcm, p' });
  });
});
