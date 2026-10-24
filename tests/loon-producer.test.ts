// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loon producer: real `[Proxy]` lines per protocol (Loon's positional syntax,
 * which differs from Surge's `key=value`), `[Proxy Group]` mapping and the same
 * member-pruning rules as the Surge producer.
 */
import { describe, expect, it } from 'vitest';
import type { ClashProxyGroup, ProxyNode } from '../core/types';
import { buildLoonGroups, buildLoonProxies, loonProxyLine, produceLoon } from '../core/producers';

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

function proxyNames(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.includes(' = '))
    .map((line) => line.slice(0, line.indexOf(' = ')));
}

describe('Loon producer: [Proxy] golden lines', () => {
  it('emits positional Shadowsocks (Shadowsocks,server,port,method,password)', () => {
    expect(
      loonProxyLine(node({ type: 'ss', name: 'SS', cipher: 'aes-256-gcm', password: 'fake-password' })),
    ).toEqual({ line: 'SS = Shadowsocks,example.com,8388,aes-256-gcm,fake-password' });
  });

  it('emits ShadowsocksR with protocol/obfs parameters', () => {
    expect(
      loonProxyLine(
        node({
          type: 'ssr',
          name: 'SSR',
          cipher: 'aes-256-cfb',
          password: 'fake',
          protocol: 'auth_aes128_md5',
          'protocol-param': '1234:abcd',
          obfs: 'tls1.2_ticket_auth',
          'obfs-param': 'cdn.example.com',
        }),
      ),
    ).toEqual({
      line: 'SSR = ShadowsocksR,example.com,8388,aes-256-cfb,fake,auth_aes128_md5,1234:abcd,tls1.2_ticket_auth,cdn.example.com',
    });
  });

  it('emits VMess over WebSocket with transport and TLS fields', () => {
    expect(
      loonProxyLine(
        node({
          type: 'vmess',
          name: 'VM',
          port: 443,
          uuid: UUID,
          cipher: 'auto',
          tls: true,
          sni: 'sni.example.com',
          network: 'ws',
          'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
        }),
      ),
    ).toEqual({
      line: `VM = VMess,example.com,443,auto,${UUID},obfs=ws,obfs-uri=/ws,obfs-host=cdn.example.com,over-tls=true,tls-name=sni.example.com`,
    });
  });

  it('emits plain TCP VMess with the method and skip-cert-verify', () => {
    expect(
      loonProxyLine(
        node({
          type: 'vmess',
          name: 'VM',
          uuid: UUID,
          cipher: 'aes-128-gcm',
          tls: true,
          'skip-cert-verify': true,
        }),
      ),
    ).toEqual({
      line: `VM = VMess,example.com,8388,aes-128-gcm,${UUID},tcp,over-tls=true,skip-cert-verify=true`,
    });
  });

  it('emits VMess over gRPC', () => {
    expect(
      loonProxyLine(
        node({
          type: 'vmess',
          name: 'VM',
          uuid: UUID,
          network: 'grpc',
          'grpc-opts': { 'grpc-service-name': 'svc' },
        }),
      ),
    ).toEqual({ line: `VM = VMess,example.com,8388,auto,${UUID},obfs=grpc,grpc-service-name=svc` });
  });

  it('emits VLESS with encryption=none, transport and TLS', () => {
    expect(
      loonProxyLine(
        node({
          type: 'vless',
          name: 'VLESS',
          port: 443,
          uuid: UUID,
          encryption: 'none',
          tls: true,
          sni: 'vless.example.com',
          network: 'ws',
          'ws-opts': { path: '/v', headers: { Host: 'cdn.example.com' } },
          flow: 'xtls-rprx-vision',
        }),
      ),
    ).toEqual({
      line: `VLESS = VLESS,example.com,443,none,${UUID},obfs=ws,obfs-uri=/v,obfs-host=cdn.example.com,over-tls=true,tls-name=vless.example.com,flow=xtls-rprx-vision`,
    });
  });

  it('emits Trojan with positional password and TLS options', () => {
    expect(
      loonProxyLine(
        node({
          type: 'trojan',
          name: 'TJ',
          port: 443,
          password: 'fake-password',
          sni: 'trojan.example.com',
          'skip-cert-verify': false,
          alpn: ['h2'],
        }),
      ),
    ).toEqual({
      line: 'TJ = Trojan,example.com,443,fake-password,sni=trojan.example.com,skip-cert-verify=false,alpn=h2',
    });
  });

  it('emits Hysteria2 with password and sni', () => {
    expect(
      loonProxyLine(
        node({ type: 'hysteria2', name: 'HY2', port: 443, password: 'fake-password', sni: 'hy.example.com' }),
      ),
    ).toEqual({ line: 'HY2 = Hysteria2,example.com,443,fake-password,sni=hy.example.com' });
  });

  it('emits TUIC with the token', () => {
    expect(
      loonProxyLine(
        node({
          type: 'tuic',
          name: 'TUIC',
          port: 443,
          uuid: UUID,
          password: 'fake-password',
          sni: 'tuic.example.com',
          alpn: ['h3'],
        }),
      ),
    ).toEqual({
      line: `TUIC = TUIC,example.com,443,${UUID}:fake-password,alpn=h3,sni=tuic.example.com`,
    });
  });

  it('emits AnyTLS (Loon has its own line type)', () => {
    expect(
      loonProxyLine(node({ type: 'anytls', name: 'AT', port: 443, password: 'fake', sni: 'at.example.com' })),
    ).toEqual({ line: 'AT = AnyTLS,example.com,443,fake,sni=at.example.com' });
  });

  it.each(['socks5', 'socks'])('emits Socks5 credentials for %s', (type) => {
    expect(loonProxyLine(node({ type, name: 'S', port: 1080, username: 'user', password: 'fake' }))).toEqual({
      line: 'S = Socks5,example.com,1080,user,fake',
    });
  });

  it('emits an HTTP proxy and marks TLS for https proxies', () => {
    // No credentials: no dangling positional fields (Loon would read the TLS
    // flag as a username).
    expect(loonProxyLine(node({ type: 'http', name: 'H', port: 8080 }))).toEqual({
      line: 'H = HTTP,example.com,8080',
    });
    expect(loonProxyLine(node({ type: 'http', name: 'H', port: 8080, tls: true }))).toEqual({
      line: 'H = HTTP,example.com,8080,over-tls=true',
    });
    expect(
      loonProxyLine(node({ type: 'http', name: 'H', port: 8080, username: 'u', password: 'p', tls: true })),
    ).toEqual({ line: 'H = HTTP,example.com,8080,u,p,over-tls=true' });
  });

  it('skips a SOCKS/HTTP proxy with only half the credentials', () => {
    // Positional fields: `username,password` must be written as a pair.
    expect(loonProxyLine(node({ type: 'http', name: 'H', port: 8080, username: 'u' }))).toEqual({
      skipped: 'missing or unrepresentable protocol options',
    });
    expect(loonProxyLine(node({ type: 'socks5', name: 'S', port: 1080, password: 'p' }))).toEqual({
      skipped: 'missing or unrepresentable protocol options',
    });
  });
});

