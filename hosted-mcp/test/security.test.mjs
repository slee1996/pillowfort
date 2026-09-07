import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const project = fileURLToPath(new URL('../', import.meta.url));
const admin = randomBytes(48).toString('base64url');
let directory, child, origin;

function request(path, { method = 'GET', json, form, headers = {} } = {}) {
  const body = form !== undefined ? Buffer.from(new URLSearchParams(form).toString()) : json === undefined ? undefined : Buffer.from(JSON.stringify(json));
  return new Promise((resolve, reject) => {
    // The fixture only connects to its own loopback self-signed Worker.
    const req = httpsRequest(origin + path, { method, rejectUnauthorized: false, headers: { ...(body ? { 'Content-Type': form === undefined ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': body.length } : {}), ...headers } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 3 * 1024 * 1024) response.destroy(new Error('Fixture response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Fixture request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pillowfort-auth-test-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  origin = `https://127.0.0.1:${port}`;
  const config = JSON.parse(await readFile(join(project, 'wrangler.jsonc'), 'utf8'));
  config.name = 'pillowfort-auth-test';
  config.main = relative(directory, join(project, 'src/index.ts'));
  delete config.routes;
  config.vars = { ...config.vars, PUBLIC_MCP_URL: origin + '/mcp', ADMIN_TOKEN: admin, CONSENT_SECRET: randomBytes(48).toString('base64url'), ALLOWED_ORIGINS: origin, MAX_SESSION_SECONDS: '30', IDLE_TIMEOUT_SECONDS: '120' };
  const configPath = join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  child = spawn(process.execPath, [join(project, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', String(port), '--local-protocol', 'https', '--local-upstream', `127.0.0.1:${port}`, '--upstream-protocol', 'https', '--persist-to', join(directory, 'state'), '--log-level', 'error'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  const capture = chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-8192).replaceAll(admin, '[redacted]').replaceAll(config.vars.CONSENT_SECRET, '[redacted]'); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const deadline = Date.now() + 45000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('Local authorization Worker exited before readiness.\\n' + diagnostics);
    try { if ((await request('/health')).status === 200) break; } catch {}
    if (Date.now() > deadline) throw new Error('Local authorization Worker did not become ready.\\n' + diagnostics);
    await delay(100);
  }
}, { timeout: 60000 });

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const deadline = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(deadline); resolve(); });
      child.kill('SIGTERM');
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'security-regression', version: '1.0.0' } } };
const mcpHeaders = key => ({ Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream' });
const issue = async label => {
  const response = await request('/admin/keys', { method: 'POST', json: { label, expiresInDays: 1 }, headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(response.status, 201);
  return response.body;
};

test('unauthenticated traffic cannot consume emergency key-revocation capacity', async () => {
  const key = await issue('revocation-regression');
  for (let i = 0; i < 100; i++) {
    const denied = await request('/admin/keys', { headers: { 'CF-Connecting-IP': `192.0.2.${Math.floor(i / 30) + 1}` } });
    assert([401, 429].includes(denied.status));
  }
  const revoked = await request('/admin/keys/' + key.id, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}`, 'CF-Connecting-IP': '192.0.2.251' } });
  assert.equal(revoked.status, 204);
  assert.equal((await request('/mcp', { method: 'POST', json: initialize, headers: mcpHeaders(key.key) })).status, 401);
});

test('MCP sessions are principal-bound, reject foreign origins, and cannot revive after DELETE', async () => {
  const first = await issue('first-principal');
  const second = await issue('second-principal');
  const session = await request('/mcp', { method: 'POST', json: initialize, headers: mcpHeaders(first.key) });
  assert.equal(session.status, 200);
  const id = session.headers['mcp-session-id'];
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const sessionHeaders = { ...mcpHeaders(first.key), 'MCP-Session-Id': id, 'MCP-Protocol-Version': '2025-11-25' };
  const tools = await request('/mcp', { method: 'POST', json: list, headers: sessionHeaders });
  assert.equal(tools.status, 200);
  assert(tools.body.result.tools.some(tool => tool.name === 'room_setup'));
  assert(!tools.body.result.tools.some(tool => tool.name.startsWith('cms_') || tool.name.startsWith('fort_pass_')));
  assert.equal((await request('/mcp', { method: 'POST', json: list, headers: { ...sessionHeaders, Authorization: `Bearer ${second.key}` } })).status, 404);
  assert.equal((await request('/mcp', { method: 'POST', json: list, headers: { ...sessionHeaders, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request('/mcp', { method: 'DELETE', headers: sessionHeaders })).status, 200);
  assert.equal((await request('/mcp', { method: 'POST', json: initialize, headers: sessionHeaders })).status, 404);
});

test('active requests cannot extend the absolute MCP session lifetime', { timeout: 50000 }, async () => {
  const key = await issue('absolute-expiry');
  const started = Date.now();
  const session = await request('/mcp', { method: 'POST', json: initialize, headers: mcpHeaders(key.key) });
  assert.equal(session.status, 200);
  const headers = { ...mcpHeaders(key.key), 'MCP-Session-Id': session.headers['mcp-session-id'], 'MCP-Protocol-Version': '2025-11-25' };
  let successfulPings = 0;
  while (Date.now() - started < 45000) {
    await delay(5000);
    const ping = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 3, method: 'ping' }, headers });
    if (ping.status === 404) {
      assert(successfulPings >= 2, 'The session must actually remain usable before expiring.');
      return;
    }
    assert.equal(ping.status, 200);
    successfulPings++;
  }
  assert.fail('Ongoing requests extended the session past its absolute deadline.');
});

test('real browser consent preserves Origin and completes the registered OAuth callback', { timeout: 30000 }, async () => {
  const key = await issue('browser-consent');
  const browser = await chromium.launch();
  let callbackServer;
  try {
    let code;
    callbackServer = createHttpServer((req, res) => {
      const target = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || target.pathname !== '/callback' || target.searchParams.get('state') !== 'browser-regression') {
        res.writeHead(404).end();
        return;
      }
      code = target.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Authorized local client</h1>');
    });
    await new Promise(resolve => callbackServer.listen(0, '127.0.0.1', resolve));
    const callbackOrigin = `http://127.0.0.1:${callbackServer.address().port}`;
    const callback = callbackOrigin + '/callback';
    const registered = await request('/oauth/register', { method: 'POST', json: { client_name: 'Browser regression', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'mcp:rooms' } });
    assert.equal(registered.status, 201);
    const clientId = registered.body.client_id;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(origin + '/authorize');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'mcp:rooms', resource: origin + '/mcp', code_challenge: challenge, code_challenge_method: 'S256', state: 'browser-regression' });
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(url.href);
    await page.fill('#operator-key', key.key);
    await page.check('input[name="approve"]');
    await page.click('button[value="allow"]');
    await page.waitForURL(target => target.origin === callbackOrigin, { timeout: 5000 });
    assert(code);
    const exchanged = await request('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code, code_verifier: verifier, resource: origin + '/mcp' } });
    assert.equal(exchanged.status, 200);
    const session = await request('/mcp', { method: 'POST', json: initialize, headers: mcpHeaders(exchanged.body.access_token) });
    assert.equal(session.status, 200);
    assert.equal((await request('/admin/keys/' + key.id, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } })).status, 204);
    assert.equal((await request('/mcp', { method: 'POST', json: initialize, headers: mcpHeaders(exchanged.body.access_token) })).status, 401);
  } finally {
    await browser.close();
    if (callbackServer) await new Promise(resolve => { callbackServer.close(resolve); callbackServer.closeAllConnections(); });
  }
});
