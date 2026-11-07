import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { PillowfortHostedAgent } from '../src/participant/hostedAgent';
import { createAgentMcpServer } from './agent-mcp.mjs';
import { AgentError, errorResult } from './agent-common.mjs';

const root = new URL('../', import.meta.url);
const args = process.argv.slice(2);
let hostedOnly = false;
let catalogURL = new URL('docs/agents/tools.json', root);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--runtime' && args[index + 1] === 'hosted') { hostedOnly = true; index++; }
  else if (args[index] === '--catalog' && args[index + 1]) catalogURL = new URL(args[++index], `file://${process.cwd()}/`);
  else throw new Error('Usage: bun scripts/check-agent-catalog.ts [--runtime hosted] [--catalog PATH]');
}
const manifest = JSON.parse(await readFile(new URL('agent-package.json', root), 'utf8'));
const distribution = JSON.parse(await readFile(new URL('server.json', root), 'utf8'));
const catalog = JSON.parse(await readFile(catalogURL, 'utf8'));
const policy = JSON.parse(await readFile(new URL('docs/agents/collaboration.json', root), 'utf8'));
const expected = new Map<string, Tool>();
let relay: ChildProcess | undefined;
const nativeAgent = new PillowfortHostedAgent({ baseURL: 'http://127.0.0.1', createWebSocket: url => new WebSocket(url) });

async function checkRuntime(runtime: 'browser' | 'hosted', app?: string) {
  const server = runtime === 'hosted' ? createAgentMcpServer({ agent: nativeAgent, includeCMS: false }) : undefined;
  const client = new Client({ name: 'pillowfort-release-gate', version: manifest.version });
  try {
    if (server) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    } else {
      if (!app) throw new Error('The browser catalog check requires its local app URL.');
      await client.connect(new StdioClientTransport({
        command: 'node',
        args: [fileURLToPath(new URL('scripts/agent.mjs', root)), 'mcp', '--url', app],
        stderr: 'pipe',
      }));
    }
    if (client.getServerVersion()?.version !== manifest.version) throw new AgentError('RELEASE_MISMATCH', `${runtime}: MCP version does not match agent-package.json.`);
    const { tools } = await client.listTools();
    const expectedNames = [...expected.keys()].filter(name => runtime === 'browser' || !name.startsWith('fort_pass_'));
    if (tools.length !== expectedNames.length || tools.some(tool => !expectedNames.includes(tool.name))) throw new AgentError('CATALOG_MISMATCH', `${runtime}: advertised and executable tool names differ. Rebuild the app and regenerate agent:catalog.`);
    for (const tool of tools) {
      if (!isDeepStrictEqual(tool, expected.get(tool.name))) throw new AgentError('CATALOG_MISMATCH', `${runtime}: ${tool.name} schema or metadata differs from the executable registry.`);
    }
    for (const name of Object.keys(policy.tools)) {
      if (!tools.some(tool => tool.name === name)) throw new AgentError('CATALOG_MISMATCH', `${runtime}: collaboration tool ${name} is not executable.`);
    }
    // Exercise observational tools through a real MCP client and real participant.
    // Stateful mutations are covered by the existing encrypted integration suites.
    const created = await client.callTool({ name: 'session_create', arguments: { session: 'catalog-check' } });
    if (created.isError) throw new AgentError('CATALOG_EXECUTION_FAILED', `${runtime}: participant creation failed.`);
    const observe = async () => {
      const result = await client.callTool({ name: 'session_observe', arguments: { session: 'catalog-check' } });
      const content = result.structuredContent as { ok?: boolean; data?: { revision: number; operations: unknown } } | undefined;
      if (result.isError || content?.ok !== true || !content.data) throw new AgentError('CATALOG_EXECUTION_FAILED', `${runtime}: participant observation failed.`);
      return content.data;
    };
    const before = await observe();
    for (const name of ['participant_preflight', 'chat_history_export', 'drawing_history_export', 'event_history_export']) {
      const result = await client.callTool({ name, arguments: { session: 'catalog-check', input: {} } });
      if (result.isError || result.structuredContent?.ok !== true) throw new AgentError('CATALOG_EXECUTION_FAILED', `${runtime}: ${name} did not execute.`);
      if (expected.get(name)?.annotations?.readOnlyHint !== true) throw new AgentError('CATALOG_MISMATCH', `${runtime}: ${name} lost read-only semantics.`);
    }
    const after = await observe();
    if (after.revision !== before.revision || !isDeepStrictEqual(after.operations, before.operations)) throw new AgentError('READ_ONLY_MUTATION', `${runtime}: observational tools changed participant state.`);
    const closed = await client.callTool({ name: 'session_close', arguments: { session: 'catalog-check', confirm: true } });
    if (closed.isError) throw new AgentError('CATALOG_EXECUTION_FAILED', `${runtime}: participant closure failed.`);
    return tools.length;
  } finally {
    await client.close();
    await server?.close();
  }
}

try {
  const npm = distribution.packages?.find((entry: { registryType: string }) => entry.registryType === 'npm');
  if (distribution.version !== manifest.version || npm?.version !== manifest.version || npm?.identifier !== manifest.name) throw new AgentError('RELEASE_MISMATCH', 'Package and MCP distribution versions differ.');
  if (!Array.isArray(catalog.tools) || catalog.release?.version !== manifest.version || catalog.release?.sourceTag !== `v${manifest.version}`) throw new AgentError('RELEASE_MISMATCH', 'Catalog release does not match the intended source tag and package.');
  const digest = createHash('sha256').update(JSON.stringify(catalog.tools)).digest('hex');
  if (catalog.release.toolsSha256 !== digest) throw new AgentError('CATALOG_MISMATCH', 'Catalog integrity does not match its tool definitions.');
  for (const tool of catalog.tools) {
    if (!tool || typeof tool.name !== 'string' || expected.has(tool.name)) throw new AgentError('CATALOG_MISMATCH', 'Catalog has invalid or duplicate tool names.');
    expected.set(tool.name, tool);
  }
  const hostedTools = await checkRuntime('hosted');
  let browserTools: number | undefined;
  if (!hostedOnly) {
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Could not reserve local app port.');
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    relay = spawn('bun', ['server.ts'], { cwd: fileURLToPath(root), env: { ...process.env, PORT: String(port), NODE_ENV: 'test', OTEL_ENABLED: 'false' }, stdio: 'ignore' });
    let startupError: Error | undefined;
    relay.once('error', error => { startupError = error; });
    const app = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    for (;;) {
      if (startupError || relay.exitCode !== null) throw new Error('The built local app could not start.');
      try { const response = await fetch(app, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.ok) break; } catch {}
      if (Date.now() >= deadline) throw new Error('The built local app did not become ready.');
      await delay(100);
    }
    browserTools = await checkRuntime('browser', app);
  }
  console.log(JSON.stringify({ ok: true, release: catalog.release, hostedTools, ...(browserTools === undefined ? {} : { browserTools }), roomActionsPerformed: false }));
} catch (error) {
  console.error(JSON.stringify(errorResult(error)));
  process.exitCode = 1;
} finally {
  await nativeAgent.close();
  const child = relay;
  if (child && child.exitCode === null && child.pid) {
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(deadline); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
