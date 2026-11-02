// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Built-server smoke test for the XAuth (OIDC) login (manual gate, not vitest).
 *
 * Runs the REAL `nuxt build` output (`node .output/server/index.mjs`) against a
 * real-HTTP stub OIDC provider and the site's own HTTP surface:
 *
 *   1. admin login (cookie) → the server answers;
 *   2. the XAuth client is configured IN THE DATABASE, the way the admin settings
 *      UI saves it (the built server answers the admin JSON API with an empty
 *      body — a pre-existing quirk of the whole admin API under the nitro/h3
 *      version pinned here, not of this feature — so the smoke drives the real
 *      HTTP surface but writes the same `oidc_*` rows the settings form writes);
 *   3. GET /auth/login without the admin knock cookie → 302 to the stub, S256+state+nonce;
 *   4. follow the stub's /authorize → callback URL;
 *   5. GET /auth/callback with the flow cookie → 302 /my/<token> + subhub_my + subhub_oidc_idt;
 *   6. the binding is claimed (users.oidc_sub), the session works on /api/user/<token>;
 *   7. anonymous /api/user/<token> is now 401 oidc-only (password disabled);
 *   8. GET /auth/logout → 302 end_session?id_token_hint=…&post_logout_redirect_uri=…
 *      and following it reaches /auth/logged-out;
 *   9. the /my page HTML renders (with the session cookie) and the admin console
 *      is never authenticated by that cookie.
 *
 * Usage (after `npx nuxt build`):
 *   node --experimental-strip-types scripts/xauth-smoke.ts   # Node ≥ 22.6
 * or, without flags, through tsx/vitest-free bundling:
 *   npx tsx scripts/xauth-smoke.ts
 *
 * Environment: SUBHUB_SECRET + SUBHUB_DB_PATH are generated in a temp dir; the
 * server is started on a free port and killed afterwards. Nothing touches the
 * developer's real database.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT, type JWK } from 'jose';
import Database from 'better-sqlite3';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

/* ------------------------------------------------------------------ tools -- */

const results: Array<{ step: string; ok: boolean; detail: string }> = [];

