// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Surge producer: real `[Proxy]` lines per protocol, `[Proxy Group]` mapping
 * from subconverter profile groups, and member pruning.
 *
 * Line fixtures are the contract: they are the exact text Surge loads, so they
 * are asserted as whole strings, not just as fragments.
 */
import { describe, expect, it } from 'vitest';
import type { ClashProxyGroup, ProxyNode } from '../core/types';
import {
  buildSurgeGroups,
  buildSurgeProxies,
  produceSurge,
  surgePortHopping,
  surgeProxyLine,
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

/** Parse `[Proxy]` lines back into their name (the part before ` = `). */
function proxyNames(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.includes(' = '))
    .map((line) => line.slice(0, line.indexOf(' = ')));
}

describe('Surge producer: [Proxy] golden lines', () => {
  it('emits Shadowsocks with encrypt-method/password', () => {
    expect(
      surgeProxyLine(
        node({ type: 'ss', name: 'SS', cipher: 'aes-256-gcm', password: 'fake-password' }),
      ),
    ).toEqual({
      line: 'SS = ss, example.com, 8388, encrypt-method=aes-256-gcm, password=fake-password, udp-relay=true',
    });
    expect(
      surgeProxyLine(node({ type: 'ss', cipher: 'chacha20-ietf-poly1305', password: 'p', udp: false })),
    ).toEqual({
      line: 'test = ss, example.com, 8388, encrypt-method=chacha20-ietf-poly1305, password=p, udp-relay=false',
    });
  });

  it('emits VMess over WebSocket with username, tls, ws and sni', () => {
    expect(
      surgeProxyLine(
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
      line: `VM = vmess, example.com, 443, username=${UUID}, tls=true, ws=true, ws-path=/ws, ws-headers=Host:cdn.example.com, sni=sni.example.com`,
    });
  });

  it('emits plain TCP VMess with ws=false and skip-cert-verify', () => {
    expect(
      surgeProxyLine(
        node({
          type: 'vmess',
          name: 'VM',
          uuid: UUID,
          tls: true,
          'skip-cert-verify': true,
          network: undefined,
        }),
      ),
    ).toEqual({
      line: `VM = vmess, example.com, 8388, username=${UUID}, tls=true, skip-cert-verify=true, ws=false`,
    });
  });

  it('emits Trojan with password, sni and skip-cert-verify', () => {
    expect(
      surgeProxyLine(
        node({
          type: 'trojan',
          name: 'TJ',
          port: 443,
          password: 'fake-password',
          sni: 'trojan.example.com',
          'skip-cert-verify': false,
        }),
      ),
    ).toEqual({
      line: 'TJ = trojan, example.com, 443, password=fake-password, sni=trojan.example.com, skip-cert-verify=false',
    });
  });

  it('emits TUIC with the uuid:password token', () => {
    expect(
      surgeProxyLine(
        node({
          type: 'tuic',
          name: 'TUIC',
          port: 443,
          uuid: UUID,
          password: 'fake-password',
          sni: 'tuic.example.com',
        }),
      ),
    ).toEqual({
      line: `TUIC = tuic, example.com, 443, token=${UUID}:fake-password, sni=tuic.example.com`,
    });
  });

  it('emits Hysteria2 with password and sni', () => {
    expect(
      surgeProxyLine(
        node({ type: 'hysteria2', name: 'HY2', port: 443, password: 'fake-password', sni: 'hy.example.com' }),
      ),
    ).toEqual({ line: 'HY2 = hysteria2, example.com, 443, password=fake-password, sni=hy.example.com' });
  });

  it('emits AnyTLS with password, sni and skip-cert-verify (Surge iOS 5.17+/Mac 6.4.3+)', () => {
    expect(
      surgeProxyLine(
        node({ type: 'anytls', name: 'AT', port: 443, password: 'fake-password', sni: 'at.example.com' }),
      ),
    ).toEqual({
      line: 'AT = anytls, example.com, 443, password=fake-password, sni=at.example.com',
    });
    expect(
      surgeProxyLine(
        node({
          type: 'anytls',
          name: 'AT',
          port: 443,
          password: 'pw',
          servername: 'at.example.com',
          alpn: ['h2', 'http/1.1'],
          'skip-cert-verify': false,
        }),
      ),
    ).toEqual({
      line: 'AT = anytls, example.com, 443, password=pw, sni=at.example.com, alpn=h2,http/1.1, skip-cert-verify=false',
    });
  });

  it('skips AnyTLS without a password', () => {
    expect(surgeProxyLine(node({ type: 'anytls', name: 'AT', port: 443 }))).toEqual({
      skipped: 'missing or unrepresentable protocol options',
    });
  });

  it('emits Hysteria2 port hopping with semicolon-separated entries', () => {
    expect(
      surgeProxyLine(
        node({ type: 'hysteria2', name: 'HY2', port: 443, password: 'pw', ports: '60000-62000' }),
      ),
    ).toEqual({
      line: 'HY2 = hysteria2, example.com, 443, password=pw, port-hopping=60000-62000',
    });
    expect(
      surgeProxyLine(
        node({
          type: 'hysteria2',
          name: 'HY2',
          port: 443,
          password: 'pw',
          ports: '60000,61000-62000',
          'hop-interval': 15,
          down: '100',
          up: '50',
          sni: 'hy.example.com',
        }),
      ),
    ).toEqual({
      line: 'HY2 = hysteria2, example.com, 443, password=pw, sni=hy.example.com, port-hopping=60000;61000-62000, port-hopping-interval=15, download-bandwidth=100',
    });
    // An unusable list leaves no `port-hopping` (the declaration port applies).
    expect(surgePortHopping('garbage')).toBeUndefined();
    expect(surgePortHopping('5000;6000-7000')).toBe('5000;6000-7000');
  });

  it.each(['socks5', 'socks'])('emits SOCKS credentials for %s', (type) => {
    expect(
      surgeProxyLine(
        node({ type, name: 'SOCKS', port: 1080, username: 'user', password: 'fake' }),
      ),
    ).toEqual({ line: 'SOCKS = socks5, example.com, 1080, username=user, password=fake' });
  });

  it('emits a plain HTTP proxy without credentials', () => {
    expect(surgeProxyLine(node({ type: 'http', name: 'HTTP', port: 8080 }))).toEqual({
      line: 'HTTP = http, example.com, 8080',
    });
  });
});

