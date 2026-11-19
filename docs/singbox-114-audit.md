# sing-box 1.14 export additions and deprecation audit

Verified 2026-11-19 against primary documentation:

- https://sing-box.sagernet.org/configuration/endpoint/openvpn-client/
- https://sing-box.sagernet.org/configuration/endpoint/openconnect/
- https://sing-box.sagernet.org/configuration/outbound/hysteria2/
- https://sing-box.sagernet.org/configuration/outbound/hysteria/
- https://sing-box.sagernet.org/configuration/shared/http-client/
- https://sing-box.sagernet.org/deprecated/
- https://wiki.metacubex.one/config/proxies/openvpn/
- https://wiki.metacubex.one/config/proxies/hysteria2/

## Shapes and boundaries

Mihomo documents `type: openvpn`, with server/port/proto, username/password or
cert/key, ca, tls-auth/key-direction, tls-crypt/tls-crypt-v2, data-ciphers,
data-ciphers-fallback, cipher, auth, comp-lzo, ping/ping-restart,
handshake-timeout and mtu. sing-box uses an **endpoint** with
`type: openvpn-client`, `server_port`, `network`, and a specialized `tls`
block (no `enabled`): CA -> `certificate`, cert/key ->
`client_certificate`/`client_key`, wrapping -> `control_wrap`.
Key direction 0 -> server, 1 -> client. Username/password remain top-level.
Mihomo's cipher/auth defaults are preserved explicitly, as is its disabled
receive timeout. Unsupported peer-info, tran-window, remote DNS, IP-stack and
named dialer settings fail closed with endpoint diagnostics, rather than
silently changing their behavior.

There is **no documented mihomo OpenConnect grammar** (the putative
`/config/proxies/openconnect/` page is 404). The parser retains `openconnect`
in a subscription envelope, with documented **native sing-box** field names;
it does not invent hyphenated aliases. `server` is an HTTPS URL (including
port/path); native TLS options are not the generic sing-box TLS shape.
A host/port envelope is also supported; absent port defaults to 443.
Mihomo skips this node with a diagnostic; its OpenVPN output is retained.
Surge/Loon/Shadowrocket/conf/URI skip both new types with diagnostics.

HY2 mappings:

| Mihomo | sing-box |
| --- | --- |
| `bbr-profile` | `bbr_profile` (conservative/standard/aggressive) |
| `hop-interval: 15-30` | `hop_interval: 15s`, `hop_interval_max: 30s` |
| `obfs: gecko`, `obfs-password` | `obfs: {type: gecko, password: ...}` |
| `obfs-min-packet-size`, `obfs-max-packet-size` | `obfs.min_packet_size`, `obfs.max_packet_size` |
| `realm-opts.enable: true` | enables `realm`, removing server/server_port/server_ports |
| realm `server-url`, `realm-id`, `token`, `stun-servers` | `server_url`, `realm_id`, `token`, `stun_servers` |

No invented `hop-interval-max`/`realm` Clash aliases are interpreted. Realm
requires URL, ID and STUN servers. Mihomo-specific realm TLS overrides are
retained by the parser but currently cause sing-box to skip the node with a
diagnostic (they must not be mistaken for HY2 server TLS). Native sing-box
realm ip_version/port_mapping fields have no documented mihomo equivalent.

## Deprecation audit

The export is deliberately a nodes-only JSON document: `outbounds` and optional
`endpoints`. It has **no DNS, route, remote-rule-set, inbound or TUN template**.
Do not create a DNS template merely to migrate one that does not exist.

| Field / behavior | Primary-source status | Action taken |
| --- | --- | --- |
| remote rule-set `download_detour` | Deprecated 1.14, removed 1.16; use http_client | Not emitted; no migration needed |
| implicit default HTTP client for remote rule-sets | Removed 1.16; explicit http_clients + route.default_http_client | No remote rule-sets emitted |
| inline `tls.acme` | Deprecated 1.14, removed 1.16; certificate provider replacement | Not emitted; TLS is allowlisted |
| DNS action `strategy` | Removed 1.16 | No DNS section emitted |
| DNS `rule_set_ip_cidr_accept_empty` | Removed 1.16 | No DNS rules emitted |
| DNS `independent_cache` | Removed 1.16 | Not emitted |
| cache file `store_rdrc` | Removed 1.16 | Not emitted |
| DNS `ip_cidr` / `ip_is_private` without `match_response` | Legacy behavior removed 1.16 | No DNS rules emitted |
| legacy DNS server format | Already removed 1.14 | No DNS servers emitted |
| Hysteria v1 `recv_window_conn`, `recv_window`, `disable_mtu_discovery` | Deprecated 1.14; docs list replacements stream_receive_window, connection_receive_window, disable_path_mtu_discovery; no removal version stated on outbound page | None emitted before or after; no tuning migration needed |
| legacy WireGuard outbound | Already removed 1.13 | Existing endpoint implementation retained |
| TUN `stack` | Deprecated 1.15, removal **1.17**, not 1.16 | No TUN emitted |

No existing emitted template fields required migration. Regression tests assert
the document remains nodes-only and excludes deprecated names.

## Validation

The locally available `/tmp/sbcheck/sing-box-1.14.4-linux-amd64/sing-box`
includes both `with_openvpn` and `with_openconnect`. A generated mixed sample
(`/tmp/sbcheck/newtech-d.json`) with OpenVPN (temporary valid CA), OpenConnect,
HY2 Gecko + randomized hopping + BBR, and HY2 Realm passes `sing-box check`.
This checks configuration loading, not successful connections to live VPNs.
