import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
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
let directory, child, relay, origin, otelReceiver, launchWorker;
const telemetryPayloads = [];

let fixtureNetwork = 0;
let fixtureAddress = '192.0.2.1';
// Independent scenarios get independent edge-network rate buckets. Individual
// rate-limit cases still send repeated requests from one explicit address.
beforeEach(() => { fixtureAddress = `192.0.2.${++fixtureNetwork}`; });

const PROTOCOL = '2026-07-28';
const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL,
  'io.modelcontextprotocol/clientInfo': { name: 'security-regression', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
function modern(json) {
  if (!json || Array.isArray(json) || !json.method) return json;
  return { ...json, params: { ...json.params, _meta: { ...envelope, ...json.params?._meta } } };
}
function wireHeaders(json) {
  return {
    'MCP-Protocol-Version': PROTOCOL, 'Mcp-Method': json.method,
    ...(json.params?.name ? { 'Mcp-Name': json.params.name } : {}),
    ...(json.params?.uri ? { 'Mcp-Name': json.params.uri } : {}),
  };
}
function request(path, { method = 'GET', json, form, headers = {} } = {}) {
  const body = form !== undefined ? Buffer.from(new URLSearchParams(form).toString()) : json === undefined ? undefined : Buffer.from(JSON.stringify(modern(json)));
  return new Promise((resolve, reject) => {
    // The fixture only connects to its own loopback self-signed Worker.
    const req = httpsRequest(origin + path, { method, rejectUnauthorized: false, headers: { 'CF-Connecting-IP': fixtureAddress, ...(body ? { 'Content-Type': form === undefined ? 'application/json' : 'application/x-www-form-urlencoded', 'Content-Length': body.length } : {}), ...(json?.method ? wireHeaders(json) : {}), ...headers } }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 3 * 1024 * 1024) response.destroy(new Error('Fixture response too large')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: text ? (response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text) : null });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Fixture request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function listen(key, id, notifications) {
  const json = modern({ jsonrpc: '2.0', id, method: 'subscriptions/listen', params: { notifications } });
  const body = Buffer.from(JSON.stringify(json));
  const messages = [];
  let incoming;
  let ended = false;
  let failure;
  const req = httpsRequest(origin + '/mcp', {
    method: 'POST', rejectUnauthorized: false,
    headers: { 'CF-Connecting-IP': fixtureAddress, ...mcpHeaders(key), ...wireHeaders(json), 'Content-Type': 'application/json', 'Content-Length': body.length },
  });
  const ready = new Promise((resolve, reject) => {
    req.on('response', response => {
      incoming = response;
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) {
        response.resume();
        reject(new Error(`Expected POST SSE subscription, got ${response.statusCode}`));
        return;
      }
      let pending = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        pending += chunk.replaceAll('\r\n', '\n');
        for (;;) {
          const boundary = pending.indexOf('\n\n');
          if (boundary < 0) break;
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (data) {
            try { messages.push(JSON.parse(data)); } catch (error) { failure = error; }
          }
        }
      });
      response.on('end', () => { ended = true; });
      response.on('close', () => { ended = true; });
      response.on('error', error => { if (!ended) failure = error; });
      resolve();
    });
    req.on('error', reject);
  });
  req.end(body);
  return {
    messages, ready,
    async next(predicate) {
      await ready;
      const deadline = Date.now() + 5000;
      for (;;) {
        if (failure) throw failure;
        const found = messages.find(predicate);
        if (found) return found;
        assert(Date.now() < deadline && !ended, 'Expected subscription event before stream closure/deadline.');
        await delay(20);
      }
    },
    cancel() { ended = true; incoming?.destroy(); req.destroy(); },
    async closed() {
      const deadline = Date.now() + 5000;
      while (!ended && Date.now() < deadline) await delay(20);
      assert(ended, 'Revocation or expiry must close an existing subscription.');
    },
  };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pillowfort-auth-test-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  origin = `https://127.0.0.1:${port}`;
  const relayReservation = createServer();
  await new Promise(resolve => relayReservation.listen(0, '127.0.0.1', resolve));
  const relayPort = relayReservation.address().port;
  await new Promise(resolve => relayReservation.close(resolve));
  const relayOrigin = `http://127.0.0.1:${relayPort}`;
  relay = spawn('bun', ['server.ts'], {
    cwd: join(project, '..'),
    env: { ...process.env, PORT: String(relayPort), NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  let relayStartError;
  relay.once('error', error => { relayStartError = error; });
  const relayDeadline = Date.now() + 15000;
  for (;;) {
    if (relayStartError || relay.exitCode !== null) throw new Error('Local encrypted relay could not start.');
    try {
      const response = await fetch(relayOrigin, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      break;
    } catch {}
    if (Date.now() >= relayDeadline) throw new Error('Local encrypted relay did not become ready.');
    await delay(100);
  }
  otelReceiver = createHttpServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    telemetryPayloads.push({ path: incoming.url, authorization: incoming.headers.authorization, text: Buffer.concat(chunks).toString('utf8') });
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise(resolve => otelReceiver.listen(0, '127.0.0.1', resolve));
  const config = JSON.parse(await readFile(join(project, 'wrangler.jsonc'), 'utf8'));
  config.name = 'pillowfort-auth-test';
  config.main = relative(directory, join(project, 'src/index.ts'));
  delete config.routes;
  // Only this temporary local fixture may connect to its own loopback relay.
  config.compatibility_flags = config.compatibility_flags.filter(flag => flag !== 'global_fetch_strictly_public');
  config.vars = { ...config.vars, PUBLIC_MCP_URL: origin + '/mcp', APP_URL: relayOrigin, ADMIN_TOKEN: admin, CONSENT_SECRET: randomBytes(48).toString('base64url'), ALLOWED_ORIGINS: origin, MAX_SESSION_SECONDS: '30', IDLE_TIMEOUT_SECONDS: '120' };
  Object.assign(config.vars, {
    OTEL_ENABLED: 'true',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${otelReceiver.address().port}`,
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20local-test-ingestion',
    OTEL_DEPLOYMENT_ENVIRONMENT: 'test',
    OTEL_SAMPLE_RATE: '1',
  });
  const configPath = join(directory, 'wrangler.json');
  launchWorker = async (overrides = {}) => {
  Object.assign(config.vars, overrides);
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
  };
  await launchWorker();
}, { timeout: 60000 });

after(async () => {
  await Promise.all([child, relay].map(async process => {
    if (!process || !process.pid || process.exitCode !== null || process.signalCode !== null) return;
    await new Promise(resolve => {
      const deadline = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 5000);
      process.once('exit', () => { clearTimeout(deadline); resolve(); });
      process.kill('SIGTERM');
    });
  }));
  if (otelReceiver?.listening) await new Promise(resolve => otelReceiver.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const discovery = { jsonrpc: '2.0', id: 1, method: 'server/discover' };

test('public modern discovery exposes one full catalog without allocating identities or permitting tools', async () => {
  const headers = { Accept: 'application/json, text/event-stream' };
  const before = (await request('/preflight')).body;
  const discovered = await request('/mcp', { method: 'POST', json: discovery, headers });
  assert.equal(discovered.status, 200);
  assert.equal(discovered.headers['mcp-session-id'], undefined);
  assert.equal(discovered.body.result.resultType, 'complete');
  assert.equal(discovered.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'pillowfort');
  let names;
  for (const toolset of [undefined, 'collaboration', 'full']) {
    const listed = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers: { ...headers, ...(toolset ? { 'Pillowfort-Toolset': toolset } : {}) } });
    assert.equal(listed.status, 200);
    const actual = listed.body.result.tools.map(tool => tool.name).sort();
    assert(actual.includes('chat_verify_received') && actual.includes('chat_format') && actual.some(name => name.startsWith('ttt_')));
    assert(!actual.some(name => name.startsWith('cms_') || name.startsWith('fort_pass_')));
    if (names) assert.deepEqual(actual, names);
    names = actual;
  }
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_create', arguments: {} } };
  for (const json of [call, [modern(discovery), modern(call)]]) {
    const denied = await request('/mcp', { method: 'POST', json, headers });
    assert.equal(denied.status, 401);
    assert(denied.headers['www-authenticate']);
  }
  assert.equal((await request('/mcp', { method: 'POST', json: discovery, headers: { ...headers, Authorization: 'Bearer invalid' } })).status, 401);
  const after = (await request('/preflight')).body;
  assert.equal(after.quota.activeSessions, before.quota.activeSessions);
  assert.equal(after.quota.remainingDailySessionSeconds, before.quota.remainingDailySessionSeconds);
});

test('modern transport rejects legacy methods and validates request headers and envelopes', async () => {
  const access = await selfService();
  const headers = mcpHeaders(access.access_token);
  try {
    for (const method of ['GET', 'DELETE']) assert.equal((await request('/mcp', { method, headers })).status, 405);
    const legacy = await request('/mcp', { method: 'POST', headers, json: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } } } });
    assert(legacy.status >= 400 || legacy.body.error, 'The initialize handshake must not be supported.');
    for (const [extra, params] of [
      [{ 'Mcp-Method': 'tools/call' }, {}],
      [{ 'MCP-Protocol-Version': '2025-11-25' }, {}],
      [{}, { _meta: { 'io.modelcontextprotocol/clientCapabilities': null } }],
    ]) {
      const invalid = await request('/mcp', { method: 'POST', headers: { ...headers, ...extra }, json: { ...discovery, params } });
      assert.equal(invalid.status, 400);
      assert(invalid.body.error);
    }
    const missingName = await request('/mcp', { method: 'POST', headers: { ...headers, 'Mcp-Name': 'session_list' }, json: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_create', arguments: {} } } });
    assert.equal(missingName.status, 400);
    assert.equal((await request('/preflight')).body.quota.activeSessions, 0);
  } finally { await request('/mcp/access', { method: 'DELETE', headers }); }
});
const mcpHeaders = key => ({ Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream' });
const issue = async label => {
  const response = await request('/admin/keys', { method: 'POST', json: { label, expiresInDays: 1 }, headers: { Authorization: `Bearer ${admin}` } });
  assert.equal(response.status, 201);
  return response.body;
};
const selfService = async () => {
  const response = await request('/access', { method: 'POST', json: { acceptManagedCustody: true } });
  assert.equal(response.status, 201);
  return response.body;
};

async function waitForAllocation() {
  const preflight = await request('/preflight');
  assert.equal(preflight.status, 200);
  const quota = preflight.body.quota;
  assert(quota.retryAfterSeconds <= quota.sessionStartSpacingSeconds, 'The fixture must not wait through exhausted shared capacity or a daily budget.');
  if (quota.retryAfterSeconds > 0) await delay(quota.retryAfterSeconds * 1000 + 50);
  assert.equal((await request('/preflight')).body.quota.canStartFullSession, true);
}

test('self-service requires custody consent, cannot elevate lifetime or scope, and revokes without an administrator', async () => {
  const before = await request('/preflight');
  assert.equal(before.status, 200);
  assert.equal(before.body.quota.activeSessions, 0);
  const browserBootstrap = await request('/access', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' } });
  assert.equal(browserBootstrap.status, 204);
  assert.equal(browserBootstrap.headers['access-control-allow-origin'], origin);
  for (const json of [{}, { acceptManagedCustody: false }, { acceptManagedCustody: true, expires_in: 86_400 }, { acceptManagedCustody: true, scope: 'admin' }]) {
    assert.equal((await request('/access', { method: 'POST', json })).status, 400);
  }
  assert.equal((await request('/access', { method: 'POST', json: { acceptManagedCustody: true }, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const started = Math.floor(Date.now() / 1000);
  const access = await selfService();
  assert.equal(access.scope, 'mcp:rooms');
  assert.equal(access.expires_in, 3600);
  assert(access.expires_at >= started + 3600 && access.expires_at <= started + 3605);
  const revocation = new URL(access.revocation_endpoint);
  assert.equal(revocation.origin, origin);
  const headers = mcpHeaders(access.access_token);
  try {
    const listed = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers });
    assert.equal(listed.status, 200);
    assert(listed.body.result.tools.some(tool => tool.name === 'chat_verify_received'));
    assert(listed.body.result.tools.some(tool => tool.name === 'chat_format'));
    assert(listed.body.result.tools.some(tool => tool.name.startsWith('ttt_')));
    assert.equal((await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 4, method: 'tools/list' }, headers: { ...headers, 'Pillowfort-Toolset': 'full' } })).status, 200);
    const after = await request('/preflight');
    assert.equal(after.body.quota.activeSessions, 0, 'Access and discovery must not allocate a participant.');
    assert.equal(after.body.quota.remainingDailySessionSeconds, before.body.quota.remainingDailySessionSeconds);
  } finally {
    assert.equal((await request(revocation.pathname, { method: 'DELETE', headers: mcpHeaders(access.access_token) })).status, 204);
  }
  assert.equal((await request('/mcp', { method: 'POST', json: discovery, headers: mcpHeaders(access.access_token) })).status, 401);
  assert.equal((await request(revocation.pathname, { method: 'DELETE', headers: mcpHeaders(access.access_token) })).status, 401);
});

test('enabled telemetry exports from the real Worker runtime without leaking credentials', async () => {
  const before = telemetryPayloads.length;
  assert.equal((await request('/health')).status, 200);
  const deadline = Date.now() + 5000;
  while (telemetryPayloads.length === before && Date.now() < deadline) await delay(20);
  const received = telemetryPayloads[before];
  assert(received, 'An enabled, healthy Worker must deliver its OTLP request.');
  assert.equal(received.path, '/v1/traces');
  assert.equal(received.authorization, 'Bearer local-test-ingestion');
  assert(!received.text.includes(admin));
  assert(!received.text.includes(origin));
  const resource = JSON.parse(received.text).resourceSpans[0];
  const attrs = Object.fromEntries(resource.resource.attributes.map(({ key, value }) => [key, value.stringValue]));
  assert.equal(attrs['service.name'], 'pillowfort.hosted-mcp');
  const scope = resource.scopeSpans[0];
  assert.equal(scope.scope.name, 'pillowfort.operational');
  const span = scope.spans[0];
  assert.equal(span.name, 'http.server.request');
  assert(span.attributes.some(({ key, value }) => key === 'pillowfort.operation' && value.stringValue === 'health'));
  assert(span.attributes.some(({ key, value }) => key === 'http.response.status_code' && Number(value.intValue) === 200));
});

test('MCP metadata and tool arguments are bounded before validation without losing a principal', async () => {
  const key = await issue('request-limits');
  const oversized = { ...discovery, params: { _meta: { icons: Array(200_000).fill(null) } } };
  const wide = { ...discovery, params: { _meta: { icons: Array(10_000).fill(null) } } };
  assert(Buffer.byteLength(JSON.stringify(oversized)) < 1024 * 1024, 'Reproduce the original under-1-MiB attack.');
  assert(Buffer.byteLength(JSON.stringify(wide)) < 64 * 1024, 'Exercise the structural limit independently of the byte limit.');
  let nested = null;
  for (let i = 0; i < 40; i++) nested = { nested };
  const deep = { ...discovery, params: { _meta: { nested } } };
  for (const json of [oversized, wide, deep]) {
    assert.equal((await request('/mcp', { method: 'POST', json, headers: mcpHeaders(key.key) })).status, 413);
  }

  const headers = mcpHeaders(key.key);
  try {
    const hostile = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_create', arguments: { session: 'must-not-exist', extra: Array(10_000).fill(null) } } };
    assert.equal((await request('/mcp', { method: 'POST', json: hostile, headers })).status, 413);
    const listed = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_list', arguments: {} } }, headers });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result.structuredContent, { ok: true, data: [] });
  } finally {
    await request(`/admin/keys/${key.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } });
  }
});

test('unauthenticated traffic cannot consume emergency key-revocation capacity', async () => {
  const key = await issue('revocation-regression');
  for (let i = 0; i < 100; i++) {
    const denied = await request('/admin/keys', { headers: { 'CF-Connecting-IP': `192.0.2.${Math.floor(i / 30) + 1}` } });
    assert([401, 429].includes(denied.status));
  }
  const revoked = await request('/admin/keys/' + key.id, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}`, 'CF-Connecting-IP': '192.0.2.251' } });
  assert.equal(revoked.status, 204);
  assert.equal((await request('/mcp', { method: 'POST', json: discovery, headers: mcpHeaders(key.key) })).status, 401);
});

test('self-service native rooms preserve encrypted admission, verified receiver chat, principal isolation, and terminal closure', { timeout: 45000 }, async () => {
  const first = await selfService();
  const second = await selfService();
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const sessionHeaders = mcpHeaders(first.access_token);
  const tools = await request('/mcp', { method: 'POST', json: list, headers: sessionHeaders });
  assert.equal(tools.status, 200);
  assert(tools.body.result.tools.some(tool => tool.name === 'room_setup'));
  assert(!tools.body.result.tools.some(tool => tool.name.startsWith('cms_') || tool.name.startsWith('fort_pass_')));
  assert.equal((await request('/mcp', { method: 'POST', json: list, headers: mcpHeaders(second.access_token) })).status, 200);
  assert.equal((await request('/mcp', { method: 'POST', json: list, headers: { ...sessionHeaders, Origin: 'https://untrusted.example' } })).status, 403);
  let callId = 4;
  const handles = new Map();
  const call = async (name, args) => {
    if (args.session && handles.has(args.session)) args = { ...args, session: handles.get(args.session) };
    const response = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: callId++, method: 'tools/call', params: { name, arguments: args } }, headers: sessionHeaders });
    assert.equal(response.status, 200);
    return response.body.result.structuredContent;
  };
  assert.equal((await call('session_create', { session: 'caller-selected' })).error.code, 'INVALID_INPUT');
  assert.equal((await request('/preflight')).body.quota.activeSessions, 0);
  for (const label of ['first', 'second']) {
    const created = await call('session_create', {});
    assert.equal(created.ok, true);
    assert.match(created.data.session, /^[0-9a-f-]{36}$/);
    assert.equal(created.data.state, 'ready');
    handles.set(label, created.data.session);
  }
  assert.notEqual(handles.get('first'), handles.get('second'));
  const stolen = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'session_observe', arguments: { session: handles.get('first') } } }, headers: mcpHeaders(second.access_token) });
  assert.equal(stolen.body.result.structuredContent.error.code, 'SESSION_NOT_FOUND');
  const capacity = (await request('/preflight')).body.quota;
  assert.equal(capacity.activeSessions, 1);
  assert.equal(capacity.canStartFullSession, false, 'Participant start spacing is visible without another allocation.');
  assert.equal((await call('session_create', {})).error.code, 'SESSION_LIMIT');
  assert.equal((await call('chat_format', { session: 'first', input: { bold: true } })).ok, true);
  // Exceed production's ordinary 10-second actor-hibernation window without any request.
  await delay(12_000);
  const firstSnapshot = (await call('session_observe', { session: 'first' })).data;
  const secondSnapshot = (await call('session_observe', { session: 'second' })).data;
  assert.equal(firstSnapshot.formatting.bold, true);
  assert.notEqual(secondSnapshot.formatting.bold, true, 'Named participants must not share mutable formatting state.');
  const execute = async (session, name, input) => {
    const result = await call(name, { session, input });
    assert.equal(result.ok, true, `${name} failed: ${result.error?.code ?? 'unknown'}`);
    return result.data;
  };
  const observeUntil = async (session, predicate, description) => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const result = await call('session_observe', { session });
      assert.equal(result.ok, true, `Observation failed: ${result.error?.code ?? 'unknown'}`);
      if (predicate(result.data)) return result.data;
      assert(Date.now() < deadline, `Timed out waiting for ${description}.`);
      await delay(100);
    }
  };
  const creation = await execute('first', 'room_setup', { displayName: 'native-host', confirm: true });
  const roomId = creation.roomId;
  await observeUntil('first', snapshot => snapshot.legalActions.canAct && snapshot.connection.isHost, 'host setup');
  const invitation = await execute('first', 'invitation_export', { roomId, confirm: true });
  await execute('second', 'room_join_link', { invitationUrl: invitation.invitationUrl, displayName: 'native-guest', confirm: true });
  const joining = await observeUntil('second', snapshot => typeof snapshot.room.pendingJoinFingerprint === 'string', 'guest fingerprint');
  // Both independently controlled sessions are the trusted private channel.
  const fingerprint = joining.room.pendingJoinFingerprint;
  const admission = await observeUntil('first', snapshot => snapshot.room.pendingAdmissions.some(item => item.status === 'pending' && item.deviceFingerprint === fingerprint), 'matching host admission');
  const matches = admission.room.pendingAdmissions.filter(item => item.status === 'pending' && item.deviceFingerprint === fingerprint);
  assert.equal(matches.length, 1);
  assert.equal((await call('session_observe', { session: 'second' })).data.room.pendingJoinFingerprint, fingerprint);
  await execute('first', 'admission_approve', { roomId, admissionId: matches[0].admissionId, deviceFingerprint: fingerprint, confirm: true });
  await observeUntil('second', snapshot => snapshot.legalActions.canAct && snapshot.room.members.some(member => member.name === 'native-host'), 'guest membership');
  await observeUntil('first', snapshot => snapshot.legalActions.canAct && snapshot.room.members.some(member => member.name === 'native-guest'), 'host roster update');
  const hostUri = `pillowfort://sessions/${handles.get('first')}/mentions`;
  const guestUri = `pillowfort://sessions/${handles.get('second')}/mentions`;
  const hostStream = listen(first.access_token, 'host-mentions', { resourceSubscriptions: [hostUri] });
  const guestStream = listen(first.access_token, 'guest-mentions', { resourceSubscriptions: [guestUri] });
  const ack = message => message.method === 'notifications/subscriptions/acknowledged';
  await Promise.all([hostStream.next(ack), guestStream.next(ack)]);
  const foreignFilter = await request('/mcp', { method: 'POST', headers: mcpHeaders(second.access_token), json: { jsonrpc: '2.0', id: 51, method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: [guestUri] } } } });
  assert.equal(foreignFilter.body.error.code, -32602);
  const foreignRead = await request('/mcp', { method: 'POST', headers: mcpHeaders(second.access_token), json: { jsonrpc: '2.0', id: 52, method: 'resources/read', params: { uri: guestUri } } });
  assert.equal(foreignRead.body.error.code, -32602);
  const hostText = '@native-guest Native host encrypted regression message';
  const guestText = '@native-host Native guest encrypted regression response';
  const guestCursor = (await execute('second', 'participant_preflight', {})).latestMessageId;
  const hostCursor = (await execute('first', 'participant_preflight', {})).latestMessageId;
  await execute('first', 'chat_send', { roomId, text: hostText });
  await observeUntil('second', snapshot => snapshot.messages.some(message => message.from === 'native-host' && message.text === hostText), 'host message delivery');
  const guestUpdate = await guestStream.next(message => message.method === 'notifications/resources/updated');
  assert.equal(guestUpdate.params.uri, guestUri);
  assert.equal(guestUpdate.params._meta['io.modelcontextprotocol/subscriptionId'], 'guest-mentions');
  assert(!hostStream.messages.some(message => message.method === 'notifications/resources/updated'));
  assert.equal((await execute('second', 'chat_verify_received', { roomId, from: 'native-host', text: hostText, afterMessageId: guestCursor })).status, 'received');
  assert.equal((await call('chat_verify_received', { session: 'first', input: { roomId, from: 'native-host', text: hostText, afterMessageId: hostCursor } })).error.code, 'receiver-required');
  await execute('second', 'chat_send', { roomId, text: guestText });
  await observeUntil('first', snapshot => snapshot.messages.some(message => message.from === 'native-guest' && message.text === guestText), 'guest message delivery');
  const hostUpdate = await hostStream.next(message => message.method === 'notifications/resources/updated');
  assert.equal(hostUpdate.params.uri, hostUri);
  assert.equal(hostUpdate.params._meta['io.modelcontextprotocol/subscriptionId'], 'host-mentions');
  guestStream.cancel();
  const cancelledCount = guestStream.messages.length;
  await execute('first', 'chat_send', { roomId, text: '@native-guest after subscription cancellation' });
  await observeUntil('second', snapshot => snapshot.messages.some(message => message.text === '@native-guest after subscription cancellation'), 'post-cancellation delivery');
  assert.equal(guestStream.messages.length, cancelledCount);
  hostStream.cancel();
  assert.equal((await execute('first', 'chat_verify_received', { roomId, from: 'native-guest', text: guestText, afterMessageId: hostCursor })).status, 'received');
  // Cross-direction delivery drains the previous encrypted control/ACK sequence.
  // Check both transcripts, so duplicated socket events cannot masquerade as success.
  for (const session of ['first', 'second']) {
    const snapshot = (await call('session_observe', { session })).data;
    assert.equal(snapshot.messages.filter(message => message.from === 'native-host' && message.text === hostText).length, 1);
    assert.equal(snapshot.messages.filter(message => message.from === 'native-guest' && message.text === guestText).length, 1);
  }
  await execute('first', 'room_end', { roomId, confirm: true });
  await Promise.all(['first', 'second'].map(session => observeUntil(session, snapshot => snapshot.connection.terminalPresentation === 'room-destroyed' && snapshot.connection.roomId === null, 'authenticated room retirement')));
  const closedRoomSnapshot = (await call('session_observe', { session: 'first' })).data;
  const waiting = call('session_wait', { session: 'first', afterRevision: closedRoomSnapshot.revision, timeoutMs: 30000 });
  await delay(100);
  assert.equal((await call('session_close', { session: 'first', confirm: true })).ok, true);
  assert.equal((await waiting).error.code, 'SESSION_CLOSED');
  assert.equal((await call('session_observe', { session: 'first' })).error.code, 'SESSION_NOT_FOUND');
  assert.equal((await call('session_observe', { session: 'second' })).ok, true);
  const replacement = await call('session_create', {});
  assert.equal(replacement.ok, true);
  assert.notEqual(replacement.data.session, handles.get('first'));
  assert.equal((await call('session_observe', { session: 'first' })).error.code, 'SESSION_NOT_FOUND');
  assert.equal((await call('session_close', { session: replacement.data.session, confirm: true })).ok, true);
  assert.equal((await call('session_close', { session: 'second', confirm: true })).ok, true);
  assert.equal((await call('session_observe', { session: 'second' })).error.code, 'SESSION_NOT_FOUND');
  assert.deepEqual((await call('session_list', {})).data, []);
  assert.equal((await request('/preflight')).body.quota.activeSessions, 0);
  const revokedStream = listen(first.access_token, 'revocation-listener', { toolsListChanged: true });
  await revokedStream.next(ack);
  for (const access of [first, second]) assert.equal((await request('/mcp/access', { method: 'DELETE', headers: mcpHeaders(access.access_token) })).status, 204);
  await revokedStream.closed();
});

