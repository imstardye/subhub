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
export {
  cleanupValue,
  prepareNode,
  stringifyProxiesSection,
  stringifyYamlBlocks,
  toYamlProxies,
} from './common';
export type { ProxyNode, ProduceOptions } from '../types';
export {
  buildMieruLink,
  buildShareLinks,
  produceUri,
  toShareLink,
  URI_SUPPORTED_TYPES,
} from './uri';
export {
  buildSingboxEndpoints,
  buildSingboxOutbounds,
  produceSingbox,
  singboxServerPorts,
  SINGBOX_SUPPORTED_TYPES,
  toSingboxOutbound,
} from './singbox';
export type { SingboxConfig, SingboxEndpoint, SingboxOutbound } from './singbox';
export {
  buildLoonGroups,
  buildLoonProxies,
  loonProxyLine,
  produceLoon,
} from './loon';
export {
  buildSurgeGroups,
  buildSurgeProxies,
  produceSurge,
  surgePortHopping,
  surgeProxyLine,
} from './surge';
export {
  buildShadowrocketLinks,
  buildShadowrocketSubscription,
  produceShadowrocket,
  shadowrocketLink,
} from './shadowrocket';
export {
  buildShadowrocketConfGroups,
  buildShadowrocketConfProxies,
  produceShadowrocketConf,
  sanitizeShadowrocketConfName,
  shadowrocketConfGroupLine,
  shadowrocketConfProxyLine,
  SHADOWROCKET_CONF_BUILTINS,
  SHADOWROCKET_CONF_GROUP_INTERVAL,
  SHADOWROCKET_CONF_GROUP_URL,
  translateShadowrocketConfRule,
  translateShadowrocketConfRules,
} from './shadowrocket-conf';
export { buildLineGroups, lineGroup, joinSections } from './groups';
export type { LineGroup } from './groups';
