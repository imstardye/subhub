// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A tiny, real-HTTP OpenID Connect provider for the XAuth tests.
 *
 * openid-client does genuine discovery / JWKS fetches / token exchange, so the
 * provider has to answer over HTTP — these are `node:http` servers, not mocks.
 * Two endpoints:
 *
 * - `startStubIdp()`: the protocol endpoints of one issuer
 *   (`/.well-known/openid-configuration`, `/authorize` on the RP's behalf when a
 *   test follows the redirect, `/token`, `/keys`, `/userinfo`, `/end_session`);
 * - `startStubBrowserServer()`: a stand-in for the subhub site ("browser
 *   origin") that records the ID token handed back by the IdP's `end_session`.
 *
 * The signing key is generated once per process with `jose`
 * (`generateKeyPair('RS256')` + `exportJWK`) — ID tokens are really RS256
 * signed and really verified against the served JWKS.
 *
 * Not a test file itself (no `.test.ts`), so vitest does not collect it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface StubIdentity {
  sub: string;
  email?: string | null;
  email_verified?: boolean;
  /** Send the email only in `/userinfo` (not in the ID token). */
  emailInUserinfoOnly?: boolean;
}

export interface StubAuthorizeParams {
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  nonce?: string;
  scope: string;
  response_type: string;
}

export interface StubIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Every `/authorize` request seen (redirect + PKCE assertions). */
  authorizeRequests: StubAuthorizeParams[];
  /** Every `/userinfo` call (Authorization header included). */
  userinfoRequests: Array<{ authorization: string | undefined }>;
  /** Every `end_session` request query (for logout assertions). */
  endSessionRequests: URLSearchParams[];
  /** The last ID token minted by `/token` (what the IdP could hint back). */
  lastIdToken: string | null;
  /** Overrides applied to the next `/authorize` response. */
  nextAuthorize: { identity?: StubIdentity; error?: string } | null;
  /** Overrides applied to the next `/token` response. */
  nextToken: { identity?: StubIdentity; status?: number } | null;
  /** Recorded token requests (grant_type, code, PKCE verifier). */
  tokenRequests: Array<Record<string, string>>;
  close(): Promise<void>;
}

const rsa = await generateKeyPair('RS256');
const publicJwk = await exportJWK(rsa.publicKey);
const kid = await calculateJwkThumbprint(publicJwk as JWK, 'sha256');
const jwk = { ...publicJwk, kid, alg: 'RS256', use: 'sig' } as JWK;

let idCounter = 0;

