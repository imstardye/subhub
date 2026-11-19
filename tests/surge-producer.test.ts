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
import { parseUri } from '../core/parsers/uri';
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
  it.each([1, 2, 3, 4, 5, 6, undefined])('emits Snell version %s with automatic UDP', (version) => {
    expect(surgeProxyLine(node({ type: 'snell', version, psk: 'fixture-snell-psk', udp: true }))).toEqual({
      line: `test = snell, example.com, 8388, psk=fixture-snell-psk, version=${version ?? 1}`,
    });
  });

  it('maps Snell obfs, reuse and UDP port only where supported', () => {
    expect(surgeProxyLine(node({
      type: 'snell', version: 5, psk: 'fixture', reuse: true, 'udp-port': 443,
      'obfs-opts': { mode: 'http', host: 'cover.example.com', path: '/' },
    }))).toEqual({
      line: 'test = snell, example.com, 8388, psk=fixture, version=5, obfs=http, obfs-host=cover.example.com, obfs-uri=/, reuse=true, udp-port=443',
    });
    expect(surgeProxyLine(node({
      type: 'snell', version: 3, psk: 'fixture', 'obfs-opts': { mode: 'tls', host: 'cover.example.com' },
    }))).toEqual({
      line: 'test = snell, example.com, 8388, psk=fixture, version=3, obfs=tls, obfs-host=cover.example.com',
    });
    expect(surgeProxyLine(node({
      type: 'snell', version: 6, psk: 'fixture-snell-psk', mode: 'unshaped',
      'obfs-opts': { mode: 'http', host: 'cover.example.com' },
    }))).toEqual({
      line: 'test = snell, example.com, 8388, psk=fixture-snell-psk, version=6, mode=unshaped',
    });
  });

  it.each([
    { version: 7, psk: 'fixture' },
    { version: 4 },
    { version: 6, psk: 'short' },
    { version: 6, psk: 'fixture-snell-psk', userkey: 'client-id' },
    { version: 4, psk: 'fixture', 'obfs-opts': { mode: 'tls' } },
  ])('skips unrepresentable Snell options %j', (options) => {
    expect(surgeProxyLine(node({ type: 'snell', ...options }))).toHaveProperty('skipped');
  });

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

