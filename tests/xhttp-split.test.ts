// SPDX-License-Identifier: AGPL-3.0-only
/**
 * VLESS + XHTTP split upload/download support.
 *
 * Internal shape = mihomo's `xhttp-opts['download-settings']`; the share-link
 * shape = Xray's `extra.downloadSettings` stream config. Every producer test
 * compares the decoded JSON against the exact Xray fixture from the task.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { ProxyNode } from '../core/types';
import {
  buildLoonProxies,
  buildShadowrocketLinks,
  produceMihomo,
  produceSingbox,
  buildSingboxOutbounds,
  buildShareLinks,
  parseUri,
  shadowrocketConfProxyLine,
  buildShadowrocketConfProxies,
} from '../core';
import { parseQuery } from '../core/utils';

const UUID = '11111111-2222-3333-4444-555555555555';
const PUBLIC_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const DOWNLOAD = {
  server: '1.2.3.4',
  port: 443,
  tls: true,
  servername: 'reality.example.com',
  'client-fingerprint': 'chrome',
  'reality-opts': {
    'public-key': PUBLIC_KEY,
    'short-id': '0123456789abcdef',
  },
  path: '/secret-path',
};

const XRAY_DOWNLOAD = {
  address: '1.2.3.4',
  port: 443,
  network: 'xhttp',
  security: 'reality',
  realitySettings: {
    serverName: 'reality.example.com',
    fingerprint: 'chrome',
    publicKey: PUBLIC_KEY,
    shortId: '0123456789abcdef',
  },
  xhttpSettings: {
    path: '/secret-path',
    mode: 'auto',
  },
};

function node(overrides: Partial<ProxyNode> = {}): ProxyNode {
  return {
    type: 'vless',
    name: 'XHTTP split',
    server: 'cdn.example.com',
    port: 443,
    uuid: UUID,
    tls: true,
    servername: 'cdn.example.com',
    'client-fingerprint': 'chrome',
    alpn: ['h2'],
    network: 'xhttp',
    'xhttp-opts': {
      path: '/secret-path',
      mode: 'auto',
      'download-settings': { ...DOWNLOAD },
    },
    ...overrides,
  } as ProxyNode;
}

function uplinkLink(extra: string): string {
  const query = [
    'type=xhttp',
    'security=tls',
    'sni=cdn.example.com',
    'alpn=h2',
    'fp=chrome',
    'path=%2Fsecret-path',
    'mode=auto',
    `extra=${encodeURIComponent(extra)}`,
  ].join('&');
  return `vless://${UUID}@cdn.example.com:443?${query}#XHTTP`;
}

function extraOf(link: string): Record<string, unknown> {
  const rawQuery = link.slice(link.indexOf('?') + 1, link.indexOf('#'));
  const extra = parseQuery(rawQuery).extra;
  expect(extra).toBeTypeOf('string');
  return JSON.parse(extra) as Record<string, unknown>;
}

describe('XHTTP split: VLESS parser', () => {
  it('maps Xray downloadSettings onto mihomo download-settings', () => {
    const parsed = parseUri(
      uplinkLink(JSON.stringify({ downloadSettings: XRAY_DOWNLOAD })),
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.network).toBe('xhttp');
    expect(parsed!['xhttp-opts']).toMatchObject({
      path: '/secret-path',
      mode: 'auto',
    });
    expect((parsed!['xhttp-opts'] as Record<string, unknown>).host).toBeUndefined();
    expect(
      (parsed!['xhttp-opts'] as Record<string, unknown>)['download-settings'],
    ).toEqual(DOWNLOAD);
  });

  it('ignores a malformed extra and keeps the node', () => {
    const parsed = parseUri(uplinkLink('{not json'));

    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('vless');
    expect(parsed!.network).toBe('xhttp');
    expect(parsed!['xhttp-opts']).toMatchObject({
      path: '/secret-path',
      mode: 'auto',
    });
    expect(
      (parsed!['xhttp-opts'] as Record<string, unknown>)['download-settings'],
    ).toBeUndefined();
  });
});

describe('XHTTP split: uri producer', () => {
  it('emits one extra param whose JSON equals the Xray fixture', () => {
    const [link] = buildShareLinks([node()]);
    expect(link).toBeTypeOf('string');
    expect(link!.startsWith(`vless://${UUID}@cdn.example.com:443?`)).toBe(true);

    const query = parseQuery(link!.slice(link!.indexOf('?') + 1, link!.indexOf('#')));
    expect(query).toMatchObject({
      type: 'xhttp',
      security: 'tls',
      sni: 'cdn.example.com',
      alpn: 'h2',
      fp: 'chrome',
      path: '/secret-path',
      mode: 'auto',
    });
    expect(extraOf(link!)).toEqual({ downloadSettings: XRAY_DOWNLOAD });
  });

  it('round-trips parse(emit(node)) with the same download settings', () => {
    const [link] = buildShareLinks([node()]);
    const parsed = parseUri(link!)!;

    expect(
      (parsed['xhttp-opts'] as Record<string, unknown>)['download-settings'],
    ).toEqual(DOWNLOAD);
    expect(buildShareLinks([parsed])[0]).toBe(link);
  });

  it('uses tlsSettings and inherits the uplink path/host/mode when unset', () => {
    const [link] = buildShareLinks([
      node({
        'xhttp-opts': {
          path: '/uplink-path',
          host: 'uplink.example.com',
          mode: 'packet-up',
          'download-settings': {
            server: '5.6.7.8',
            port: 8443,
            tls: true,
            servername: 'tls.example.com',
            alpn: ['h2'],
            'client-fingerprint': 'firefox',
            'skip-cert-verify': true,
          },
        },
      }),
    ]);

    expect(extraOf(link!)).toEqual({
      downloadSettings: {
        address: '5.6.7.8',
        port: 8443,
        network: 'xhttp',
        security: 'tls',
        tlsSettings: {
          serverName: 'tls.example.com',
          alpn: ['h2'],
          fingerprint: 'firefox',
          allowInsecure: true,
        },
        xhttpSettings: {
          path: '/uplink-path',
          host: 'uplink.example.com',
          mode: 'packet-up',
        },
      },
    });
  });
});

describe('XHTTP split: Shadowrocket producer', () => {
  it('emits the same XHTTP link and extra JSON', () => {
    const [link] = buildShadowrocketLinks([node()]);

    expect(link).toBeTypeOf('string');
    expect(extraOf(link!)).toEqual({ downloadSettings: XRAY_DOWNLOAD });
    expect(parseUri(link!)).toMatchObject({ network: 'xhttp' });
  });
});

describe('XHTTP split: mihomo passthrough', () => {
  it('keeps the download-settings block intact at the right levels', () => {
    const body = produceMihomo([node()], { leadingRules: false });
    const yaml = parseYaml(body) as { proxies: Array<Record<string, unknown>> };
    const proxy = yaml.proxies[0]!;
    const xhttp = proxy['xhttp-opts'] as Record<string, unknown>;
    const download = xhttp['download-settings'] as Record<string, unknown>;

    expect(body).toContain('download-settings:');
    expect(xhttp).toMatchObject({ path: '/secret-path', mode: 'auto' });
    expect(download).toEqual(DOWNLOAD);
    expect(download.server).toBe('1.2.3.4');
    expect(download.servername).toBe('reality.example.com');
    expect(download['reality-opts']).toEqual(DOWNLOAD['reality-opts']);
  });
});

describe('XHTTP split: clients without the transport', () => {
  it('skips a VLESS xhttp node in Shadowrocket conf with a diagnostic', () => {
    expect(shadowrocketConfProxyLine(node())).toEqual({
      skipped: 'missing or unrepresentable protocol options',
    });
    const result = buildShadowrocketConfProxies([node()]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'XHTTP split', reason: 'missing or unrepresentable protocol options' },
    ]);
  });

  it('skips a VLESS xhttp node in sing-box', () => {
    expect(buildSingboxOutbounds([node()])).toEqual([]);
    expect(JSON.parse(produceSingbox([node()]))).toEqual({ outbounds: [] });
  });

  it('skips a VLESS xhttp node in Loon', () => {
    const result = buildLoonProxies([node()]);
    expect(result.names).toEqual([]);
    expect(result.skipped).toEqual([
      { name: 'XHTTP split', reason: 'missing or unrepresentable protocol options' },
    ]);
  });
});
