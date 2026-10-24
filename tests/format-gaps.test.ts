// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Format-gap regressions on a "real subscription" shaped fixture
 * (ss / ssr / vless / anytls / tuic / hy2 with and without port hopping,
 * plus the node kinds each client genuinely cannot load).
 *
 * The per-target counts are the contract: the old Shadowrocket hy2 builder
 * dropped every node with `ports`/`up`/`down`, and Surge dropped every anytls
 * node, so a real 71-node set lost 11 nodes on one target and all anytls nodes
 * on the other. Both are silent data loss, and these counts catch a relapse.
 */
import { describe, expect, it } from 'vitest';
import type { ClashProxyGroup, ProxyNode } from '../core/types';
import {
  buildShareLinks,
  buildShadowrocketLinks,
  produceShadowrocket,
  produceSurge,
  buildSurgeProxies,
} from '../core/producers';
import { parseSubscription, parseUri } from '../core/parsers';
import { decodeBase64 } from '../core/utils';

const UUID = '11111111-2222-3333-4444-555555555555';

/** jhxdir-style mix: modern protocols, hop/no-hop hy2, plus unloadable kinds. */
const FIXTURE: ProxyNode[] = [
  { type: 'ss', name: 'ss-01', server: 'ss.example.com', port: 8388, cipher: 'aes-256-gcm', password: 'fake' },
  { type: 'ssr', name: 'ssr-01', server: 'ssr.example.com', port: 8388, cipher: 'aes-256-cfb', password: 'fake', protocol: 'origin', obfs: 'plain' },
  { type: 'vless', name: 'vless-01', server: 'v.example.com', port: 443, uuid: UUID, tls: true, sni: 'v.example.com' },
  { type: 'anytls', name: 'anytls-01', server: 'a.example.com', port: 443, password: 'fake', sni: 'a.example.com' },
  { type: 'tuic', name: 'tuic-01', server: 't.example.com', port: 443, uuid: UUID, password: 'fake', sni: 't.example.com' },
  { type: 'hysteria2', name: 'hy2-01', server: 'h1.example.com', port: 443, password: 'fake', sni: 'h1.example.com' },
  { type: 'hysteria2', name: 'hy2-hop-range', server: 'h2.example.com', port: 443, password: 'fake', ports: '60000-62000', sni: 'h2.example.com' },
  { type: 'hysteria2', name: 'hy2-hop-list', server: 'h3.example.com', port: 443, password: 'fake', ports: '60000,61000-62000', 'hop-interval': 30 },
  { type: 'hysteria2', name: 'hy2-bandwidth', server: 'h4.example.com', port: 443, password: 'fake', up: 50, down: 200 },
  { type: 'snell', name: 'snell-01', server: 'sn.example.com', port: 8388, psk: 'fake' },
] as ProxyNode[];

const NODE_NAMES = FIXTURE.map((entry) => entry.name);

describe('format gaps: per-target emitted counts on the mixed fixture', () => {
  it('shadowrocket emits every node that has a share-link form (incl. hopping hy2)', () => {
    const names = buildShadowrocketLinks(FIXTURE).map((line) => parseUri(line)!.name);
    expect(names).toEqual([
      'ss-01',
      'ssr-01',
      'vless-01',
      'anytls-01',
      'tuic-01',
      'hy2-01',
      'hy2-hop-range',
      'hy2-hop-list',
      'hy2-bandwidth',
    ]);
    // Only Snell has no published Shadowrocket share link.
    expect(buildShadowrocketLinks(FIXTURE)).toHaveLength(FIXTURE.length - 1);
    // The full body round-trips through the repo's parser.
    const body = produceShadowrocket(FIXTURE);
    expect(parseSubscription(body).map((entry) => entry.name)).toEqual(names);
  });

  it('surge emits ss/anytls/tuic/all hy2 and still skips vless/ssr/snell', () => {
    const proxies = buildSurgeProxies(FIXTURE);
    expect(proxies.names).toEqual([
      'ss-01',
      'anytls-01',
      'tuic-01',
      'hy2-01',
      'hy2-hop-range',
      'hy2-hop-list',
      'hy2-bandwidth',
    ]);
    expect(proxies.skipped.map((entry) => entry.name)).toEqual(['ssr-01', 'vless-01', 'snell-01']);
  });

  it('uri still carries all hy2 variants', () => {
    expect(buildShareLinks(FIXTURE)).toHaveLength(9);
  });
});

describe('format gaps: Surge document for the mixed fixture', () => {
  const groups: ClashProxyGroup[] = [
    { name: '🚀 节点选择', type: 'select', proxies: [...NODE_NAMES, 'DIRECT'] },
  ] as ClashProxyGroup[];

  it('writes anytls proxies, hy2 port hopping and drops skipped members', () => {
    const body = produceSurge(FIXTURE, groups);

    expect(body).toContain('anytls-01 = anytls, a.example.com, 443, password=fake, sni=a.example.com');
    expect(body).toContain(
      'hy2-hop-range = hysteria2, h2.example.com, 443, password=fake, sni=h2.example.com, port-hopping=60000-62000',
    );
    expect(body).toContain(
      'hy2-hop-list = hysteria2, h3.example.com, 443, password=fake, port-hopping=60000;61000-62000, port-hopping-interval=30',
    );
    expect(body).toContain(
      'hy2-bandwidth = hysteria2, h4.example.com, 443, password=fake, download-bandwidth=200',
    );
    // Port hopping never leaks the single declared port as a range.
    expect(body).not.toContain('port-hopping=443');

    expect(body).toContain(
      '🚀 节点选择 = select,ss-01,anytls-01,tuic-01,hy2-01,hy2-hop-range,hy2-hop-list,hy2-bandwidth,DIRECT',
    );
    expect(body).not.toContain('vless-01');
    expect(body).not.toContain('ssr-01');
  });
});

describe('format gaps: Shadowrocket hy2 matches uri.ts field by field', () => {
  it('emits the same mport/upmbps/downmbps values for the same nodes', () => {
    const hy2 = FIXTURE.filter((entry) => entry.type === 'hysteria2');
    const shadowrocket = buildShadowrocketLinks(hy2);
    const uri = buildShareLinks(hy2);
    expect(shadowrocket).toHaveLength(hy2.length);

    for (const [index, line] of shadowrocket.entries()) {
      const parsed = parseUri(line)!;
      const reference = parseUri(uri[index]!)!;
      expect(parsed.ports).toBe(reference.ports);
      expect(parsed.up).toBe(reference.up);
      expect(parsed.down).toBe(reference.down);

      // Query-level equality for the three hop/bandwidth keys.
      const query = (value: string) => new URLSearchParams(value.split('?')[1]!.split('#')[0]!);
      for (const key of ['mport', 'upmbps', 'downmbps']) {
        expect(query(line).get(key), `${hy2[index]!.name} ${key}`).toBe(query(uri[index]!).get(key));
      }
    }
  });

  it('keeps the subscription body base64-encoded with the hop params inside', () => {
    const body = produceShadowrocket(FIXTURE);
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const links = decodeBase64(body).split('\n');
    expect(links.some((line) => line.includes('mport=60000-62000'))).toBe(true);
  });
});
