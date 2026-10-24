// SPDX-License-Identifier: AGPL-3.0-only
/**
 * POST /api/admin/login — password login for the management UI.
 *
 * Body: `{ "password": "..." }`. Success sets the httpOnly `subhub_admin`
 * cookie and returns `{ ok: true }`; a wrong password is a generic 401 that
 * reveals nothing about the configured value. The token is returned solely in
 * the httpOnly cookie. In production without SUBHUB_SECRET no session is ever
 * signed: the route answers a generic 500 (the detail goes to the server log).
 * Failed attempts are throttled per client IP and globally (login-throttle.ts).
 * Over a limit the request is not rejected: it is slowed down (a bounded
 * delay before the password check, `Retry-After` advertises the window), so
 * brute force is impractical while a correct password is never locked out.
 * The delays are serialized per IP (and globally when the global bucket is
 * exhausted), so concurrent over-limit requests queue up instead of all
 * sleeping at once and then checking passwords in the same instant.
 *
 * The JSON body is read straight off the node request rather than through
 * h3's `readBody`: Nitro's router consumes the stream first and keeps no node
 * `req.body`/parsed-body symbol, while the raw byte stream may already be
 * spent — reading it here would answer every login with "password required".
 * The cap keeps a hostile payload from being buffered unbounded.
 */
import { isSessionSigningUnavailable, login } from '../../utils/admin-auth';
import { getClientIp } from '../../utils/client-ip';
import {
  adminLoginThrottle,
  awaitLoginThrottle,
  defaultSleep,
  type LoginThrottle,
} from '../../utils/login-throttle';

/** Login bodies are tiny; anything bigger is rejected before parsing. */
export const MAX_LOGIN_BODY_BYTES = 4 * 1024;

interface LoginRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

interface LoginResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
}

type LoginEvent = {
  node: { req: LoginRequest; res: LoginResponse };
  _requestBody?: unknown;
  web?: { request?: { body?: unknown } };
  context?: { clientAddress?: string };
};

type BodySource = Record<string | symbol, unknown>;

/** Raw body offered by the adapter, if anything was buffered. */
function bufferedBody(req: LoginRequest & BodySource, event: LoginEvent): unknown {
  return (
    req.body ??
    event._requestBody ??
    req[Symbol.for('h3RawBody')] ??
    event.web?.request?.body
  );
}

/** Drain a node readable into a string, giving up past `limit` bytes. */
function drain(req: LoginRequest & BodySource, limit: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const on = req.on;
    if (typeof on !== 'function') {
      // No body stream at all (already consumed / empty request): nothing to read.
      resolve('');
      return;
    }
    on.call(
      req,
      'data',
      (...args: unknown[]) => {
        const chunk = args[0];
        if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') return;
        size += Buffer.byteLength(chunk);
        if (size > limit) {
          (req as { destroy?: () => void }).destroy?.();
          resolve('');
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      },
    );
    on.call(req, 'end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    on.call(req, 'error', () => resolve(''));
    on.call(req, 'aborted', () => resolve(''));
  });
}

async function readPassword(event: LoginEvent): Promise<unknown> {
  const req = event.node.req as LoginRequest & BodySource;
  const buffered = bufferedBody(req, event);

  let raw: unknown = buffered;
  if (raw === undefined || raw === null || raw === '') {
    const declared = req.headers['content-length'];
    const contentLength = Number(Array.isArray(declared) ? declared[0] : declared);
    if (Number.isFinite(contentLength) && contentLength > MAX_LOGIN_BODY_BYTES) return undefined;
    raw = await drain(req, MAX_LOGIN_BODY_BYTES);
  }

  if (raw && typeof raw === 'object') return (raw as { password?: unknown }).password;
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return (JSON.parse(raw) as { password?: unknown }).password;
  } catch {
    return undefined;
  }
}

/**
 * Client address used as the throttle key. Delegates to the shared helper
 * (client-ip.ts): the socket peer by default, or the header named by
 * SUBHUB_TRUSTED_IP_HEADER when configured. Only used as an opaque bucket key,
 * never logged.
 */
export function clientAddress(event: LoginEvent): string {
  return getClientIp(event);
}

export interface LoginHandlerOptions {
  /** Throttle override (tests); defaults to the process-wide limiter. */
  throttle?: LoginThrottle;
  /** Delay override (tests); defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Generic 500 body; the missing-config detail stays in the server log. */
export const LOGIN_MISCONFIGURED_ERROR = 'server error';

export default async function adminLoginHandler(
  event: LoginEvent,
  options: LoginHandlerOptions = {},
) {
  const throttle = options.throttle ?? adminLoginThrottle;
  const password = await readPassword(event);

  if (typeof password !== 'string' || password.length === 0) {
    event.node.res.statusCode = 400;
    return { error: 'password required' };
  }
  if (password.length > 1024) {
    // Cheap guard against absurd payloads; real passwords are far shorter.
    event.node.res.statusCode = 400;
    return { error: 'password too long' };
  }

  const decision = throttle.consume(clientAddress(event));
  if (decision.throttled) {
    // Never reject: slow the attempt down before any password work. The
    // response still advertises when the counter window resets.
    event.node.res.setHeader('cache-control', 'no-store');
    if (decision.retryAfter !== undefined) {
      event.node.res.setHeader('retry-after', String(decision.retryAfter));
    }
    // Serialized per IP (and globally): the wait starts only once the earlier
    // slowed requests are done, so a burst cannot defeat the slowdown.
    await awaitLoginThrottle(decision, options.sleep ?? defaultSleep);
  }

  if (isSessionSigningUnavailable()) {
    // Fail closed: a production deployment without SUBHUB_SECRET must not issue
    // sessions signed with the public development key. The client only learns
    // that the server failed; which setting is missing is a configuration
    // detail (and must not be probed from the outside).
    console.error('[admin/login] SUBHUB_SECRET is required in production; refusing to sign a session');
    event.node.res.statusCode = 500;
    event.node.res.setHeader('cache-control', 'no-store');
    return { error: LOGIN_MISCONFIGURED_ERROR };
  }

  const result = login(password);
  if (!result) {
    event.node.res.statusCode = 401;
    return { error: 'invalid password' };
  }

  // Successful login: give back the attempt — but only if it was counted in
  // any bucket. Refunding an over-limit request would hand a slot to someone
  // who legitimately used it and would reset the slowdown ladder.
  if (decision.counted) throttle.refund(clientAddress(event));
  event.node.res.setHeader('set-cookie', result.cookie);
  event.node.res.setHeader('cache-control', 'no-store');
  return { ok: true };
}