test('shared capacity reports a bounded retry and preserves existing participants', { timeout: 50000 }, async () => {
  const grants = [await selfService(), await selfService(), await selfService()];
  const connections = [];
  const handles = [];
  let id = 1;
  const call = async (headers, name, args) => {
    const response = await request('/mcp', { method: 'POST', headers, json: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } });
    assert.equal(response.status, 200);
    return response.body.result.structuredContent;
  };
  try {
    for (let index = 0; index < grants.length; index++) {
      if (index < 2) await waitForAllocation();
      const headers = mcpHeaders(grants[index].access_token);
      connections.push(headers);
      const result = await call(headers, 'session_create', {});
      if (index < 2) {
        assert.equal(result.ok, true);
        handles.push(result.data.session);
      }
      else {
        assert.equal(result.error.code, 'SESSION_CAPACITY');
        assert.equal(result.error.retryable, true);
        assert(Number.isInteger(result.error.retryAfterSeconds) && result.error.retryAfterSeconds > 0 && result.error.retryAfterSeconds <= 30);
        assert.deepEqual((await call(headers, 'session_list', {})).data, []);
      }
    }
    assert.equal((await request('/preflight')).body.quota.activeSessions, 2);
    for (const [index, headers] of connections.slice(0, 2).entries()) assert.equal((await call(headers, 'session_observe', { session: handles[index] })).ok, true);
  } finally {
    for (const grant of grants) await request('/mcp/access', { method: 'DELETE', headers: mcpHeaders(grant.access_token) });
  }
  assert.equal((await request('/preflight')).body.quota.activeSessions, 0);
});

