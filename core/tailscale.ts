// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Built-in Tailscale outbound for mihomo/Clash exports (opt-in via
 * `?tailscale=1`; see `core/producers/mihomo.ts`).
 *
 * mihomo >= 1.19.25 has a native `tailscale` outbound. The option struct is
 * exactly: `name`, `hostname`, `auth-key`, `control-url`, `state-dir`,
 * `ephemeral`, `udp`, `accept-routes`, `exit-node`,
 * `exit-node-allow-lan-access`. This module only uses verified fields — no
 * invented options.
 *
 * Name-namespace trap (verified against mihomo 1.19.33): a proxy and a
 * proxy-group with the SAME name are rejected ("loop is detected in
 * ProxyGroup"). The verified-good shape is a proxy named `Tailscale` and a
 * group named `🔗 Tailscale` (select, `[Tailscale, DIRECT]`); the rules point at
 * the GROUP.
 */
import type { ClashProxyGroup, ProduceOptions, ProxyNode } from './types';

/** Proxy name (shares mihomo's name namespace with groups — see above). */
export const TAILSCALE_PROXY_NAME = 'Tailscale';
/** Group name; deliberately different from the proxy name. */
export const TAILSCALE_GROUP_NAME = '🔗 Tailscale';
/** On-disk state directory of the outbound (mihomo default is `./tailscale`). */
export const TAILSCALE_STATE_DIR = './tailscale';

/**
 * The two head rules pointing at the Tailscale group. They are inserted after
 * the built-in QUIC block and before any profile/custom rule.
 */
export const TAILSCALE_RULES: readonly string[] = [
  `IP-CIDR,100.64.0.0/10,${TAILSCALE_GROUP_NAME},no-resolve`,
  `DOMAIN-SUFFIX,ts.net,${TAILSCALE_GROUP_NAME}`,
];

/** Longest hostname we emit (DNS labels are 63, but a short label is safer). */
export const TAILSCALE_HOSTNAME_MAX_LENGTH = 40;
/** Fallback hostname when the user name has no usable characters. */
export const TAILSCALE_HOSTNAME_FALLBACK = 'subhub-node';
/** Prefix every generated hostname carries. */
export const TAILSCALE_HOSTNAME_PREFIX = 'subhub-';

/**
 * Deterministic Tailscale hostname from a user name.
 *
 * Lowercases, collapses every run of characters outside `[a-z0-9]` into a
 * single `-`, trims leading/trailing `-`, prefixes `subhub-` and caps the whole
 * hostname at `TAILSCALE_HOSTNAME_MAX_LENGTH` characters (re-trimming a
 * trailing `-`). A name with no usable characters falls back to
 * `subhub-node`.
 */
export function buildTailscaleHostname(userName: unknown): string {
  const slug = String(userName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return TAILSCALE_HOSTNAME_FALLBACK;
  const hostname = `${TAILSCALE_HOSTNAME_PREFIX}${slug}`
    .slice(0, TAILSCALE_HOSTNAME_MAX_LENGTH)
    .replace(/-+$/g, '');
  return hostname || TAILSCALE_HOSTNAME_FALLBACK;
}

/** A planned injection: the raw proxy, its group and the head rules. */
export interface TailscaleInjection {
  proxy: ProxyNode;
  group: ClashProxyGroup;
  /** The head rules, in order. */
  rules: string[];
}

/**
 * Decide whether (and what) to inject.
 *
 * Returns `null` when no option was passed, or when the export already carries
 * a node named `Tailscale` or a group named `🔗 Tailscale` (names share one
 * namespace, so injecting either would collide). `proxyNames`/`groupNames` are
 * the names the render will actually emit.
 */
export function buildTailscaleInjection(
  option: ProduceOptions['tailscale'],
  proxyNames: readonly string[],
  groupNames: readonly string[],
): TailscaleInjection | null {
  if (!option) return null;
  if (proxyNames.includes(TAILSCALE_PROXY_NAME)) return null;
  if (groupNames.includes(TAILSCALE_GROUP_NAME)) return null;
  // Field order matches mihomo's option struct.
  const proxy = {
    name: TAILSCALE_PROXY_NAME,
    type: 'tailscale',
    hostname: option.hostname,
    ...(option.authKey ? { 'auth-key': option.authKey } : {}),
    'state-dir': TAILSCALE_STATE_DIR,
    ephemeral: false,
    udp: true,
    'accept-routes': true,
  } as unknown as ProxyNode;
  return {
    proxy,
    group: {
      name: TAILSCALE_GROUP_NAME,
      type: 'select',
      proxies: [TAILSCALE_PROXY_NAME, 'DIRECT'],
    },
    rules: [...TAILSCALE_RULES],
  };
}
