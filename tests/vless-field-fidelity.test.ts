// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  buildLoonProxies,
  buildMihomoProxyResult,
  buildShadowrocketConfProxies,
  buildShadowrocketSubscription,
  buildSingboxOutboundResult,
  buildSurgeProxies,
  parseClashYaml,
  parseSubscription,
  parseUri,
  toShareLink,
  toSingboxOutbound,
} from '../core';
import { renderTargetBody, targetProxyNames } from '../server/utils/export-nodes';

const flag = 'support-x25519mlkem768';
const uri = 'vless://7a530d98-9ecd-4a72-9f12-60c4c71650f9@proxy.example:443?security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd';
const encryption = 'mlkem768x25519plus.native.0rtt.100-111-1111.75-0-111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const finalmask = '{ "tcp": [{"type":"future-mask","settings":{"_opaque":" +%&#中文"}}] }';

function node(query = '', name = 'Reality') {
  return parseUri(`${uri}${query}#${name}`)!;
}

describe('VLESS field fidelity', () => {
  it.each([['true', true], ['1', true], ['false', false], ['0', false]])(
    'round-trips encryption, FinalMask and %s as a mihomo-compatible boolean', (input, expected) => {
      const original = node(`&encryption=${encryption}&fm=${encodeURIComponent(finalmask)}&${flag}=${input}`);
      expect(original).toMatchObject({ encryption, finalmask, 'reality-opts': { [flag]: expected } });
      const output = renderTargetBody('uri', [original]);
      const link = Buffer.from(output, 'base64').toString('utf8');
      expect(link).toContain(`fm=${encodeURIComponent(finalmask)}`);
      expect(new URL(link).searchParams.get(flag)).toBe(String(expected));
      expect(parseSubscription(output)).toEqual([original]);
    },
  );

  it('retains empty/unknown URI values without downgrading them to defaults', () => {
    const original = node(`&encryption=&fm=not-json&${flag}=future`);
    const params = new URL(toShareLink(original)!).searchParams;
    expect(params.get('encryption')).toBe('');
    expect(params.get('fm')).toBe('not-json');
    expect(params.get(flag)).toBe('future');
    expect(buildMihomoProxyResult([node(`&${flag}=future`)]).skipped[0]?.reason).toContain(flag);
    const orphan = parseUri(uri.split('?')[0] + `?${flag}=true#Orphan`)!;
    expect(new URL(toShareLink(orphan)!).searchParams.get(flag)).toBe('true');
    expect(buildMihomoProxyResult([orphan]).skipped[0]?.reason).toContain('public key');
  });

  it.each(['mihomo', 'clash'] as const)('retains native YAML fields in %s and converts them back to a URI', (target) => {
    const yaml = `proxies:
  - name: YAML
    type: vless
    server: proxy.example
    port: 443
    uuid: 7a530d98-9ecd-4a72-9f12-60c4c71650f9
    tls: true
    encryption: "${encryption}"
    reality-opts:
      public-key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
      short-id: abcd
      ${flag}: false`;
    const [parsed] = parseClashYaml(yaml);
    const enabled = node(`&encryption=${encryption}&${flag}=1`, 'URI');
    const proxies = parseYaml(renderTargetBody(target, [parsed, enabled])).proxies;
    expect(proxies).toMatchObject([
      { name: 'YAML', encryption, 'reality-opts': { 'short-id': 'abcd', [flag]: false } },
      { name: 'URI', encryption, 'reality-opts': { 'short-id': 'abcd', [flag]: true } },
    ]);
    expect(proxies[1]).not.toHaveProperty(flag);
    expect(new URL(toShareLink(parsed)!).searchParams.get(flag)).toBe('false');
    expect(new URL(toShareLink(parsed)!).searchParams.get('encryption')).toBe(encryption);
  });

  it('omits FinalMask nodes from mihomo/clash bodies and candidate group members', () => {
    const masked = node(`&fm=${encodeURIComponent(finalmask)}`, 'Masked');
    const ordinary = node();
    const result = buildMihomoProxyResult([masked, ordinary]);
    expect(result.proxies.map((proxy) => proxy.name)).toEqual(['Reality']);
    expect(result.skipped).toEqual([{ name: 'Masked', reason: expect.stringContaining('FinalMask') }]);
    for (const target of ['mihomo', 'clash'] as const) {
      expect(targetProxyNames(target, [masked, ordinary])).toEqual(['Reality']);
      expect(parseYaml(renderTargetBody(target, [masked], { pretty: false })).proxies).toEqual([]);
    }
  });

  it('diagnoses each unsupported sing-box field without dropping unaffected nodes', () => {
    const masked = node(`&fm=${encodeURIComponent(finalmask)}`, 'Masked');
    const encrypted = node(`&encryption=${encryption}`, 'Encrypted');
    const mlkem = node(`&${flag}=true`, 'ML-KEM');
    const disabled = node(`&encryption=none&${flag}=false`, 'Explicitly disabled');
    const nodes = [masked, encrypted, mlkem, disabled, node()];
    const result = buildSingboxOutboundResult(nodes);
    expect(result.skipped).toEqual([
      { name: 'Masked', reason: expect.stringContaining('FinalMask') },
      { name: 'Encrypted', reason: expect.stringContaining('encryption') },
      { name: 'ML-KEM', reason: expect.stringContaining(flag) },
    ]);
    expect(result.outbounds.map(({ tag }) => tag)).toEqual(['Explicitly disabled', 'Reality']);
    expect(toSingboxOutbound(mlkem)).toBeNull();
    const body = renderTargetBody('singbox', nodes);
    expect(JSON.parse(body).outbounds).toEqual(result.outbounds);
    expect(body).not.toMatch(/encryption|curve_preferences|finalmask|support-x25519mlkem768/);
  });

  it('keeps other client producers from silently dropping these fields', () => {
    const masked = node(`&fm=${encodeURIComponent(finalmask)}`, 'Masked');
    const mlkem = node(`&${flag}=true`, 'ML-KEM');
    const encrypted = node(`&encryption=${encryption}`, 'Encrypted');
    for (const build of [buildLoonProxies, buildShadowrocketConfProxies, buildShadowrocketSubscription]) {
      expect(build([masked, mlkem]).skipped).toEqual([
        { name: 'Masked', reason: expect.stringContaining('FinalMask') },
        { name: 'ML-KEM', reason: expect.stringContaining(flag) },
      ]);
    }
    for (const build of [buildLoonProxies, buildShadowrocketConfProxies]) {
      expect(build([encrypted]).skipped[0]?.reason).toContain('encryption');
    }
    expect(buildShadowrocketSubscription([encrypted]).lines[0]).toContain(`encryption=${encryption}`);
    const surge = buildSurgeProxies([encrypted, masked, mlkem]);
    expect(surge.lines[0]).toContain(`encryption=${encryption}`);
    expect(surge.skipped).toEqual([
      { name: 'Masked', reason: expect.stringContaining('FinalMask') },
      { name: 'ML-KEM', reason: expect.stringContaining(flag) },
    ]);
  });
});