describe('Surge producer: skipped types', () => {
  it.each([
    ['vless', { uuid: UUID, tls: true }],
    ['ssr', { cipher: 'aes-256-cfb', password: 'fake', protocol: 'origin', obfs: 'plain' }],
  ])('skips %s (no Surge support) and counts it', (type, fields) => {
    const result = buildSurgeProxies([
      node({ type, name: 'skipped', ...fields }),
      node({ name: 'kept', cipher: 'aes-128-gcm', password: 'fake' }),
    ]);

    expect(result.names).toEqual(['kept']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.name).toBe('skipped');
  });

  it('skips Shadowsocks plugins, non-WS VMess transports and WS Trojan', () => {
    const result = buildSurgeProxies([
      node({ name: 'ss-obfs', cipher: 'aes-128-gcm', password: 'p', plugin: 'obfs' }),
      node({ type: 'vmess', name: 'vmess-grpc', uuid: UUID, network: 'grpc' }),
      node({ type: 'trojan', name: 'trojan-ws', password: 'p', network: 'ws' }),
    ]);
    expect(result.lines).toEqual([]);
    expect(result.skipped.map((entry) => entry.name)).toEqual(['ss-obfs', 'vmess-grpc', 'trojan-ws']);
  });

  it('skips nodes missing credentials', () => {
    expect(buildSurgeProxies([node({ name: 'no-password', cipher: 'aes-128-gcm' })]).skipped).toHaveLength(1);
  });

  it('never emits a mihomo-YAML body, even when everything is skipped', () => {
    const body = produceSurge([node({ type: 'vless', name: 'only-vless', uuid: UUID })]);
    expect(body).not.toContain('proxies:');
    expect(body).not.toContain('- name:');
    // Empty but valid: Surge loads a config with no proxies.
    expect(body).toBe('');
  });
});

