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
export type { ProxyNode, ProduceOptions } from '../types';
