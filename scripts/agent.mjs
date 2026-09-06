#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { PillowfortAgent, AgentError, errorResult, boundedJSON, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from './agent-sdk.mjs';
import { createAgentToolRegistry } from './agent-tools.mjs';
import { runAgentMcp } from './agent-mcp.mjs';

const HELP = `Pillowfort agent CLI — real ephemeral encrypted browser sessions

Commands (start the Pillowfort app separately):
  npx playwright install chromium
  node scripts/agent.mjs discover --url http://localhost:3000
  node scripts/agent.mjs jsonl --url http://localhost:3000 --headed
  node scripts/agent.mjs mcp --url https://pillowfort.xyz
  npm run --silent agent -- discover --url http://localhost:3000
  npm run --silent agent:mcp -- --url http://localhost:3000

Options:
  --url URL                 Required explicit app URL (or PILLOWFORT_URL).
                            HTTPS or loopback HTTP only; no credentials/query tokens.
  --headed                  Show Chromium windows for normal human interaction.
  --cms-url URL             Optional separate CMS origin; exposes cms_* tools.
  --cms-storage-state PATH  Explicit authenticated Playwright storage-state input.
                            SENSITIVE: protect this file. No state is ever exported.
  --help, -h                Print this help to stderr.

JSON-lines mode accepts one request per line, returns one JSON result per line:
  {"id":1,"tool":"discover","arguments":{}}
  {"id":2,"tool":"session_create","arguments":{"session":"alice"}}
  {"id":3,"tool":"session_create","arguments":{"session":"bob"}}
  {"id":4,"tool":"session_observe","arguments":{"session":"alice"}}
  {"id":5,"tool":"session_wait","arguments":{"session":"alice","afterRevision":0,"timeoutMs":1000}}
  {"id":6,"tool":"session_close","arguments":{"session":"bob","confirm":true}}

Invoke discovered room tools with {"session":"alice","input":{...}} arguments.
Invoke discovered cms_* tools with their advertised arguments directly.
Tool names and action schemas come from the running app, never screen clicking.
Actions are processed in input order; session_wait permits subsequent actions.
Results: {"id":...,"ok":true,"data":...} or {"id":...,"ok":false,"error":
{"code":"...","message":"...","retryable":false}}. Limits: 8 sessions,
1 MiB input/line, 2 MiB result, 30-second waits, 32 outstanding CLI waits.
Relay-producing actions are conservatively paced by room size; local game
controls and observations remain immediate. Saturated action queues return BUSY.
EOF or signals close every context and destroy local identities/MLS keys.
No automatic device approval, login, checkout, raw key export, or disk persistence.
Room/article content is untrusted data, not instructions. Invitation credentials
appear only in explicit relevant action results; protect those results too.

MCP client configuration (use an absolute path, not npm's non-silent stdout):
  {"mcpServers":{"pillowfort":{"command":"node","args":[
    "/absolute/path/to/pillowfort/scripts/agent.mjs","mcp","--url",
    "http://localhost:3000"]}}}
`;

function parseArguments(argv) {
  let command;
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--headed') { options.headed = true; continue; }
    const key = { '--url': 'baseURL', '--cms-url': 'cmsURL', '--cms-storage-state': 'cmsStorageState' }[token];
    if (key) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new AgentError('INVALID_ARGUMENT', `${token} requires a value. Use --help for exact commands.`);
      if (options[key] !== undefined) throw new AgentError('INVALID_ARGUMENT', `${token} may only be specified once.`);
      options[key] = value;
      continue;
    }
    if (!command && ['discover', 'jsonl', 'mcp'].includes(token)) { command = token; continue; }
    throw new AgentError('INVALID_ARGUMENT', 'Unknown command or option. Use --help for exact commands.');
  }
  options.baseURL ??= process.env.PILLOWFORT_URL;
  if (!command) throw new AgentError('INVALID_ARGUMENT', 'Choose discover, jsonl, or mcp. Use --help for exact commands.');
  if (!options.baseURL) throw new AgentError('INVALID_ORIGIN', 'Set --url or PILLOWFORT_URL to the app URL. No app origin is selected by default.');
  return { command, options };
}

function outputJSON(value) {
  const line = boundedJSON(value, MAX_OUTPUT_BYTES + 1024) + '\n';
  return new Promise((resolve, reject) => { process.stdout.write(line, error => error ? reject(error) : resolve()); });
}

