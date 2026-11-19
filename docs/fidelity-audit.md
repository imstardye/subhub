# Brief F — fidelity audit

## 1. AnyTLS certificate fingerprints

Sources inspected:

- [mihomo AnyTLS](https://wiki.metacubex.one/en/config/proxies/anytls/)
  links to the common TLS fields.
- [mihomo TLS fields](https://wiki.metacubex.one/en/config/proxies/tls/#fingerprint):
  `fingerprint` is the SHA-256 hash of the **complete certificate**, not an
  HPKP/public-key hash. `certificate` is an mTLS client certificate/path;
  `client-fingerprint` selects uTLS, not certificate pinning.
- [Stash proxy types](https://stash.wiki/proxy-protocols/proxy-types):
  `server-cert-fingerprint` verifies the server certificate's SHA-256 hash,
  hex encoded.
- [Sub-Store 2.42.3 Stash producer](https://github.com/sub-store-org/Sub-Store/blob/2.42.3/backend/src/core/proxy-utils/producers/stash.js):
  AnyTLS is supported; maps internal `tls-fingerprint` to
  `server-cert-fingerprint` and removes the internal field.
- [Sub-Store Clash parser](https://github.com/sub-store-org/Sub-Store/blob/2.42.3/backend/src/core/proxy-utils/parsers/index.js):
  `Clash_All` maps `server-cert-fingerprint` and `fingerprint` into
  `tls-fingerprint`.

Version caveat: the actual [2.42.3 release note](https://github.com/sub-store-org/Sub-Store/releases/tag/2.42.3)
reads “调整 sing-box TLS certificate_sha256 相关逻辑”, not an AnyTLS/Stash
fix. The tagged producer above is the field-mapping evidence; the brief's
version attribution is not used to infer a wire format.

Before this change, subhub preserved native fields verbatim, and already
mapped internal `tls-fingerprint` to mihomo `fingerprint`. However, it neither
bridged Stash's spelling into the internal pin nor emitted Stash's spelling
from a mihomo pin. Both `mihomo` and `clash` exports use the same producer,
so for AnyTLS they now emit **both** `fingerprint` and
`server-cert-fingerprint` with the same value. Unknown fields are left to
the client, which reads its native spelling. This is not a new Stash target.

The parser retains native fields and adds the internal pin. Precedence is
existing internal pin > mihomo spelling > Stash spelling; the producer
reconciles aliases to prevent conflicting pins. No digest re-encoding or
public-key-pin conversion is performed. No new AnyTLS URI pin parameter is
invented.

`tests/anytls-fidelity.test.ts` covers YAML, JSON node/array, base64
subscriptions, both targets, compact/pretty output, reparse/render stability,
direct producer input, immutability, conflicts, and separation from uTLS/mTLS.

## 2. CORS posture

Audit commands:

```sh
rg -ni 'cors|access-control-allow|origin' server
rg -ni 'cors|access-control|appendheader|setheader|headers:' server
rg -n 'cors|routeRules|headers' nuxt.config.ts
```

No CORS middleware, `Access-Control-Allow-Origin`, arbitrary Origin reflection,
or permissive route rule was found. `server/utils/admin-api.ts`'s `sendJson`
sets only JSON content type and `cache-control: no-store`; middleware response
headers similarly do not grant cross-origin access. Origin references in
`auth-routes.ts`, OIDC and the user DTO build redirect/subscription URLs,
not CORS response headers. `nuxt.config.ts` has no CORS/route-header overrides.
Browsers retain the default same-origin read restriction for API responses.
No CORS code change is warranted. This finding is not a claim about CSRF or
headers that an external reverse proxy might add.

## 3. TrustTunnel

`rg -ni 'trusttunnel|client-random-auth-key' core server` found no matches.
There is no TrustTunnel type in `core/types.ts`, no parser registration, and
no producer branch. Per the brief, no type or field support was added.

## Gates

- `./node_modules/.bin/vitest run`: 60 files, 1,372 tests passed.
- `./node_modules/.bin/tsc --noEmit`: passed.
- `./node_modules/.bin/nuxt build`: passed.
