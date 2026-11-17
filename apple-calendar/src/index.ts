/**
 * Apple Calendar MCP server: Hono app with an OAuth 2.1 authorization server
 * and a stateless Streamable HTTP MCP endpoint at /mcp.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { configStatus, loadConfig } from './config';
import { createMcpServer } from './mcp';
import { MCP_PATH, mountOAuth, originOf, SCOPE, verifyAccessToken } from './oauth';

const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('strict-transport-security', 'max-age=31536000');
});

mountOAuth(app, () => loadConfig());

function unauthorized(req: Request, error?: string): Response {
  const origin = originOf(req);
  const parts = [
    `resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`,
    `scope="${SCOPE}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer ${parts.join(', ')}` },
  });
}

app.all(MCP_PATH, async (c) => {
  const req = c.req.raw;
  const cfg = loadConfig();
  const header = req.headers.get('authorization') ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (!token) return unauthorized(req);
  if (!(await verifyAccessToken(cfg, token, originOf(req)))) return unauthorized(req, 'invalid_token');

  if (req.method !== 'POST') {
    // Stateless server: no standalone SSE stream and no session to delete.
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }), {
      status: 405,
      headers: { 'content-type': 'application/json', allow: 'POST' },
    });
  }

  const server = createMcpServer(cfg);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } catch {
    console.error('mcp request failed');
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
});

app.get('/', (c) => {
  const cfg = loadConfig();
  const s = configStatus(cfg);
  const origin = originOf(c.req.raw);
  const mark = (ok: boolean) => (ok ? '✅' : '⬜');
  const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Apple Calendar MCP</title><style>
:root{color-scheme:light dark}body{font:16px/1.6 system-ui,-apple-system,"Sukhumvit Set","Noto Sans Thai",sans-serif;max-width:40rem;margin:3rem auto;padding:0 1.25rem}
code{background:color-mix(in srgb,CanvasText 10%,transparent);padding:.1rem .35rem;border-radius:.3rem;word-break:break-all}li{margin:.3rem 0}h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.75rem}
</style></head><body>
<h1>Apple Calendar MCP</h1>
<p>MCP Server URL: <code>${origin}${MCP_PATH}</code></p>
<h2>สถานะการตั้งค่า</h2>
<ul style="list-style:none;padding:0">
<li>${mark(s.apple)} <code>APPLE_ID</code> และ <code>APPLE_APP_PASSWORD</code></li>
<li>${mark(s.passphrase)} <code>LOGIN_PASSPHRASE</code> (อย่างน้อย 16 ตัวอักษร)</li>
<li>${mark(s.tokenSecret)} <code>TOKEN_SECRET</code> (อย่างน้อย 32 ตัวอักษร)</li>
</ul>
<h2>เพิ่มใน Claude</h2>
<ol><li>Settings → Connectors → Add custom connector</li><li>วาง MCP Server URL ด้านบน</li><li>กด Connect แล้วใส่ passphrase</li></ol>
</body></html>`;
  return c.html(html, 200, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
});

app.get('/healthz', (c) => c.json({ ok: true }));

export default app;