async function mintIdToken(
  issuer: string,
  clientId: string,
  identity: StubIdentity,
  nonce: string | undefined,
): Promise<string> {
  const claims: Record<string, unknown> = { sub: identity.sub };
  // Echo the authorization request's nonce (`expectedNonce` on the RP side).
  if (nonce) claims.nonce = nonce;
  if (!identity.emailInUserinfoOnly) {
    if (identity.email !== undefined && identity.email !== null) claims.email = identity.email;
    if (identity.email_verified !== undefined) claims.email_verified = identity.email_verified;
  }
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject(identity.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(`idt-${(idCounter += 1)}`)
    // The ID token echoes the authorization request's nonce (openid-client
    // verifies it as `expectedNonce`).
    .sign(rsa.privateKey);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** A code → pending authorization (preset identity + nonce + redirect). */
interface PendingCode {
  identity: StubIdentity;
  nonce?: string;
  redirectUri: string;
}

/** Access token → the identity the token endpoint issued it for (`/userinfo`). */
const issuedTokens = new Map<string, StubIdentity>();

export async function startStubIdp(): Promise<StubIdp> {
  const clientId = 'subhub-test-client';
  const clientSecret = 'subhub-test-secret';
  const pending = new Map<string, PendingCode>();
  const idp: StubIdp = {
    issuer: '',
    clientId,
    clientSecret,
    authorizeRequests: [],
    userinfoRequests: [],
    endSessionRequests: [],
    lastIdToken: null,
    nextAuthorize: null,
    nextToken: null,
    tokenRequests: [],
    close: async () => {},
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idp.issuer || 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/keys`,
        userinfo_endpoint: `${idp.issuer}/userinfo`,
        end_session_endpoint: `${idp.issuer}/end_session`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        claims_supported: ['sub', 'email', 'email_verified'],
      });
    }
    if (req.method === 'GET' && url.pathname === '/keys') {
      return json(res, 200, { keys: [jwk] });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const params: StubAuthorizeParams = {
        redirect_uri: url.searchParams.get('redirect_uri') ?? '',
        state: url.searchParams.get('state') ?? '',
        code_challenge: url.searchParams.get('code_challenge') ?? '',
        code_challenge_method: url.searchParams.get('code_challenge_method') ?? '',
        nonce: url.searchParams.get('nonce') ?? undefined,
        scope: url.searchParams.get('scope') ?? '',
        response_type: url.searchParams.get('response_type') ?? '',
      };
      idp.authorizeRequests.push(params);
      const override = idp.nextAuthorize;
      idp.nextAuthorize = null;
      const target = new URL(params.redirect_uri);
      if (override?.error) {
        target.searchParams.set('error', override.error);
        target.searchParams.set('state', params.state);
        res.statusCode = 302;
        res.setHeader('location', target.toString());
        return res.end('');
      }
      const code = `code-${(idCounter += 1)}`;
      pending.set(code, {
        identity: override?.identity ?? { sub: 'nobody' },
        nonce: params.nonce,
        redirectUri: params.redirect_uri,
      });
      target.searchParams.set('code', code);
      target.searchParams.set('state', params.state);
      res.statusCode = 302;
      res.setHeader('location', target.toString());
      return res.end('');
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
      idp.tokenRequests.push(body);
      const override = idp.nextToken;
      idp.nextToken = null;
      if (override?.status) return json(res, override.status, { error: 'invalid_grant' });
      if (body.grant_type !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });
      if (body.client_id !== clientId || body.client_secret !== clientSecret) {
        return json(res, 401, { error: 'invalid_client' });
      }
      const entry = pending.get(body.code ?? '');
      if (!entry) return json(res, 400, { error: 'invalid_grant' });
      pending.delete(body.code!);
      const identity = override?.identity ?? entry.identity;
      const idToken = await mintIdToken(idp.issuer, clientId, identity, entry.nonce);
      idp.lastIdToken = idToken;
      const accessToken = `at-${(idCounter += 1)}`;
      issuedTokens.set(accessToken, identity);
      return json(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
        scope: body.scope ?? 'openid',
      });
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const authorization = req.headers.authorization;
      idp.userinfoRequests.push({ authorization });
      // /userinfo answers for the access token that was actually issued, never
      // a caller-chosen subject (the RP passes its ID-token sub only to CHECK
      // the answer against it).
      const accessToken = (authorization ?? '').replace(/^Bearer /, '');
      const identity = issuedTokens.get(accessToken);
      if (!identity) return json(res, 401, { error: 'invalid_token' });
      const claims: Record<string, unknown> = { sub: identity.sub };
      if (identity.email) claims.email = identity.email;
      if (identity.email_verified !== undefined) claims.email_verified = identity.email_verified;
      return json(res, 200, claims);
    }
    if (req.method === 'GET' && url.pathname === '/end_session') {
      idp.endSessionRequests.push(url.searchParams);
      const target = url.searchParams.get('post_logout_redirect_uri');
      res.statusCode = 302;
      if (target) res.setHeader('location', target);
      return res.end('');
    }
    return json(res, 404, { error: 'not_found', path: url.pathname });
  });

  const port = await listen(server);
  idp.issuer = `http://127.0.0.1:${port}`;
  idp.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });
  return idp;
}

/** Record what the IdP should authorize as for the next `/authorize` hit. */
export function expectIdentity(idp: StubIdp, identity: StubIdentity): void {
  idp.nextAuthorize = { identity };
}

/** Value of the `subhub_oidc` flow cookie from a Set-Cookie list. */
export function flowCookieValue(setCookies: readonly string[], name = 'subhub_oidc'): string | null {
  for (const cookie of setCookies) {
    const pair = cookie.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1));
  }
  return null;
}

/** A stand-in "subhub origin" the IdP can redirect back to. */
export interface StubBrowserServer {
  origin: string;
  /** Total requests seen (idle assertions). */
  hits: number;
  close(): Promise<void>;
}

/** A server that accepts every request and records that it was reached. */
export async function startStubBrowserServer(): Promise<StubBrowserServer> {
  const stub: StubBrowserServer = { origin: '', hits: 0, close: async () => {} };
  const server: Server = createServer((req, res) => {
    stub.hits += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<html><body>${req.url ?? '/'}</body></html>`);
  });
  const port = await listen(server);
  stub.origin = `http://127.0.0.1:${port}`;
  stub.close = () => new Promise((resolve) => server.close(() => resolve()));
  return stub;
}

/** Exported so tests can assert the served JWKS really matches the ID tokens. */
export const stubJwks = { keys: [jwk] };