describe('Loon producer: skipped types', () => {
  it('skips transports/features Loon cannot express and counts them', () => {
    const result = buildLoonProxies([
      // Reality has no Loon field on its VMess/VLESS lines.
      node({ type: 'vless', name: 'reality', uuid: UUID, 'reality-opts': { 'public-key': 'k' } }),
      // h2 is not a Loon transport keyword.
      node({ type: 'vmess', name: 'h2', uuid: UUID, network: 'h2' }),
      // WS Trojan does not exist in Loon.
      node({ type: 'trojan', name: 'trojan-ws', password: 'p', network: 'ws' }),
      // Shadowsocks plugins cannot be expressed on a Loon ss line.
      node({ name: 'ss-obfs', cipher: 'aes-128-gcm', password: 'p', plugin: 'obfs' }),
      node({ name: 'kept', cipher: 'aes-128-gcm', password: 'p' }),
    ]);

    expect(result.names).toEqual(['kept']);
    expect(result.skipped.map((entry) => entry.name)).toEqual([
      'reality',
      'h2',
      'trojan-ws',
      'ss-obfs',
    ]);
  });

  it('never emits mihomo YAML', () => {
    const body = produceLoon([node({ type: 'wireguard', name: 'wg', server: 'example.com', port: 51820 })]);
    expect(body).not.toContain('proxies:');
    expect(body).toBe('');
  });
});