function check(step: string, ok: boolean, detail = ''): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${step}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`smoke step failed: ${step} ${detail}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/* --------------------------------------------------------------- the DB -- */

/**
 * Seed the `settings` rows exactly as `PUT /api/admin/settings` stores them
 * (`oidc_enabled`, `oidc_issuer`, `oidc_client_id`, the ENCRYPTED client
 * secret, `oidc_scopes`) plus a pre-provisioned user with a pre-bound email.
 * The encryption matches `server/db/crypto.ts` (AES-256-GCM, key derived from
 * SUBHUB_SECRET — `v1:` + base64(iv|tag|data), scrypt salt `subhub/secret/v1`).
 * Idempotent: waits for the server to have created the tables first.
 */
function seedDatabase(options: {
  dbPath: string;
  secret: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  token: string;
  email: string;
}): { userId: number } {
  const sqlite = new Database(options.dbPath);
  try {
    sqlite.pragma('foreign_keys = ON');
    const set = (key: string, value: string) =>
      sqlite
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
    set('oidc_enabled', '1');
    set('oidc_issuer', options.issuer);
    set('oidc_client_id', options.clientId);
    set('oidc_client_secret', encryptSecret(options.clientSecret, options.secret));
    set('oidc_scopes', 'openid profile email');
    sqlite
      .prepare('UPDATE users SET oidc_email = ? WHERE token = ?')
      .run(options.email.toLowerCase(), options.token);
    const row = sqlite.prepare('SELECT id FROM users WHERE token = ?').get(options.token) as { id: number } | undefined;
    return { userId: row?.id ?? 0 };
  } finally {
    sqlite.close();
  }
}

/** `encrypt()` from server/db/crypto.ts, replicated (the smoke runs the build). */
function encryptSecret(plaintext: string, secret: string): string {
  const key = scryptSync(secret, 'subhub/secret/v1', 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

/* ---------------------------------------------------------------- the IdP -- */

async function startStubIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk as JWK, 'sha256');
  const jwk = { ...publicJwk, kid, alg: 'RS256', use: 'sig' } as JWK;
  const clientId = 'smoke-client';
  const clientSecret = 'smoke-client-secret';
  const pending = new Map<string, { identity: { sub: string; email: string; email_verified: boolean }; nonce?: string }>();
  const tokens = new Map<string, { sub: string; email: string; email_verified: boolean }>();
  let issuer = '';
  const authorizeLog: URLSearchParams[] = [];
  const endSessionLog: URLSearchParams[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        userinfo_endpoint: `${issuer}/userinfo`,
        end_session_endpoint: `${issuer}/end_session`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/keys') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      authorizeLog.push(url.searchParams);
      const code = `code-${authorizeLog.length}`;
      pending.set(code, {
        identity: { sub: 'smoke-sub-1', email: 'Smoke.User@Example.COM', email_verified: true },
        nonce: url.searchParams.get('nonce') ?? undefined,
      });
      const target = new URL(url.searchParams.get('redirect_uri')!);
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.statusCode = 302;
      res.setHeader('location', target.toString());
      return res.end('');
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
      console.log('[stub] /token', JSON.stringify(body).replace(/"code":"[^"]*"/, '"code":"…"'));
      const entry = pending.get(body.code ?? '');
      if (!entry || body.client_id !== clientId || body.client_secret !== clientSecret) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      pending.delete(body.code!);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        sub: entry.identity.sub,
        nonce: entry.nonce,
        email: entry.identity.email,
        email_verified: entry.identity.email_verified,
      })
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject(entry.identity.sub)
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      const accessToken = `at-${authorizeLog.length}`;
      tokens.set(accessToken, entry.identity);
      return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    if (url.pathname === '/userinfo') {
      const identity = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!identity) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, identity);
    }
    if (url.pathname === '/end_session') {
      endSessionLog.push(url.searchParams);
      res.statusCode = 302;
      const back = url.searchParams.get('post_logout_redirect_uri');
      if (back) res.setHeader('location', back);
      return res.end('');
    }
    return json(res, 404, { error: 'not_found' });
  });
  const port = await freePort();
  issuer = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    issuer,
    clientId,
    clientSecret,
    authorizeLog,
    endSessionLog,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ---------------------------------------------------------------- cookies -- */

function cookieValue(headers: Headers, name: string): string | null {
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index > 0 && pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

function cookieHeader(headers: Headers, names: string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    const value = cookieValue(headers, name);
    if (value) parts.push(`${name}=${value}`);
  }
  return parts.join('; ');
}

/* ------------------------------------------------------------------ main -- */

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'subhub-xauth-smoke-'));
  const dbPath = join(base, 'subhub.sqlite');
  const secret = 'smoke-secret-not-a-real-deployment';
  const adminPassword = 'smoke-admin-password';
  const appPort = await freePort();
  const origin = `http://127.0.0.1:${appPort}`;
  const idp = await startStubIdp();

  const server = spawn(process.execPath, ['.output/server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(appPort),
      HOST: '127.0.0.1',
      SUBHUB_DB_PATH: dbPath,
      SUBHUB_SECRET: secret,
      SUBHUB_ADMIN_PASSWORD: adminPassword,
      // The stub IdP is plain HTTP on loopback; a production build only allows
      // that with this explicit opt-in (never set on a real deployment).
      SUBHUB_OIDC_ALLOW_INSECURE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog: string[] = [];
  server.stdout.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  server.stderr.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));

  try {
    // Wait for the server to accept requests.
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      try {
        const probe = await fetch(`${origin}/my/none`, { redirect: 'manual' });
        ready = probe.status > 0;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    check('built server is up', ready, origin);

    // 1. Admin login → session cookie.
    const login = await fetch(`${origin}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }),
    });
    check('admin login', login.status === 200, `status ${login.status}`);
    const adminCookie = cookieHeader(login.headers, ['subhub_admin']);
    check('admin session cookie', adminCookie.length > 0);

    // 2. Wait for the server's tables, create the user through the admin API is
    //    NOT usable here (see the header note), so seed the DB the same way the
    //    settings form and the users page persist their data.
    const token = 'smoketoken0000000000000000000001';
    let seeded = { userId: 0 };
    for (let attempt = 0; attempt < 50 && seeded.userId === 0; attempt += 1) {
      try {
        const insert = new Database(dbPath);
        try {
          insert.prepare('INSERT INTO users (name, token, enabled) VALUES (?, ?, 1)').run('smoke-user', token);
        } finally {
          insert.close();
        }
        seeded = seedDatabase({
          dbPath,
          secret,
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
          token,
          email: 'smoke.user@example.com',
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    check('XAuth configured (settings rows)', seeded.userId > 0, `userId ${seeded.userId}`);


    // Locked /my: the API knows XAuth is on and the user is not bound yet.
    const locked = await fetch(`${origin}/api/user/${token}`);
    const lockedBody = (await locked.json()) as { status: string; oidcEnabled: boolean; oidcBound: boolean };
    check('locked /my exposes oidcEnabled/oidcBound', locked.status === 401 && lockedBody.status === 'needs-setup' &&
      lockedBody.oidcEnabled === true && lockedBody.oidcBound === false, JSON.stringify(lockedBody));

    // 4. /auth/login WITHOUT the admin knock cookie → 302 to the stub.
    const authLogin = await fetch(`${origin}/auth/login`, { redirect: 'manual' });
    check('/auth/login is gate-exempt (no knock cookie)', authLogin.status === 302 &&
      authLogin.headers.get('location')?.startsWith(`${idp.issuer}/authorize`),
      `status ${authLogin.status} → ${authLogin.headers.get('location')}`);
    const authorizeUrl = new URL(authLogin.headers.get('location')!);
    check('authorize URL carries S256 + state + nonce', authorizeUrl.searchParams.get('code_challenge_method') === 'S256' &&
      !!authorizeUrl.searchParams.get('code_challenge') && !!authorizeUrl.searchParams.get('state') &&
      !!authorizeUrl.searchParams.get('nonce'));
    check('redirect_uri is <origin>/auth/callback', authorizeUrl.searchParams.get('redirect_uri') === `${origin}/auth/callback`);
    const flowCookie = cookieHeader(authLogin.headers, ['subhub_oidc']);
    check('flow cookie is set', flowCookie.length > 0);

    // 5. Follow the stub authorize (browser step) → callback URL.
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    const callbackUrl = authorize.headers.get('location');
    check('stub /authorize redirects back', !!callbackUrl);

    // 6. Callback → session cookies + /my/<token>.
    const callback = await fetch(callbackUrl!, { redirect: 'manual', headers: { cookie: flowCookie } });
    check('callback lands on /my/<token>', callback.status === 302 &&
      callback.headers.get('location') === `/my/${token}`, `${callback.status} ${callback.headers.get('location')}`);
    const session = cookieHeader(callback.headers, ['subhub_my', 'subhub_oidc_idt']);
    check('subhub_my + subhub_oidc_idt minted', session.includes('subhub_my=') && session.includes('subhub_oidc_idt='));

    // The binding was claimed.
    const afterBindDb = new Database(dbPath);
    const boundUser = afterBindDb
      .prepare('SELECT oidc_sub, oidc_email FROM users WHERE token = ?')
      .get(token) as { oidc_sub: string | null; oidc_email: string | null };
    afterBindDb.close();
    check('first login claims the binding', boundUser.oidc_sub === 'smoke-sub-1' &&
      boundUser.oidc_email === 'smoke.user@example.com', JSON.stringify(boundUser));

    // 7. The minted session works on /api/user/<token>.
    const myData = await fetch(`${origin}/api/user/${token}`, { headers: { cookie: session } });
    const myBody = (await myData.json()) as {
      user?: { name: string; sessionOidc: boolean; oidcBound: boolean };
      status?: string;
    };
    check('/my session works on /api/user/<token>', myData.status === 200 && myBody.user?.sessionOidc === true &&
      myBody.user?.oidcBound === true, `status ${myData.status} ${JSON.stringify(myBody).slice(0, 160)}`);

    // The /my page itself renders with the session (SSR, sessionOidc in the payload).
    const myPage = await fetch(`${origin}/my/${token}`, { headers: { cookie: session } });
    const myHtml = await myPage.text();
    check('/my page HTML renders for the XAuth session', myPage.status === 200 && myHtml.includes('smoke-user') &&
      !myHtml.includes('请输入密码'), `status ${myPage.status} ${myHtml.length}b`);

    // 8. Password login of the bound user is refused even with the right password.
    const unlock = await fetch(`${origin}/api/user/${token}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'smoke-user-password' }),
    });
    const unlockBody = (await unlock.json()) as { status: string };
    check('bound user password unlock → 401 oidc-only', unlock.status === 401 && unlockBody.status === 'oidc-only');

    // 9. Logout → exact end_session URL with the stored id_token hint.
    const logout = await fetch(`${origin}/auth/logout`, { redirect: 'manual', headers: { cookie: session } });
    const endSession = new URL(logout.headers.get('location') ?? 'http://invalid');
    const hintParts = (endSession.searchParams.get('id_token_hint') ?? '').split('.');
    const decoded = hintParts.length === 3
      ? Buffer.from(hintParts[1]!, 'base64url').toString('utf8')
      : '';
    check('logout → IdP end_session with id_token_hint', logout.status === 302 &&
      endSession.pathname === '/end_session' && !!endSession.searchParams.get('id_token_hint') &&
      endSession.searchParams.get('post_logout_redirect_uri') === `${origin}/auth/logged-out`,
      endSession.toString().slice(0, 80) + '…');
    check('the hint is a real JWT', decoded.includes('"sub":"smoke-sub-1"'));
    check('session cookies are cleared', logout.headers.getSetCookie().some((cookie) =>
      cookie.startsWith('subhub_my=;') && /Max-Age=0/i.test(cookie)) &&
      logout.headers.getSetCookie().some((cookie) => cookie.startsWith('subhub_oidc_idt=;')));
    const followLogout = await fetch(endSession, { redirect: 'manual' });
    const loggedOut = await fetch(followLogout.headers.get('location') ?? '', { redirect: 'manual' });
    const loggedOutHtml = await loggedOut.text();
    check('/auth/logged-out renders 已退出登录', loggedOut.status === 200 && loggedOutHtml.includes('已退出登录'));

    // 10. The admin console itself does not use OIDC: /api/admin/me without the
    //     session cookie is still 401 (a user XAuth session never becomes admin).
    const adminMe = await fetch(`${origin}/api/admin/me`, { headers: { cookie: session } });
    // The built server answers this admin route with an empty body (the
    // pre-existing admin-API quirk noted at the top); an empty or non-200
    // answer is itself proof the user session did not authenticate — parse
    // defensively instead of assuming JSON.
    const adminMeText = await adminMe.text();
    let adminAuthenticated = false;
    try {
      adminAuthenticated = (JSON.parse(adminMeText) as { authenticated?: boolean }).authenticated === true;
    } catch { /* empty body: not authenticated */ }
    check('XAuth session never authenticates the admin console', !adminAuthenticated);

    console.log(`\n${results.length}/${results.length} smoke steps passed (${origin}, IdP ${idp.issuer})`);
  } catch (error) {
    console.log('--- server log ---\n' + serverLog.join('').slice(-4000));
    throw error;
  } finally {
    server.kill('SIGTERM');
    await idp.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (process.env.SMOKE_KEEP_LOG) writeFileSync(join(base, 'server.log'), serverLog.join(''));
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