test('active requests cannot extend absolute participant lifetime or resurrect an expired identity', { timeout: 65000 }, async () => {
  const key = await issue('absolute-expiry');
  await waitForAllocation();
  const started = Date.now();
  const headers = mcpHeaders(key.key);
  const created = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_create', arguments: {} } }, headers });
  assert.equal(created.status, 200);
  assert.equal(created.body.result.structuredContent.ok, true);
  const handle = created.body.result.structuredContent.data.session;
  let successfulPings = 0;
  while (Date.now() - started < 45000) {
    await delay(5000);
    const ping = await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_observe', arguments: { session: handle } } }, headers });
    if (ping.status === 404) {
      assert(successfulPings >= 2, 'The identity must actually remain usable before expiring.');
      assert.equal(ping.body.error.data.identityRestorable, false);
      assert.equal((await request('/preflight')).body.quota.activeSessions, 0);
      assert.equal((await request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'session_create', arguments: {} } }, headers })).status, 404);
      return;
    }
    assert.equal(ping.status, 200);
    successfulPings++;
  }
  assert.fail('Ongoing requests extended the session past its absolute deadline.');
});

test('real Worker restart cannot restore memory-only participant identities and refunds quota', { timeout: 60000 }, async () => {
  const grant = await selfService();
  const headers = mcpHeaders(grant.access_token);
  await waitForAllocation();
  const created = await request('/mcp', { method: 'POST', headers, json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_create', arguments: {} } } });
  assert.equal(created.status, 200);
  const handle = created.body.result.structuredContent.data.session;
  assert.equal((await request('/preflight')).body.quota.activeSessions, 1);
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  await launchWorker();
  const lost = await request('/mcp', { method: 'POST', headers, json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_observe', arguments: { session: handle } } } });
  assert.equal(lost.status, 404);
  assert.equal(lost.body.error.data.identityRestorable, false);
  const retry = await request('/mcp', { method: 'POST', headers, json: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_create', arguments: {} } } });
  assert.equal(retry.status, 404, 'A restored owner actor cannot recreate discarded crypto identities.');
  assert.equal((await request('/preflight')).body.quota.activeSessions, 0);
  await request('/mcp/access', { method: 'DELETE', headers });
});

test('idle expiry closes POST subscriptions and refunds the last participant lease', { timeout: 60000 }, async () => {
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  await launchWorker({ IDLE_TIMEOUT_SECONDS: '10', MAX_SESSION_SECONDS: '60' });
  const grant = await selfService();
  const headers = mcpHeaders(grant.access_token);
  await waitForAllocation();
  const created = await request('/mcp', { method: 'POST', headers, json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_create', arguments: {} } } });
  assert.equal(created.status, 200);
  const handle = created.body.result.structuredContent.data.session;
  const stream = listen(grant.access_token, 'idle-expiry', { resourceSubscriptions: [`pillowfort://sessions/${handle}/mentions`] });
  await stream.next(message => message.method === 'notifications/subscriptions/acknowledged');
  await delay(11_000);
  await stream.closed();
  const lost = await request('/mcp', { method: 'POST', headers, json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_observe', arguments: { session: handle } } } });
  assert.equal(lost.status, 404);
  assert.equal(lost.body.error.data.identityRestorable, false);
  assert.equal((await request('/preflight')).body.quota.activeSessions, 0);
  await request('/mcp/access', { method: 'DELETE', headers });
});

test('real browser consent preserves Origin and completes the registered OAuth callback', { timeout: 30000 }, async () => {
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
    const unapproved = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/authorize' && response.request().method() === 'POST'),
      page.click('button[value="allow"]'),
    ]);
    assert.equal(unapproved[0].status(), 403, 'OAuth must not issue access without explicit managed-custody consent.');
    assert.equal(code, undefined);
    await page.goto(url.href);
    const consent = await page.locator('input[name="consent"]').inputValue();
    const cookie = (await page.context().cookies()).find(value => value.name === '__Host-pillowfort-consent');
    assert(cookie);
    const form = { consent, approve: 'yes', decision: 'allow' };
    const cookieHeader = `${cookie.name}=${cookie.value}`;
    assert.equal((await request('/authorize', { method: 'POST', form, headers: { Origin: 'https://untrusted.example', Cookie: cookieHeader } })).status, 403);
    await page.check('input[name="approve"]');
    await page.click('button[value="allow"]');
    await page.waitForURL(target => target.origin === callbackOrigin, { timeout: 5000 });
    assert(code);
    assert.equal((await request('/authorize', { method: 'POST', form, headers: { Origin: origin, Cookie: cookieHeader } })).status, 403, 'Consumed consent must not be replayable.');
    const exchanged = await request('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code, code_verifier: verifier, resource: origin + '/mcp' } });
    assert.equal(exchanged.status, 200);
    const session = await request('/mcp', { method: 'POST', json: discovery, headers: mcpHeaders(exchanged.body.access_token) });
    assert.equal(session.status, 200);
    assert.equal((await request('/mcp/access', { method: 'DELETE', headers: mcpHeaders(exchanged.body.access_token) })).status, 204);
    assert.equal((await request('/mcp', { method: 'POST', json: discovery, headers: mcpHeaders(exchanged.body.access_token) })).status, 401);
    const refreshed = await request('/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', client_id: clientId, refresh_token: exchanged.body.refresh_token, resource: origin + '/mcp' } });
    assert([400, 401].includes(refreshed.status), 'Revoked OAuth access must not be refreshed.');
  } finally {
    await browser.close();
    if (callbackServer) await new Promise(resolve => { callbackServer.close(resolve); callbackServer.closeAllConnections(); });
  }
});

test('self-service issuance stays bounded while existing grants remain usable', async () => {
  const tokens = [];
  const headers = { 'CF-Connecting-IP': '192.0.2.249' };
  try {
    for (let index = 0; index < 10; index++) {
      const response = await request('/access', { method: 'POST', json: { acceptManagedCustody: true }, headers });
      assert.equal(response.status, 201);
      tokens.push(response.body.access_token);
    }
    const limited = await request('/access', { method: 'POST', json: { acceptManagedCustody: true }, headers });
    assert.equal(limited.status, 429);
    assert(Number(limited.headers['retry-after']) > 0);
    const session = await request('/mcp', { method: 'POST', json: discovery, headers: { ...headers, ...mcpHeaders(tokens[0]) } });
    assert.equal(session.status, 200, 'Issuance throttling must not revoke an existing credential.');
  } finally {
    for (const token of tokens) await request('/mcp/access', { method: 'DELETE', headers: { ...headers, ...mcpHeaders(token) } });
  }
});