describe('Surge producer: [Proxy Group]', () => {
  const nodes = [
    node({ name: 'hk-01', cipher: 'aes-128-gcm', password: 'p' }),
    node({ type: 'vless', name: 'vless-01', uuid: UUID }),
    node({ type: 'trojan', name: 'us-01', password: 'p' }),
  ];

  it('keeps AnyTLS nodes in the [Proxy] section and in their groups', () => {
    const nodes = [
      node({ type: 'anytls', name: 'at-01', port: 443, password: 'p', sni: 'at.example.com' }),
      node({ name: 'ss-01', cipher: 'aes-128-gcm', password: 'p' }),
      node({ type: 'vless', name: 'vless-01', uuid: UUID }),
    ];
    const proxies = buildSurgeProxies(nodes);
    expect(proxies.names).toEqual(['at-01', 'ss-01']);
    expect(proxies.lines[0]).toBe(
      'at-01 = anytls, example.com, 443, password=p, sni=at.example.com',
    );
    // VLESS is still skipped: only the anytls node is counted as emitted here.
    expect(proxies.skipped.map((entry) => entry.name)).toEqual(['vless-01']);

    const body = produceSurge(nodes, [
      group({ name: 'nodes', type: 'select', proxies: ['at-01', 'vless-01', 'ss-01'] }),
    ]);
    expect(body).toContain('at-01 = anytls,');
    expect(body).toContain('nodes = select,at-01,ss-01');
    expect(body).not.toContain('vless-01');
  });

  it('maps select/url-test/fallback/load-balance to Surge keywords', () => {
    const groups = buildSurgeGroups(
      [
        group({ name: 'sel', type: 'select', proxies: ['hk-01'] }),
        group({ name: 'auto', type: 'url-test', proxies: ['hk-01'], url: 'https://example.com/generate_204', interval: 300, tolerance: 50 }),
        group({ name: 'fb', type: 'fallback', proxies: ['us-01'] }),
        group({ name: 'lb', type: 'load-balance', proxies: ['hk-01', 'us-01'] }),
      ],
      buildSurgeProxies(nodes).names,
    );

    expect(groups.map((entry) => entry.type)).toEqual(['select', 'url-test', 'fallback', 'load-balance']);
    expect(groups[1]).toMatchObject({
      url: 'https://example.com/generate_204',
      interval: 300,
      tolerance: 50,
    });
  });

  it('renders group lines in Surge syntax', () => {
    const body = produceSurge(nodes, [
      group({ name: '🚀 节点选择', type: 'select', proxies: ['hk-01', 'us-01'] }),
      group({ name: '⚡ auto', type: 'url-test', proxies: ['hk-01', 'us-01'], url: 'https://example.com/generate_204', interval: 300 }),
    ]);

    expect(body).toContain('🚀 节点选择 = select,hk-01,us-01');
    expect(body).toContain('⚡ auto = url-test,hk-01,us-01,url=https://example.com/generate_204,interval=300');
  });

  it('prunes references to skipped nodes and keeps DIRECT/REJECT', () => {
    const [sel] = buildSurgeGroups(
      [group({ name: 'sel', type: 'select', proxies: ['vless-01', 'hk-01', 'DIRECT', 'REJECT'] })],
      buildSurgeProxies(nodes).names,
    );

    expect(sel!.members).toEqual(['hk-01', 'DIRECT', 'REJECT']);
  });

  it('drops a group that only referenced a skipped node (vless-only group)', () => {
    const groups = buildSurgeGroups(
      [
        group({ name: 'only-vless', type: 'select', proxies: ['vless-01'] }),
        group({ name: 'nodes', type: 'select', proxies: ['hk-01', 'us-01'] }),
      ],
      buildSurgeProxies(nodes).names,
    );

    expect(groups.map((entry) => entry.name)).toEqual(['nodes']);
  });

  it('drops references to a group that disappeared, recursively', () => {
    const groups = buildSurgeGroups(
      [
        group({ name: 'outer', type: 'select', proxies: ['only-vless'] }),
        group({ name: 'only-vless', type: 'select', proxies: ['vless-01'] }),
        group({ name: 'nodes', type: 'select', proxies: ['hk-01'] }),
      ],
      buildSurgeProxies(nodes).names,
    );

    expect(groups.map((entry) => entry.name)).toEqual(['nodes']);
  });

  it('keeps a group that references another emitted group', () => {
    const groups = buildSurgeGroups(
      [
        group({ name: 'nodes', type: 'select', proxies: ['hk-01'] }),
        group({ name: 'all', type: 'select', proxies: ['nodes', 'DIRECT'] }),
      ],
      buildSurgeProxies(nodes).names,
    );

    expect(groups.map((entry) => entry.name)).toEqual(['nodes', 'all']);
    expect(groups[1]!.members).toEqual(['nodes', 'DIRECT']);
  });

  it('ignores group types Surge has no equivalent for (relay)', () => {
    expect(
      buildSurgeGroups([group({ name: 'relay', type: 'relay', proxies: ['hk-01'] })], ['hk-01']),
    ).toEqual([]);
  });

  it('emits no [Rule] and no group section when there are no groups', () => {
    const body = produceSurge(nodes);
    expect(body).not.toContain('[Rule]');
    expect(body).not.toContain(' = select');
    expect(proxyNames(body)).toEqual(['hk-01', 'us-01']);
  });
});

