// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public producer entry points.
 *
 * Ported and adapted from Sub-Store
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

export {
  buildLeadingRules,
  buildMihomoProxies,
  isQuicBlockRule,
  produceMihomo,
  produceMihomoProxiesOnly,
  QUIC_BLOCK_RULE,
  stringifyMihomoConfig,
} from './mihomo';
export { stringifyProxiesSection, stringifyYamlBlocks, toYamlProxies } from './common';
export { buildLegacyProxies, produceLegacy } from './legacy';
export type { ProxyNode, ProduceOptions } from '../types';
export {
  buildShareLinks,
  produceUri,
  toShareLink,
  URI_SUPPORTED_TYPES,
} from './uri';
export {
  buildSingboxOutbounds,
  produceSingbox,
  singboxServerPorts,
  SINGBOX_SUPPORTED_TYPES,
  toSingboxOutbound,
} from './singbox';
export type { SingboxConfig, SingboxOutbound } from './singbox';
