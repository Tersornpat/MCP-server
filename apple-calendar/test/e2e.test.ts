/**
 * End-to-end test: OAuth flow + MCP tools against a local Radicale CalDAV server.
 * Needs `pip install radicale`. Skipped automatically when Radicale is missing.
 * This checks the protocol work, not iCloud itself.
 */
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const hasRadicale = spawnSync('python3', ['-c', 'import radicale']).status === 0;
const DAV = 'http://127.0.0.1:5232';
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;
const PASSPHRASE = 'correct horse battery staple 42';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let radicale: ChildProcess | undefined;
let server: ReturnType<typeof serve> | undefined;
let accessToken = '';
let refreshToken = '';

async function mkcalendar(path: string, name: string) {
  const body = `<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>${name}</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
  const res = await fetch(`${DAV}/tester/${path}/`, {
    method: 'MKCALENDAR',
    headers: { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}`, 'content-type': 'application/xml' },
    body,
  });
  assert.equal(res.status, 201, `MKCALENDAR ${path}`);
}

async function waitFor(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${url} did not start`);
}

before(async () => {
  if (!hasRadicale) return;
  const dir = mkdtempSync(join(tmpdir(), 'radicale-'));
  radicale = spawn(
    'python3',
    ['-m', 'radicale', '--server-hosts', '127.0.0.1:5232', '--auth-type', 'none', '--storage-filesystem-folder', dir, '--logging-level', 'warning'],
    { stdio: 'ignore' },
  );
  await waitFor(DAV);
  await mkcalendar('mcp-project', 'MCP-project');
  await mkcalendar('home', 'Home');

  Object.assign(process.env, {
    APPLE_ID: 'tester',
    APPLE_APP_PASSWORD: 'x',
    CALDAV_URL: DAV,
    LOGIN_PASSPHRASE: PASSPHRASE,
    TOKEN_SECRET: randomBytes(48).toString('base64'),
    DEFAULT_CALENDAR_NAME: 'MCP-project',
    TIMEZONE: 'Asia/Bangkok',
  });
  const { default: app } = await import('../src/index.js');
  server = serve({ fetch: app.fetch, port: PORT });
  await waitFor(`${BASE}/healthz`);
});

after(() => {
  server?.close();
  radicale?.kill();
});

const opts = { skip: !hasRadicale && 'Radicale is not installed' };

async function register(redirectUris: string[]) {
  return fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }),
  });
}

function sealedRequestFrom(html: string): string {
  const m = /name="request" value="([^"]+)"/.exec(html);
  assert.ok(m, 'login form has a sealed request');
  return m[1];
}

test('discovery: 401 challenge and metadata line up', opts, async () => {
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  const challenge = res.headers.get('www-authenticate') ?? '';
  assert.match(challenge, /resource_metadata="http:\/\/localhost:3111\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.deepEqual(prm.authorization_servers, [BASE]);
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, BASE);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(as.client_id_metadata_document_supported, true);
});

test('registration rejects redirect URIs that are not Claude or loopback', opts, async () => {
  const bad = await register(['https://evil.example/callback']);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_redirect_uri');
});

test('authorization code flow with PKCE, wrong passphrase, replay and refresh', opts, async () => {
  const reg = await register([CALLBACK]);
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const verifier = randomBytes(40).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(`${BASE}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: 'code', client_id, redirect_uri: CALLBACK, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-123', scope: 'calendar', resource: `${BASE}/mcp`,
  }).toString();

  // Unregistered redirect_uri is refused on the page, never redirected to.
  const evil = new URL(authUrl);
  evil.searchParams.set('redirect_uri', 'https://evil.example/cb');
  assert.equal((await fetch(evil, { redirect: 'manual' })).status, 400);

  // PKCE is mandatory.
  const noPkce = new URL(authUrl);
  noPkce.searchParams.delete('code_challenge');
  const noPkceRes = await fetch(noPkce, { redirect: 'manual' });
  assert.equal(noPkceRes.status, 302);
  assert.match(noPkceRes.headers.get('location') ?? '', /error=invalid_request/);

  const formPage = await fetch(authUrl);
  assert.equal(formPage.status, 200);
  const sealed = sealedRequestFrom(await formPage.text());

  const wrong = await fetch(`${BASE}/authorize`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ request: sealed, passphrase: 'nope' }),
  });
  assert.equal(wrong.status, 401);

  const ok = await fetch(`${BASE}/authorize`, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ request: sealed, passphrase: PASSPHRASE }),
  });
  assert.equal(ok.status, 302);
  const location = new URL(ok.headers.get('location') ?? '');
  assert.equal(location.origin + location.pathname, CALLBACK);
  assert.equal(location.searchParams.get('state'), 'st-123');
  assert.equal(location.searchParams.get('iss'), BASE);
  const code = location.searchParams.get('code') ?? '';

  const exchange = (v: string) =>
    fetch(`${BASE}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, redirect_uri: CALLBACK, code_verifier: v }),
    });
  const badVerifier = await exchange(randomBytes(40).toString('base64url'));
  assert.equal(badVerifier.status, 400);
  assert.equal((await badVerifier.json()).error, 'invalid_grant');

  const good = await exchange(verifier);
  assert.equal(good.status, 200);
  const tokens = await good.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.expires_in > 0);
  accessToken = tokens.access_token;
  refreshToken = tokens.refresh_token;

  const replay = await exchange(verifier);
  assert.equal(replay.status, 400);

  const refreshed = await fetch(`${BASE}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id }),
  });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, refreshToken);

  const badRefresh = await fetch(`${BASE}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'garbage', client_id }),
  });
  assert.equal(badRefresh.status, 400);
  assert.equal((await badRefresh.json()).error, 'invalid_grant');
});

test('a forged or foreign token is rejected', opts, async () => {
  for (const token of ['abc', accessToken.slice(0, -4) + 'AAAA']) {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  }
});

test('MCP tools: list, create, read, update, delete', opts, async () => {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: res.isError === true, text: res.content[0].text, data: res.isError ? null : JSON.parse(res.content[0].text) };
  };

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['create_event', 'delete_event', 'get_events', 'list_calendars', 'update_event']);
  const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
  assert.equal(byName.get_events.annotations?.readOnlyHint, true);
  assert.equal(byName.delete_event.annotations?.destructiveHint, true);

  const cals = await call('list_calendars');
  assert.deepEqual(
    cals.data.calendars.map((c: { name: string; is_default: boolean }) => [c.name, c.is_default]).sort(),
    [['Home', false], ['MCP-project', true]],
  );

  const created = await call('create_event', {
    title: 'นัดหมอฟัน', start: '2026-11-20T16:00', end: '2026-11-20T17:00', location: 'คลินิก', alert_minutes_before: 30,
  });
  assert.equal(created.isError, false, created.text);
  const eventId: string = created.data.created.event_id;
  assert.equal(created.data.created.calendar, 'MCP-project');
  assert.equal(created.data.created.start, '2026-11-20T16:00:00+07:00');

  // The stored object is real iCalendar with the alarm.
  const raw = await fetch(`${DAV}/tester/mcp-project/`, {
    method: 'REPORT',
    headers: { authorization: `Basic ${Buffer.from('tester:x').toString('base64')}`, depth: '1', 'content-type': 'application/xml' },
    body: '<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>',
  });
  const stored = await raw.text();
  assert.match(stored, /TRIGGER:-PT30M/);
  assert.match(stored, /DTSTART;TZID=Asia\/Bangkok:20261120T160000/);

  await call('create_event', { title: 'Trail ด่านช้าง', start: '2026-11-21', end: '2026-11-22', all_day: true, calendar_id: 'Home' });
  await call('create_event', {
    title: 'Morning run', start: '2026-11-16T06:00', end: '2026-11-16T07:00', recurrence: { frequency: 'daily', count: 30 },
  });

  const day = await call('get_events', { start: '2026-11-20T00:00', end: '2026-11-21T00:00' });
  assert.deepEqual(day.data.events.map((e: { title: string }) => e.title), ['Morning run', 'นัดหมอฟัน']);
  const week = await call('get_events', { start: '2026-11-20', end: '2026-11-23' });
  assert.equal(week.data.count, 5); // 3 runs + dentist + 2-day all-day event
  const homeOnly = await call('get_events', { start: '2026-11-20', end: '2026-11-23', calendar_id: 'Home' });
  assert.deepEqual(homeOnly.data.events.map((e: { title: string; end: string }) => [e.title, e.end]), [['Trail ด่านช้าง', '2026-11-22']]);

  const updated = await call('update_event', { event_id: eventId, start: '2026-11-20T15:00', title: 'หมอฟัน (เลื่อน)', alert_minutes_before: 60 });
  assert.equal(updated.isError, false, updated.text);
  assert.equal(updated.data.updated.end, '2026-11-20T16:00:00+07:00');
  assert.deepEqual(updated.data.updated.alert_minutes_before, [60]);
  assert.equal(updated.data.updated.event_id, eventId);

  const badInput = await call('create_event', { title: 'x', start: 'next friday', end: '2026-11-20T17:00' });
  assert.equal(badInput.isError, true);
  assert.match(badInput.text, /ISO 8601/);
  const badId = await call('delete_event', { event_id: 'not-a-real-id' });
  assert.equal(badId.isError, true);
  const traversal = await call('delete_event', { event_id: Buffer.from(JSON.stringify(['home', '../x.ics'])).toString('base64url') });
  assert.equal(traversal.isError, true);

  const deleted = await call('delete_event', { event_id: eventId });
  assert.equal(deleted.isError, false, deleted.text);
  const again = await call('delete_event', { event_id: eventId });
  assert.equal(again.isError, true);
  const after = await call('get_events', { start: '2026-11-20T00:00', end: '2026-11-21T00:00' });
  assert.deepEqual(after.data.events.map((e: { title: string }) => e.title), ['Morning run']);

  await client.close();
});