describe('Loon producer: [Proxy Group]', () => {
  const nodes = [
    node({ name: 'hk-01', cipher: 'aes-128-gcm', password: 'p' }),
    node({ type: 'vless', name: 'vless-01', uuid: UUID }),
    node({ type: 'trojan', name: 'us-01', password: 'p' }),
  ];
  const emitted = () => buildLoonProxies(nodes).names;

  it('maps select/url-test/fallback to Loon keywords (fallback -> fall-back)', () => {
    const groups = buildLoonGroups(
      [
        group({ name: 'sel', type: 'select', proxies: ['hk-01'] }),
        group({ name: 'auto', type: 'url-test', proxies: ['hk-01'], url: 'https://example.com/generate_204', interval: 300 }),
        group({ name: 'fb', type: 'fallback', proxies: ['us-01'], url: 'https://example.com/generate_204' }),
      ],
      emitted(),
    );

    expect(groups.map((entry) => entry.type)).toEqual(['select', 'url-test', 'fall-back']);
  });

  it('renders group lines in Loon syntax', () => {
    const body = produceLoon(nodes, [
      group({ name: '🚀 节点选择', type: 'select', proxies: ['hk-01', 'vless-01', 'absent-01', 'DIRECT'] }),
      group({ name: '⚡ auto', type: 'url-test', proxies: ['hk-01', 'us-01'], url: 'https://example.com/generate_204', interval: 300, tolerance: 50 }),
    ]);

    expect(body).toContain('🚀 节点选择 = select,hk-01,vless-01,DIRECT');
    expect(body).toContain('⚡ auto = url-test,hk-01,us-01,url=https://example.com/generate_204,interval=300,tolerance=50');
  });

  it('keeps VLESS in the group here (Loon supports VLESS) unlike Surge', () => {
    const [sel] = buildLoonGroups([group({ name: 'v', type: 'select', proxies: ['vless-01'] })], emitted());
    expect(sel!.members).toEqual(['vless-01']);
  });

  it('drops a group left empty by pruning (keep-if-exists reference)', () => {
    const groups = buildLoonGroups(
      [
        group({ name: 'gone', type: 'select', proxies: ['nope-01'] }),
        group({ name: 'nodes', type: 'select', proxies: ['hk-01', 'us-01'] }),
      ],
      emitted(),
    );

    expect(groups.map((entry) => entry.name)).toEqual(['nodes']);
  });

  it('drops load-balance (no Loon group type)', () => {
    expect(buildLoonGroups([group({ name: 'lb', type: 'load-balance', proxies: ['hk-01'] })], emitted())).toEqual([]);
  });

  it('prunes a reference to a dropped group recursively', () => {
    const groups = buildLoonGroups(
      [
        group({ name: 'outer', type: 'select', proxies: ['lb'] }),
        group({ name: 'lb', type: 'load-balance', proxies: ['hk-01'] }),
        group({ name: 'nodes', type: 'select', proxies: ['hk-01'] }),
      ],
      emitted(),
    );

    expect(groups.map((entry) => entry.name)).toEqual(['nodes']);
  });

  it('emits no [Rule] section and no groups without a profile', () => {
    const body = produceLoon(nodes);
    expect(body).not.toContain('[Rule]');
    // Only the proxies themselves, no `name = select,...` group lines.
    expect(proxyNames(body)).toEqual(['hk-01', 'vless-01', 'us-01']);
    expect(body).not.toContain('= select');
  });
});

describe('Loon producer: robustness of the emitted document', () => {
  it('writes credentials as a positional pair and never as a stray field', () => {
    expect(
      loonProxyLine(node({ type: 'socks5', name: 'S', port: 1080, username: 'u', password: 'p' })),
    ).toEqual({ line: 'S = Socks5,example.com,1080,u,p' });
    // Only a username: the password slot must not swallow the next keyword.
    expect(loonProxyLine(node({ type: 'http', name: 'H', port: 8080, username: 'u', tls: true }))).toEqual({
      skipped: 'missing or unrepresentable protocol options',
    });
  });

  it('never lets a node or group name inject a new line or section', () => {
    expect(loonProxyLine(node({ name: 'evil\n[Rule]\nFINAL,DIRECT', cipher: 'aes-128-gcm', password: 'p' }))).toEqual({
      skipped: 'name not representable in a config line',
    });

    const body = produceLoon(
      [node({ name: 'hk', cipher: 'aes-128-gcm', password: 'p' })],
      [
        group({ name: 'g\n[Rule]', type: 'select', proxies: ['hk'] }),
        group({ name: 'ok', type: 'select', proxies: ['hk\n[Rule]', 'hk'] }),
      ],
    );
    expect(body).not.toContain('[Rule]');
    expect(body).toContain('ok = select,hk');
  });

  it('drops duplicate group names and case-only duplicate members', () => {
    const groups = buildLoonGroups(
      [
        group({ name: 'nodes', type: 'select', proxies: ['hk-01', 'HK-01', 'us-01'] }),
        group({ name: 'NODES', type: 'select', proxies: ['hk-01'] }),
      ],
      ['hk-01', 'us-01'],
    );
    expect(groups.map((entry) => entry.name)).toEqual(['nodes']);
    expect(groups[0]!.members).toEqual(['hk-01', 'us-01']);
  });

  it('keeps the skip reason for a node without a name', () => {
    // The name is missing, which is what the reason list reports first; the
    // marker pass must not turn the specific reason into a generic one.
    const result = buildLoonProxies([
      { name: '', type: 'wireguard', server: 'example.com', port: 51820 } as ProxyNode,
      node({ name: 'kept', cipher: 'aes-128-gcm', password: 'p' }),
    ]);
    expect(result.names).toEqual(['kept']);
    expect(result.skipped).toEqual([{ name: '', reason: 'missing name' }]);
  });
});