describe('Surge producer: robustness of the emitted document', () => {
  it('keeps TUIC credential joining exact (uuid:password, never a doubled colon)', () => {
    expect(
      surgeProxyLine(node({ type: 'tuic', name: 'T', port: 443, uuid: UUID, password: 'pw' })),
    ).toEqual({ line: `T = tuic, example.com, 443, token=${UUID}:pw` });
    // A UUID-less node has no `uuid:password` token to write: skipped, not faked.
    expect(
      surgeProxyLine(node({ type: 'tuic', name: 'T', port: 443, password: 'pw' })),
    ).toEqual({ skipped: 'missing or unrepresentable protocol options' });
  });

  it('carries the Hysteria2 obfs and alpn settings Surge supports', () => {
    expect(
      surgeProxyLine(
        node({
          type: 'hysteria2',
          name: 'HY2',
          port: 443,
          password: 'pw',
          obfs: 'salamander',
          'obfs-password': 'op',
          alpn: ['h3'],
          sni: 'hy.example.com',
        }),
      ),
    ).toEqual({
      line: 'HY2 = hysteria2, example.com, 443, password=pw, obfs=salamander, obfs-password=op, sni=hy.example.com, alpn=h3',
    });
  });

  it('never lets a node or group name inject a new line or section', () => {
    // A name is written before ` = `; a CR/LF would start a new config line
    // (e.g. a `[Rule]` section) and `=` would move the assignment.
    expect(surgeProxyLine(node({ name: 'evil\n[Rule]\nFINAL,DIRECT', cipher: 'aes-128-gcm', password: 'p' }))).toEqual({
      skipped: 'name not representable in a config line',
    });

    const body = produceSurge(
      [node({ name: 'hk', cipher: 'aes-128-gcm', password: 'p' })],
      [
        group({ name: 'g\n[Rule]', type: 'select', proxies: ['hk'] }),
        group({ name: 'ok', type: 'select', proxies: ['hk\n[Rule]', 'hk'] }),
      ],
    );
    expect(body).not.toContain('[Rule]');
    expect(body).toContain('ok = select,hk');
  });

  it('drops duplicate node names (a policy may only be defined once)', () => {
    const result = buildSurgeProxies([
      node({ name: 'dup', cipher: 'aes-128-gcm', password: 'first' }),
      node({ name: 'dup', cipher: 'aes-128-gcm', password: 'second' }),
      node({ name: 'DUP', cipher: 'aes-128-gcm', password: 'third' }),
    ]);
    expect(result.names).toEqual(['dup']);
    expect(result.lines).toHaveLength(1);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['duplicate name', 'duplicate name']);
  });
});