describe('Surge native VLESS (manual.nssurge.com/policies/vless.html)', () => {
  const encryption = 'mlkem768x25519plus.native.0rtt.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const security = {
    none: {}, tls: { tls: true },
    reality: { tls: true, 'reality-opts': { 'public-key': 'public-key', 'short-id': 'abcd' } },
  };
  for (const network of ['raw', 'tcp', 'ws', 'httpupgrade', 'grpc', 'xhttp']) {
    for (const [mode, fields] of Object.entries(security)) {
      const supported = !(['ws', 'httpupgrade'].includes(network) && mode === 'reality') && !(network === 'grpc' && mode === 'none');
      it(`${network} + ${mode}: ${supported ? 'native line' : 'diagnostic'}`, () => {
        const base = `test = vless, example.com, 8388, username=${UUID}`;
        const tls = mode === 'tls' ? ', tls=true' : mode === 'reality' ? ', reality-public-key=public-key, reality-short-id=abcd' : '';
        const transport = network === 'ws' ? ', ws=true, ws-path=/' : network === 'httpupgrade' ? ', ws=true, ws-http-upgrade=true, ws-path=/' : network === 'grpc' ? ', grpc=true' : network === 'xhttp' ? ', xhttp=true, xhttp-path=/' : '';
        const proxy = node({ type: 'vless', uuid: UUID, network, ...fields });
        expect(surgeProxyLine(proxy)).toEqual(supported ? { line: base + tls + transport } : { skipped: 'missing or unrepresentable protocol options' });
        for (const flow of ['xtls-rprx-vision', 'xtls-rprx-vision-udp443']) {
          const vision = surgeProxyLine({ ...proxy, flow });
          const allowed = supported && ['raw', 'tcp'].includes(network) && mode !== 'none';
          expect(vision).toHaveProperty(allowed ? 'line' : 'skipped');
          const encrypted = surgeProxyLine({ ...proxy, flow, encryption });
          expect(encrypted).toHaveProperty(supported && network !== 'grpc' ? 'line' : 'skipped');
          if ('line' in encrypted) expect(encrypted.line).toContain(`encryption=${encryption}, flow=${flow}`);
        }
        const encrypted = surgeProxyLine({ ...proxy, encryption });
        expect(encrypted).toHaveProperty(supported ? 'line' : 'skipped');
      });
    }
  }

  it.each(['auto', 'stream-one', 'stream-up', 'packet-up'])('emits XHTTP mode %s, host, headers and quoted ALPN', (mode) => {
    expect(surgeProxyLine(node({ type: 'vless', uuid: UUID, network: 'xhttp', tls: true,
      sni: 'sni.example', alpn: ['h2', 'http/1.1'], 'skip-cert-verify': false,
      'xhttp-opts': { path: '/x?key=value', host: 'cdn.example', mode, headers: { 'X-Token': 'abc' } },
    }))).toEqual({ line: `test = vless, example.com, 8388, username=${UUID}, tls=true, skip-cert-verify=false, sni=sni.example, alpn="h2,http/1.1", xhttp=true, xhttp-path=/x?key=value, xhttp-host=cdn.example, xhttp-mode=${mode}, xhttp-headers=X-Token:abc` });
  });

  it.each([['chrome', 'chromium-155'], ['safari', 'apple-26'], ['firefox', 'auto'], ['none', 'none']])('maps fingerprint %s using Surge share-link documentation', (input, output) => {
    expect(surgeProxyLine(node({ type: 'vless', uuid: UUID, tls: true, 'client-fingerprint': input }))).toEqual({
      line: `test = vless, example.com, 8388, username=${UUID}, tls=true, client-fingerprint=${output}`,
    });
  });

  it('writes the documented RAW + Encryption + Vision line without TLS', () => {
    expect(surgeProxyLine(node({ type: 'vless', uuid: UUID, encryption, flow: 'xtls-rprx-vision' }))).toEqual({
      line: `test = vless, example.com, 8388, username=${UUID}, encryption=${encryption}, flow=xtls-rprx-vision`,
    });
  });

  it('imports existing type=httpupgrade links without losing upgrade or headers', () => {
    const parsed = parseUri(`vless://${UUID}@example.com:443?type=httpupgrade&security=tls&path=%2Fup&host=cdn.example#Upgrade`)!;
    expect(surgeProxyLine(parsed)).toEqual({ line: `Upgrade = vless, example.com, 443, username=${UUID}, tls=true, ws=true, ws-http-upgrade=true, ws-path=/up, ws-headers=Host:cdn.example` });
  });

  it('retains URI gRPC mode and authority despite internal metadata cleanup', () => {
    const parsed = parseUri(`vless://${UUID}@example.com:443?type=grpc&security=tls&serviceName=svc&authority=grpc.example&mode=multi#GRPC`)!;
    expect(surgeProxyLine(parsed)).toEqual({ line: `GRPC = vless, example.com, 443, username=${UUID}, tls=true, grpc=true, grpc-service-name=svc, grpc-mode=multi, grpc-authority=grpc.example` });
  });

  it.each([
    {}, { network: 'kcp' }, { network: 'h2' }, { network: 'http' },
    { network: 'xhttp', 'xhttp-opts': { 'download-settings': { server: 'download.example' } } },
    { network: 'xhttp', 'xhttp-opts': { 'reuse-settings': { max: 3 } } },
    { network: 'xhttp', 'xhttp-opts': { mode: 'future' } },
    { network: 'ws', 'ws-opts': { 'max-early-data': 2048 } },
    { 'packet-encoding': 'packetaddr' }, { flow: 'future' }, { 'reality-opts': {} },
    { finalmask: '{}' }, { 'reality-opts': { 'public-key': 'pk', 'support-x25519mlkem768': true } },
    { 'reality-opts': { 'public-key': 'pk', 'support-x25519mlkem768': false } },
    { encryption: 'evil, tls=true' }, { uuid: 'evil\n[Rule]' },
  ])('diagnoses unsupported options %j and prunes their group references', (options) => {
    const proxy = node({ type: 'vless', uuid: UUID, ...options });
    if (Object.keys(options).length === 0) delete proxy.uuid;
    const result = buildSurgeProxies([proxy]);
    expect(result.lines).toEqual([]);
    expect(result.skipped[0]?.reason).toBeTruthy();
    expect(produceSurge([proxy], [group({ proxies: ['test'] })])).toBe('');
  });
});

describe('Surge producer: skipped types', () => {
  it.each([
    ['wireguard', {}],
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
    const body = produceSurge([node({ type: 'vless', name: 'only-vless', uuid: UUID, network: 'kcp' })]);
    expect(body).not.toContain('proxies:');
    expect(body).not.toContain('- name:');
    // Empty but valid: Surge loads a config with no proxies.
    expect(body).toBe('');
  });
});

describe('Surge producer: [Proxy Group]', () => {
  const nodes = [
    node({ name: 'hk-01', cipher: 'aes-128-gcm', password: 'p' }),
    node({ type: 'vless', name: 'vless-01', uuid: UUID, network: 'kcp' }),
    node({ type: 'trojan', name: 'us-01', password: 'p' }),
  ];

  it('keeps AnyTLS nodes in the [Proxy] section and in their groups', () => {
    const nodes = [
      node({ type: 'anytls', name: 'at-01', port: 443, password: 'p', sni: 'at.example.com' }),
      node({ name: 'ss-01', cipher: 'aes-128-gcm', password: 'p' }),
      node({ type: 'vless', name: 'vless-01', uuid: UUID }),
    ];
    const proxies = buildSurgeProxies(nodes);
    expect(proxies.names).toEqual(['at-01', 'ss-01', 'vless-01']);
    expect(proxies.lines[0]).toBe(
      'at-01 = anytls, example.com, 443, password=p, sni=at.example.com',
    );
    expect(proxies.skipped).toEqual([]);

    const body = produceSurge(nodes, [
      group({ name: 'nodes', type: 'select', proxies: ['at-01', 'vless-01', 'ss-01'] }),
    ]);
    expect(body).toContain('at-01 = anytls,');
    expect(body).toContain('nodes = select,at-01,vless-01,ss-01');
    expect(body).toContain('vless-01 = vless,');
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
