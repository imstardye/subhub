// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public parser entry points.
 *
 * Ported and adapted from Sub-Store
 * (https://github.com/sub-store-org/Sub-Store), licensed under AGPL-3.0.
 * See the repository LICENSE file.
 */

export {
  parseAnyTLS,
  parseHysteria2,
  parseMieru,
  parseShadowsocks,
  parseSsr,
  parseTrojan,
  parseTuic,
  parseUri,
  parseVless,
  parseVmess,
  isShareLink,
} from './uri';
export { parseClashNode, parseClashYaml, parseSubscription, parseSubscriptionDetailed } from './clash';
export type { ProxyNode, ParseResult } from '../types';
