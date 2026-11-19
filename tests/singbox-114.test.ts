import { describe, expect, it } from 'vitest';
import { parseClashYaml } from '../core/parsers/clash';
import { buildSingboxEndpoints, buildSingboxOutboundResult, produceSingbox } from '../core/producers/singbox';
import { buildMihomoProxyResult } from '../core/producers/mihomo';
import { buildShareLinkResult } from '../core/producers/uri';
import { buildShadowrocketSubscription } from '../core/producers/shadowrocket';
import { buildSurgeProxies } from '../core/producers/surge';
import { buildLoonProxies } from '../core/producers/loon';
import { buildShadowrocketConfProxies } from '../core/producers/shadowrocket-conf';

const vpn = { type: 'openvpn', name: 'vpn', server: 'vpn.example.com', port: 1194,
  username: 'user', password: 'pass', ca: 'CA PEM', proto: 'tcp',
  'data-ciphers': ['AES-256-GCM', 'AES-128-GCM'], auth: 'SHA256',
  'tls-auth': 'STATIC KEY', 'key-direction': '1', ping: 10, 'ping-restart': 60 };
const oc = { type: 'openconnect', name: 'oc', server: 'https://vpn.example.com:8443/group',
  flavor: 'anyconnect', username: 'user', password: 'pass', auth_group: 'staff',
  tls: { insecure: false, server_name: 'vpn.example.com' } };
function parse(entries: unknown[]) { return parseClashYaml(JSON.stringify({ proxies: entries })); }

describe('sing-box 1.14 documented subscriptions', () => {
  it('retains OpenVPN and native OpenConnect fields without mutating input', () => {
    const nodes = parse([vpn, oc]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual(vpn);
    expect(nodes[1]).toMatchObject(oc);
    const before = JSON.stringify(nodes);
    expect(JSON.parse(produceSingbox(nodes))).toEqual({ outbounds: [], endpoints: [
      { type: 'openvpn-client', tag: 'vpn', server: vpn.server, server_port: 1194,
        network: 'tcp', username: 'user', password: 'pass', auth: 'SHA256',
        data_ciphers: vpn['data-ciphers'], ping_interval: '10s', ping_restart: '60s',
        tls: { certificate: ['CA PEM'], control_wrap: { type: 'tls_auth', key: ['STATIC KEY'], direction: 'client' } } },
      { type: 'openconnect', tag: 'oc', server: oc.server, flavor: oc.flavor,
        username: oc.username, password: oc.password, auth_group: oc.auth_group, tls: oc.tls },
    ] });
    expect(JSON.stringify(nodes)).toBe(before);
    expect(buildSingboxOutboundResult(nodes).skipped).toEqual([]);
  });

  it('maps certificate auth, wrapping, compression and differing OpenVPN defaults', () => {
    const [endpoint] = buildSingboxEndpoints(parse([{ ...vpn, username: undefined, password: undefined,
      cert: 'CERT', key: 'KEY', 'tls-auth': undefined, 'tls-crypt-v2': 'WRAP',
      'data-ciphers': undefined, 'comp-lzo': 'adaptive', 'ping-restart': 0 }]));
    expect(endpoint).toMatchObject({ data_ciphers: ['AES-128-GCM'], auth: 'SHA256',
      compression_lzo: 'adaptive', allow_compression: 'asym', ping_restart_disabled: true,
      tls: { client_certificate: ['CERT'], client_key: ['KEY'], control_wrap: { type: 'tls_crypt_v2', key: ['WRAP'] } } });
    expect(endpoint).not.toHaveProperty('ping_restart');
  });

  it('fails closed for unrepresentable VPN features and missing credentials/CA', () => {
    for (const extra of [{ ca: '' }, { password: '' }, { 'peer-info': { UV_ID: 'x' } },
      { 'tran-window': 0 }, { 'tls-crypt': 'second wrap' }, { proto: 'invalid' }]) {
      const nodes = parse([{ ...vpn, ...extra }]);
      expect(buildSingboxEndpoints(nodes)).toEqual([]);
      expect(buildSingboxOutboundResult(nodes).skipped).toHaveLength(1);
    }
  });

  it('retains documented HY2 fields and translates randomized hopping/gecko/BBR', () => {
    const input = { type: 'hysteria2', name: 'hy2', server: 'hy.example.com', port: 443,
      password: 'pass', ports: '443,8443-8450', 'hop-interval': '15-30',
      'bbr-profile': 'aggressive', obfs: 'gecko', 'obfs-password': 'secret',
      'obfs-min-packet-size': 600, 'obfs-max-packet-size': 1100 };
    const nodes = parse([input]);
    expect(nodes[0]).toEqual(input);
    const { outbounds } = JSON.parse(produceSingbox(nodes));
    expect(outbounds).toEqual([{ type: 'hysteria2', tag: 'hy2', server: 'hy.example.com',
      password: 'pass', tls: { enabled: true }, server_ports: ['443:443', '8443:8450'],
      hop_interval: '15s', hop_interval_max: '30s', bbr_profile: 'aggressive',
      obfs: { type: 'gecko', password: 'secret', min_packet_size: 600, max_packet_size: 1100 } }]);
  });

  it('realm replaces all server fields, only when explicitly enabled', () => {
    const realm = { enable: true, 'server-url': 'https://realm.example.com', token: 'public',
      'realm-id': 'slot', 'stun-servers': ['stun.example.com:3478'] };
    const input = { type: 'hysteria2', name: 'realm', password: 'pass',
      'realm-opts': realm, sni: 'hy.example.com', ports: '443-444' };
    const nodes = parse([input]);
    expect(nodes).toHaveLength(1);
    expect(JSON.parse(produceSingbox(nodes)).outbounds).toEqual([{
      type: 'hysteria2', tag: 'realm', password: 'pass', tls: { enabled: true, server_name: 'hy.example.com' },
      realm: { server_url: realm['server-url'], token: 'public', realm_id: 'slot', stun_servers: realm['stun-servers'] },
    }]);
    expect(parse([{ ...input, 'realm-opts': { ...realm, enable: false } }])).toEqual([]);
    expect(buildSingboxOutboundResult(parse([{ ...input, 'realm-opts': { ...realm, fingerprint: 'unmapped' } }])).skipped).toHaveLength(1);
  });

  it('other producers report unsupported types; mihomo alone supports OpenVPN', () => {
    const nodes = parse([vpn, oc]);
    expect(buildMihomoProxyResult(nodes).proxies.map(n => n.type)).toEqual(['openvpn']);
    expect(buildMihomoProxyResult(nodes).skipped).toHaveLength(1);
    for (const build of [buildShareLinkResult, buildShadowrocketSubscription, buildSurgeProxies,
      buildLoonProxies, buildShadowrocketConfProxies]) {
      const result = build(nodes);
      expect(result.lines).toEqual([]);
      expect(result.skipped).toHaveLength(2);
    }
  });

  it('emits no deprecated template fields (no DNS/rules/TUN template exists)', () => {
    const config = JSON.parse(produceSingbox(parse([vpn, oc])));
    expect(Object.keys(config).sort()).toEqual(['endpoints', 'outbounds']);
    expect(JSON.stringify(config)).not.toMatch(/download_detour|acme|independent_cache|store_rdrc|recv_window|disable_mtu_discovery/);
  });
});
