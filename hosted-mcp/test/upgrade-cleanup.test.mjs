import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../', import.meta.url));

test('upgrading a historical allocation refunds its reservation and retires only its exact grant across routes', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pillowfort-upgrade-test-'));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
  }
  function request(path, { method = 'GET', body, headers = {}, timeout = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      // Only this fixture's self-signed loopback Worker bypasses TLS validation.
      const outgoing = httpsRequest(origin + path, {
        method, rejectUnauthorized: false, headers: { Connection: 'close', ...headers },
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: response.statusCode, body: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text });
          } catch (error) { reject(error); }
        });
      });
      outgoing.on('error', reject);
      outgoing.setTimeout(timeout, () => outgoing.destroy(new Error('Fixture request timed out.')));
      outgoing.end(body);
    });
  }
  try {
    // Test-only RPC methods seed the historical metadata shape; actual production
    // constructors, alarm cleanup and quota accounting run inside workerd/SQLite.
    const entry = join(directory, 'worker.mjs');
    await writeFile(entry, `
import worker, { HostedMcpSession as ParticipantHost, AccessKeyStore, ParticipantQuota } from ${JSON.stringify(join(project, 'src/index.ts'))};
export { AccessKeyStore, ParticipantQuota };
export class HostedMcpSession extends ParticipantHost {
  async seedLegacy(record) { await this.ctx.storage.put('session', record); }
  async retireAndInspect() {
    await this.alarm();
    return { legacy: await this.ctx.storage.get('session'), principal: await this.ctx.storage.get('principal') };
  }
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return new Response('ready');
    const quota = env.MCP_QUOTAS.get(env.MCP_QUOTAS.idFromName('global'));
    const keys = env.MCP_ACCESS_KEYS.get(env.MCP_ACCESS_KEYS.idFromName('global'));
    if (path === '/seed' && request.method === 'POST') {
      const initial = await quota.status();
      const grant = await keys.issueSelfService();
      const freshGrant = await keys.issueSelfService();
      const principalId = grant.id;
      const sessionId = crypto.randomUUID();
      const actor = env.MCP_SESSIONS.get(env.MCP_SESSIONS.idFromName(principalId + ':' + sessionId));
      const leaseId = crypto.randomUUID();
      const startedAt = Date.now();
      const lease = await quota.acquire(leaseId, principalId, 600000);
      if (!lease.ok) return Response.json(lease, { status: 503 });
      await actor.seedLegacy({ principalId, sessionId, toolset: 'collaboration', status: 'active', expiresAt: lease.expiresAt, idleAt: lease.expiresAt, leaseId, leaseExpiresAt: lease.expiresAt });
      return Response.json({ initial, reserved: await quota.status(), startedAt, principalId, sessionId, grant, freshGrant, validatedPrincipalId: await keys.validate(grant.key) });
    }
    if (path === '/retire' && request.method === 'POST') {
      const { principalId, sessionId } = await request.json();
      const actor = env.MCP_SESSIONS.get(env.MCP_SESSIONS.idFromName(principalId + ':' + sessionId));
      const stored = await actor.retireAndInspect();
      return Response.json({ stored, quota: await quota.status() });
    }
    return worker.fetch(request, env, ctx);
  }
};
`);
    const config = JSON.parse(await readFile(join(project, 'wrangler.jsonc'), 'utf8'));
    config.name = 'pillowfort-upgrade-test';
    config.main = entry;
    delete config.routes;
    config.vars = { ...config.vars, OTEL_ENABLED: 'false', PUBLIC_MCP_URL: origin + '/mcp', CONSENT_SECRET: 'upgrade-regression-secret-at-least-32-characters', MAX_ACTIVE_SESSIONS: '2', MAX_DAILY_SESSION_MINUTES: '60', MAX_SESSION_SECONDS: '600' };
    const configPath = join(directory, 'wrangler.json');
    await writeFile(configPath, JSON.stringify(config));
    async function launch() {
      child = spawn(process.execPath, [join(project, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', String(port), '--local-protocol', 'https', '--local-upstream', '127.0.0.1:' + port, '--upstream-protocol', 'https', '--persist-to', join(directory, 'state'), '--log-level', 'error'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
      let diagnostics = '';
      const capture = chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const deadline = Date.now() + 20000;
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture Worker exited: ' + diagnostics);
        try {
          const response = await request('/health', { timeout: 1000 });
          if (response.status === 200) return;
        } catch {}
        assert(Date.now() < deadline, 'Fixture startup timed out: ' + diagnostics);
        await delay(50);
      }
    }
    async function post(path, body) {
      const response = await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    }
    async function call(grant, name, args = {}) {
      return request('/mcp', {
        method: 'POST',
        headers: {
          Connection: 'close', 'Content-Type': 'application/json', Accept: 'application/json',
          Authorization: 'Bearer ' + grant.key, 'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'tools/call', 'Mcp-Name': name,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name, arguments: args, _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'upgrade-regression', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        } }),
      });
    }
    await launch();
    const seeded = await post('/seed');
    assert.equal(seeded.validatedPrincipalId, seeded.principalId, 'The fixture must seed a real, cryptographically valid grant.');
    assert.equal(seeded.reserved.activeSessions, 1);
    assert.equal(seeded.reserved.remainingDailySessionSeconds, seeded.initial.remainingDailySessionSeconds - 600);
    await stop();
    await launch();
    const retired = await post('/retire', seeded);
    assert.equal(retired.quota.activeSessions, 0, 'A retired legacy allocation must release its quota slot.');
    const elapsedSeconds = Math.ceil((Date.now() - seeded.startedAt) / 1000);
    assert(retired.quota.remainingDailySessionSeconds >= seeded.initial.remainingDailySessionSeconds - elapsedSeconds - 1, 'Unused reservation time must be refunded, not charged as a full legacy lifetime.');
    assert.equal(retired.stored.legacy, undefined);
    assert.equal(retired.stored.principal.status, 'closed');
    assert.equal(retired.stored.principal.principalId, seeded.principalId);
    assert.equal(retired.stored.principal.leaseId, undefined);
    assert.equal(retired.stored.principal.sessionId, undefined);
    const repeated = await post('/retire', seeded);
    assert.equal(repeated.quota.activeSessions, 0);
    assert.equal(repeated.quota.remainingDailySessionSeconds, retired.quota.remainingDailySessionSeconds, 'Retirement must not refund a reservation twice.');
    // Honor the unchanged global start spacing so a replacement would really
    // allocate, rather than accidentally testing a temporary quota denial.
    await delay(Math.max(0, seeded.startedAt + 20_100 - Date.now()));
    const replacement = await call(seeded.grant, 'session_create');
    if (replacement.status !== 401) {
      assert.equal(replacement.body.result?.structuredContent?.ok, true, 'Unexpected fixture response: ' + JSON.stringify(replacement));
    }
    assert.equal(replacement.status, 401, 'The old grant must not mint replacement identities through the principal route: ' + JSON.stringify(replacement));
    const fresh = await call(seeded.freshGrant, 'session_create');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.result.structuredContent.ok, true, 'Retiring one exact grant must not revoke distinct grants.');
    const handle = fresh.body.result.structuredContent.data.session;
    assert.match(handle, /^[0-9a-f-]{36}$/);
    assert.equal((await call(seeded.freshGrant, 'session_close', { session: handle, confirm: true })).body.result.structuredContent.ok, true);
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