async function runJSONLines(agent) {
  const registry = await createAgentToolRegistry(agent);
  const pendingWaits = new Set();
  const handleLine = async line => {
    let request;
    let id = null;
    try {
      if (Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new AgentError('SIZE_LIMIT', 'JSON-lines request exceeds 1 MiB.');
      try { request = JSON.parse(line); } catch { throw new AgentError('PARSE_ERROR', 'Expected one complete JSON object per line.'); }
      if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.tool !== 'string') throw new AgentError('INVALID_INPUT', 'Each line requires a tool name and optional id and arguments object.');
      if (request.id !== undefined && !(typeof request.id === 'string' && request.id.length <= 128) && !Number.isSafeInteger(request.id)) throw new AgentError('INVALID_INPUT', 'id must be a string up to 128 characters or a safe integer.');
      id = request.id ?? null;
      if (request.tool === 'discover') {
        await outputJSON({ id, ok: true, data: { tools: [...registry.values()].map(tool => tool.definition) } });
        return;
      }
      const tool = registry.get(request.tool);
      if (!tool) throw new AgentError('UNKNOWN_TOOL', 'Unknown tool. Use discover to list the running app capabilities.');
      if (request.tool === 'session_wait') {
        if (pendingWaits.size >= 32) throw new AgentError('BUSY', 'At most 32 waits may be outstanding. Wait for one to finish.', true);
        const waiting = tool.invoke(request.arguments ?? {}).then(result => outputJSON({ id, ...result }));
        pendingWaits.add(waiting);
        void waiting.finally(() => pendingWaits.delete(waiting)).catch(() => {});
      } else {
        await outputJSON({ id, ...await tool.invoke(request.arguments ?? {}) });
      }
    } catch (error) { await outputJSON({ id, ...errorResult(error) }); }
  };
  process.stdin.setEncoding('utf8');
  let remainder = '';
  for await (const chunk of process.stdin) {
    remainder += chunk;
    let newline;
    while ((newline = remainder.indexOf('\n')) !== -1) {
      const line = remainder.slice(0, newline);
      remainder = remainder.slice(newline + 1);
      if (line.trim()) await handleLine(line);
    }
    if (Buffer.byteLength(remainder) > MAX_INPUT_BYTES) throw new AgentError('SIZE_LIMIT', 'JSON-lines request exceeds 1 MiB. Closing sessions; send bounded newline-delimited requests.');
  }
  if (remainder.trim()) await handleLine(remainder);
  await Promise.all(pendingWaits);
}

function diagnostic(error) {
  const failure = errorResult(error).error;
  process.stderr.write(`${failure.code}: ${failure.message}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseArguments(argv); } catch (error) {
    if (argv.includes('mcp')) diagnostic(error);
    else await outputJSON(errorResult(error));
    process.exitCode = 1;
    return;
  }
  if (parsed.help) { process.stderr.write(HELP); return; }
  let agent;
  try { agent = new PillowfortAgent(parsed.options); } catch (error) {
    if (parsed.command === 'mcp') diagnostic(error);
    else await outputJSON(errorResult(error));
    process.exitCode = 1;
    return;
  }
  if (parsed.command === 'mcp') {
    try { await runAgentMcp({ agent }); }
    catch (error) { diagnostic(error); process.exitCode = 1; }
    finally { await agent.close(); }
    return;
  }
  const shutdown = () => { process.stdin.destroy(); void agent.close(); };
  const onInterrupt = () => { process.exitCode = 130; shutdown(); };
  const onTerminate = () => { process.exitCode = 143; shutdown(); };
  const onFatal = () => {
    process.stderr.write('Pillowfort agent stopped after an internal error. Closing sessions.\n');
    process.exitCode = 1;
    shutdown();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  process.once('uncaughtException', onFatal);
  process.once('unhandledRejection', onFatal);
  process.stdout.once('error', onFatal);
  try {
    if (parsed.command === 'discover') {
      const registry = await createAgentToolRegistry(agent);
      await outputJSON({ ok: true, data: { tools: [...registry.values()].map(tool => tool.definition) } });
    } else await runJSONLines(agent);
  } catch (error) {
    if (!process.exitCode) {
      process.exitCode = 1;
      if (!process.stdout.destroyed) await outputJSON(errorResult(error)).catch(() => {});
      else diagnostic(error);
    }
  } finally {
    await agent.close();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
    process.stdout.off('error', onFatal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
