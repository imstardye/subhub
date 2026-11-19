// SPDX-License-Identifier: AGPL-3.0-only
import type { ProxyNode } from './types';

export const REALITY_MLKEM = 'support-x25519mlkem768';

/** Match the boolean spellings accepted by mihomo's URI converter (Go ParseBool). */
export function parseRealityMlkem(value: unknown): boolean | undefined {
  switch (value) {
    case true: case 1: case '1': case 't': case 'T': case 'true': case 'TRUE': case 'True':
      return true;
    case false: case 0: case '0': case 'f': case 'F': case 'false': case 'FALSE': case 'False':
      return false;
    default:
      return undefined;
  }
}

export function realityMlkem(node: ProxyNode): unknown {
  const reality = node['reality-opts'] as Record<string, unknown> | undefined;
  return reality?.[REALITY_MLKEM] ?? node[REALITY_MLKEM];
}

/** Unlike mihomo, these clients have no verified toggle. Do not guess its default. */
export function unverifiedVlessOptions(node: ProxyNode): string | undefined {
  if (node.type !== 'vless') return undefined;
  if (node.finalmask != null) return 'VLESS FinalMask is not supported by this producer';
  if (realityMlkem(node) != null) return `VLESS REALITY ${REALITY_MLKEM} is not supported by this producer`;
  return undefined;
}

/** An absent setting, an empty one, and `none` require no VLESS encryption. */
export function hasVlessEncryption(node: ProxyNode): boolean {
  return node.encryption != null && node.encryption !== '' && node.encryption !== 'none';
}
