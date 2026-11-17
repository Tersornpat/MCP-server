/**
 * A small single-user OAuth 2.1 authorization server with no database.
 *
 * - Client registration: Client ID Metadata Documents (preferred) and Dynamic
 *   Client Registration (fallback). A registered client_id is an encrypted
 *   token that carries its own redirect URIs, so nothing is stored.
 * - The owner signs in on /authorize with LOGIN_PASSPHRASE.
 * - Authorization codes and refresh tokens are encrypted JWTs, access tokens
 *   are signed JWTs. All keys derive from TOKEN_SECRET, so changing
 *   TOKEN_SECRET revokes every token at once.
 *
 * Trade-off of having no storage: a refresh token stays valid until it expires
 * even after it has been rotated, and code replay protection is per instance.
 */
import { createHash, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { EncryptJWT, jwtDecrypt, jwtVerify, SignJWT } from 'jose';
import { authReady, type Config } from './config.js';

export const SCOPE = 'calendar';
export const MCP_PATH = '/mcp';
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 60 * 24 * 60 * 60;
const CODE_TTL_S = 60;
const AUTH_REQUEST_TTL_S = 10 * 60;
const CLIENT_TTL_S = 5 * 365 * 24 * 60 * 60;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

/** Only Claude's hosted callback and loopback clients (Claude Code, MCP Inspector) may receive codes. */
const HOSTED_CALLBACKS = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

export function isAllowedRedirect(uri: string): boolean {
  if (HOSTED_CALLBACKS.has(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.username && !u.hash;
  } catch {
    return false;
  }
}

/** Loopback redirects match with the port ignored (RFC 8252). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    const loopback = (u: URL) => u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    return loopback(a) && loopback(b) && a.hostname === b.hostname && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

export function originOf(req: Request): string {
  const u = new URL(req.url);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return `${local ? u.protocol : 'https:'}//${u.host}`;
}

// ---------- keys and sealed tokens ----------

const keyCache = new Map<string, { sign: Uint8Array; enc: Uint8Array }>();

function keys(cfg: Config) {
  let k = keyCache.get(cfg.tokenSecret);
  if (!k) {
    const derive = (info: string) =>
      new Uint8Array(hkdfSync('sha256', cfg.tokenSecret, 'apple-calendar-mcp', info, 32));
    k = { sign: derive('access-token-signing'), enc: derive('sealed-token-encryption') };
    keyCache.set(cfg.tokenSecret, k);
  }
  return k;
}

type Kind = 'client' | 'authreq' | 'code' | 'refresh';

async function seal(cfg: Config, kind: Kind, payload: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  return new EncryptJWT({ ...payload, k: kind })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .encrypt(keys(cfg).enc);
}

async function unseal(cfg: Config, kind: Kind, token: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtDecrypt(token, keys(cfg).enc, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    return payload.k === kind ? payload : null;
  } catch {
    return null;
  }
}

export async function verifyAccessToken(cfg: Config, token: string, origin: string): Promise<boolean> {
  if (!authReady(cfg)) return false;
  try {
    const { payload } = await jwtVerify(token, keys(cfg).sign, {
      algorithms: ['HS256'],
      issuer: origin,
      audience: origin + MCP_PATH,
    });
    return payload.sub === 'owner' && String(payload.scope ?? '').split(' ').includes(SCOPE);
  } catch {
    return false;
  }
}

async function issueTokens(cfg: Config, origin: string, clientId: string) {
  const now = Math.floor(Date.now() / 1000);
  const access = await new SignJWT({ scope: SCOPE, client_id: clientId })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setIssuer(origin)
    .setAudience(origin + MCP_PATH)
    .setSubject('owner')
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TTL_S)
    .setJti(randomUUID())
    .sign(keys(cfg).sign);
  const refresh = await seal(cfg, 'refresh', { cid: clientId, iss: origin }, REFRESH_TTL_S);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: SCOPE,
  };
}

// ---------- clients ----------

interface Client {
  id: string;
  name: string;
  redirectUris: string[];
}

const cimdCache = new Map<string, { at: number; client: Client }>();

async function fetchClientMetadata(url: string): Promise<Client | null> {
  const cached = cimdCache.get(url);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.client;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const hostIsIp = /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':');
  if (
    u.protocol !== 'https:' || u.pathname === '/' || u.username || u.password || u.hash ||
    hostIsIp || u.hostname === 'localhost' || !u.hostname.includes('.') || (u.port && u.port !== '443')
  ) {
    return null;
  }
  try {
    const res = await fetch(url, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > 100_000) return null;
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc.client_id !== url || !Array.isArray(doc.redirect_uris)) return null;
    const redirectUris = doc.redirect_uris.filter((r): r is string => typeof r === 'string');
    if (redirectUris.length === 0) return null;
    const client: Client = {
      id: url,
      name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 80) : u.hostname,
      redirectUris,
    };
    cimdCache.set(url, { at: Date.now(), client });
    return client;
  } catch {
    return null;
  }
}

async function resolveClient(cfg: Config, clientId: string): Promise<Client | null> {
  if (!clientId || clientId.length > 4000) return null;
  if (clientId.startsWith('https://')) return fetchClientMetadata(clientId);
  const p = await unseal(cfg, 'client', clientId);
  if (!p || !Array.isArray(p.ru)) return null;
  return { id: clientId, name: typeof p.n === 'string' ? p.n : 'MCP client', redirectUris: p.ru as string[] };
}

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(title: string, body: string, status: 200 | 400 | 401 | 429 | 503 = 200): Response {
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>
:root{color-scheme:light dark}body{font:16px/1.55 system-ui,-apple-system,"Sukhumvit Set","Noto Sans Thai",sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:Canvas;color:CanvasText}
main{width:min(26rem,calc(100vw - 2.5rem));padding:1.5rem 0}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0}
.box{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:.75rem;padding:1.25rem}
label{display:block;font-weight:600;margin:1rem 0 .35rem}input{width:100%;box-sizing:border-box;font:inherit;padding:.6rem .7rem;border-radius:.5rem;border:1px solid color-mix(in srgb,CanvasText 35%,transparent);background:Field;color:FieldText}
button{margin-top:1rem;width:100%;font:inherit;font-weight:600;padding:.65rem;border:0;border-radius:.5rem;background:#1f6feb;color:#fff;cursor:pointer}
.muted{opacity:.72;font-size:.9rem}.err{color:#d1242f;font-weight:600}code{font-size:.9em;word-break:break-all}ul{padding-left:1.2rem;margin:.5rem 0}
</style></head><body><main><div class="box">${body}</div></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

function oauthError(error: string, description: string, status: 400 | 401 | 503 = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' },
  });
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function passphraseMatches(cfg: Config, given: string): boolean {
  return timingSafeEqual(sha256(given), sha256(cfg.loginPassphrase));
}

const failures: number[] = [];
function lockedOut(): boolean {
  const now = Date.now();
  while (failures.length && now - failures[0] > FAILURE_WINDOW_MS) failures.shift();
  return failures.length >= MAX_FAILURES;
}

const usedCodes = new Map<string, number>();
function markCodeUsed(jti: string, expMs: number): boolean {
  const now = Date.now();
  for (const [k, v] of usedCodes) if (v < now) usedCodes.delete(k);
  if (usedCodes.has(jti)) return false;
  usedCodes.set(jti, expMs);
  return true;
}

function normalizeResource(r: string): string {
  return r.replace(/\/+$/, '');
}

function loginForm(clientName: string, redirectHost: string, sealedRequest: string, error?: string): string {
  return `<h1>อนุญาตให้เข้าถึง Apple Calendar</h1>
<p><strong>${esc(clientName)}</strong> ขอสิทธิ์อ่าน สร้าง แก้ไข และลบนัดในปฏิทิน iCloud ของคุณ</p>
<p class="muted">หลังอนุญาต ระบบจะพากลับไปที่ <code>${esc(redirectHost)}</code></p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/authorize" autocomplete="off">
<input type="hidden" name="request" value="${esc(sealedRequest)}">
<label for="pp">Passphrase ของเจ้าของ server</label>
<input id="pp" name="passphrase" type="password" required autofocus autocomplete="current-password">
<button type="submit">อนุญาต (Allow)</button>
</form>
<p class="muted">ถ้าคุณไม่ได้เป็นคนเริ่มการเชื่อมต่อนี้ ให้ปิดหน้านี้ได้เลย</p>`;
}

// ---------- routes ----------

export function mountOAuth(app: Hono, getConfig: () => Config): void {
  const open = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['content-type', 'authorization', 'mcp-protocol-version'], maxAge: 86400 });
  app.use('/.well-known/*', open);
  app.use('/token', open);
  app.use('/register', open);

  const resourceMetadata = (c: Context) => {
    const origin = originOf(c.req.raw);
    return c.json({
      resource: origin + MCP_PATH,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Apple Calendar MCP',
    });
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, resourceMetadata);

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = originOf(c.req.raw);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  // Dynamic Client Registration (RFC 7591), stateless.
  app.post('/register', async (c) => {
    const cfg = getConfig();
    if (!authReady(cfg)) return oauthError('temporarily_unavailable', 'Server is not configured yet', 503);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return oauthError('invalid_client_metadata', 'Body must be JSON');
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((r): r is string => typeof r === 'string') : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(isAllowedRedirect)) {
      return oauthError(
        'invalid_redirect_uri',
        'redirect_uris must be the Claude callback (https://claude.ai/api/mcp/auth_callback) or an http://localhost / http://127.0.0.1 URL',
      );
    }
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : 'MCP client';
    const clientId = await seal(cfg, 'client', { ru: uris, n: name }, CLIENT_TTL_S);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
      { 'cache-control': 'no-store' },
    );
  });

  app.get('/authorize', async (c) => {
    const cfg = getConfig();
    if (!authReady(cfg)) {
      return page('ยังตั้งค่าไม่ครบ', '<h1>Server ยังตั้งค่าไม่ครบ</h1><p>ต้องตั้ง <code>LOGIN_PASSPHRASE</code> และ <code>TOKEN_SECRET</code> ก่อน แล้ว redeploy</p>', 503);
    }
    const q = c.req.query();
    const origin = originOf(c.req.raw);
    const client = await resolveClient(cfg, q.client_id ?? '');
    if (!client) {
      return page('คำขอไม่ถูกต้อง', '<h1>ไม่รู้จัก client นี้</h1><p>ลองลบ connector ใน Claude แล้วเพิ่มใหม่</p>', 400);
    }
    const redirectUri = q.redirect_uri ?? '';
    if (!isAllowedRedirect(redirectUri) || !client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
      return page('คำขอไม่ถูกต้อง', '<h1>redirect_uri ไม่ได้รับอนุญาต</h1><p>Server นี้รับเฉพาะ Claude และ client บน localhost</p>', 400);
    }
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (q.state) u.searchParams.set('state', q.state);
      u.searchParams.set('iss', origin);
      return c.redirect(u.href, 302);
    };
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (!q.code_challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    if (q.resource && normalizeResource(q.resource) !== origin + MCP_PATH) {
      return back('invalid_target', `resource must be ${origin + MCP_PATH}`);
    }
    if ((q.state ?? '').length > 2000) return back('invalid_request', 'state is too long');
    const sealed = await seal(
      cfg,
      'authreq',
      { cid: client.id, cn: client.name, ru: redirectUri, cc: q.code_challenge, st: q.state ?? '', iss: origin },
      AUTH_REQUEST_TTL_S,
    );
    return page('อนุญาตให้เข้าถึง Apple Calendar', loginForm(client.name, new URL(redirectUri).host, sealed));
  });

  app.post('/authorize', async (c) => {
    const cfg = getConfig();
    if (!authReady(cfg)) return page('ยังตั้งค่าไม่ครบ', '<h1>Server ยังตั้งค่าไม่ครบ</h1>', 503);
    const form = await c.req.parseBody();
    const sealed = typeof form.request === 'string' ? form.request : '';
    const passphrase = typeof form.passphrase === 'string' ? form.passphrase : '';
    const origin = originOf(c.req.raw);
    const req = await unseal(cfg, 'authreq', sealed);
    if (!req || req.iss !== origin || typeof req.ru !== 'string' || !isAllowedRedirect(req.ru)) {
      return page('หมดเวลา', '<h1>คำขอหมดอายุ</h1><p>กลับไปที่ Claude แล้วกด Connect ใหม่อีกครั้ง</p>', 400);
    }
    if (lockedOut()) {
      return page('ลองใหม่ภายหลัง', '<h1>ใส่ผิดหลายครั้งเกินไป</h1><p>รอ 10 นาทีแล้วลองใหม่</p>', 429);
    }
    if (!passphraseMatches(cfg, passphrase)) {
      failures.push(Date.now());
      console.log(JSON.stringify({ evt: 'login', ok: false }));
      await new Promise((r) => setTimeout(r, 1200));
      const body = loginForm(String(req.cn ?? 'MCP client'), new URL(req.ru).host, sealed, 'Passphrase ไม่ถูกต้อง');
      return page('อนุญาตให้เข้าถึง Apple Calendar', body, 401);
    }
    console.log(JSON.stringify({ evt: 'login', ok: true }));
    const code = await seal(
      cfg,
      'code',
      { cid: req.cid, ru: req.ru, cc: req.cc, iss: origin, jti: randomUUID() },
      CODE_TTL_S,
    );
    const u = new URL(req.ru);
    u.searchParams.set('code', code);
    if (req.st) u.searchParams.set('state', String(req.st));
    u.searchParams.set('iss', origin);
    return c.redirect(u.href, 302);
  });

  app.post('/token', async (c) => {
    const cfg = getConfig();
    if (!authReady(cfg)) return oauthError('temporarily_unavailable', 'Server is not configured yet', 503);
    const origin = originOf(c.req.raw);
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody();
    } catch {
      return oauthError('invalid_request', 'Body must be application/x-www-form-urlencoded');
    }
    const str = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const grant = str('grant_type');

    if (grant === 'authorization_code') {
      const p = await unseal(cfg, 'code', str('code'));
      if (!p || p.iss !== origin) return oauthError('invalid_grant', 'Authorization code is invalid or expired');
      if (p.cid !== str('client_id')) return oauthError('invalid_grant', 'client_id does not match the authorization code');
      if (p.ru !== str('redirect_uri')) return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
      const verifier = str('code_verifier');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError('invalid_grant', 'code_verifier is missing or malformed');
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
      const expected = Buffer.from(String(p.cc));
      const actual = Buffer.from(challenge);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return oauthError('invalid_grant', 'PKCE verification failed');
      }
      if (!markCodeUsed(String(p.jti), Number(p.exp) * 1000)) {
        return oauthError('invalid_grant', 'Authorization code was already used');
      }
      return c.json(await issueTokens(cfg, origin, String(p.cid)), 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
    }

    if (grant === 'refresh_token') {
      const p = await unseal(cfg, 'refresh', str('refresh_token'));
      if (!p || p.iss !== origin) return oauthError('invalid_grant', 'Refresh token is invalid or expired');
      const clientId = str('client_id');
      if (clientId && p.cid !== clientId) return oauthError('invalid_grant', 'Refresh token belongs to another client');
      return c.json(await issueTokens(cfg, origin, String(p.cid)), 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
    }

    return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  });
}
