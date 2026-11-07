import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AgentError, boundedJSON, errorResult, MAX_INPUT_BYTES, MAX_WAIT_MS } from './agent-common.mjs';
import { createAgentToolRegistry } from './agent-tools.mjs';
import { AGENT_INSTRUCTIONS, AGENT_RESOURCES, listAgentPrompts, readAgentResource, getAgentPrompt } from './agent-guidance.mjs';

/** @typedef {import('@modelcontextprotocol/sdk/server/index.js').Server} PillowfortMcpServer */

const MENTION_URI = /^pillowfort:\/\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/mentions$/;
const MENTION_TEMPLATE = {
  uriTemplate: 'pillowfort://sessions/{session}/mentions', name: 'session-mentions',
  title: 'Live participant mentions', mimeType: 'application/json',
  description: 'Bounded own-mention chat for a named participant in this connection. Ephemeral and live-only, not an offline inbox. Subscribe using MCP 2025 resources/subscribe; updates contain only the URI. Session and connection expiry end subscriptions.',
};

function mentionSession(uri) {
  const match = MENTION_URI.exec(uri);
  if (!match || match[0] !== uri) throw new McpError(ErrorCode.InvalidParams, 'Expected pillowfort://sessions/{session}/mentions with an exact named participant session.');
  return match[1];
}

function unavailableSession() {
  return new McpError(ErrorCode.InvalidParams, 'The named participant session is unavailable. Call session_list or create a named session first.');
}

/** Dynamic JSON Schema catalogs require the SDK's lower-level Server API. */
export function createAgentMcpServer({
  agent, tools = [], instructions = AGENT_INSTRUCTIONS, resources = AGENT_RESOURCES,
  resourceLoader = readAgentResource, roomTools, includeCMS = true, maxActiveCalls = 64, jsonSchemaValidator, onToolError, onClose,
}) {
  const server = new Server({ name: 'pillowfort', version: '1.1.6' }, {
    capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
    instructions,
    jsonSchemaValidator,
  });
  let closed = false;
  const subscriptions = new Map();
  const active = subscription => !closed && subscriptions.get(subscription.uri) === subscription && !subscription.abort.signal.aborted && !subscription.sessionSignal.aborted;
  const stop = subscription => {
    if (subscriptions.get(subscription.uri) === subscription) subscriptions.delete(subscription.uri);
    subscription.sessionSignal.removeEventListener('abort', subscription.onSessionClosed);
    subscription.abort.abort();
  };
  server.onclose = () => {
    if (closed) return;
    closed = true;
    for (const subscription of subscriptions.values()) stop(subscription);
    onClose?.();
  };
  const observeSession = async (name, signal) => {
    let snapshot;
    try { snapshot = await agent.observe(name); }
    catch { throw unavailableSession(); }
    if (closed || signal.aborted) throw unavailableSession();
    return snapshot;
  };
  const sessionSignal = name => {
    if (closed) throw unavailableSession();
    try { return agent.sessionSignal(name); }
    catch { throw unavailableSession(); }
  };
  const watch = async (subscription, snapshot) => {
    let revision = snapshot.revision;
    let cursor = snapshot.mentions.latestMessageId;
    try {
      while (active(subscription)) {
        snapshot = await agent.wait(subscription.name, revision, MAX_WAIT_MS, { signal: subscription.abort.signal });
        if (!active(subscription)) return;
        revision = snapshot.revision;
        const latest = snapshot.mentions.latestMessageId;
        if (latest > cursor) {
          cursor = latest;
          await server.sendResourceUpdated({ uri: subscription.uri });
        }
      }
    } catch {
      // Closed, stale, or failed participant waits terminate this live subscription.
      // Never attach a replacement participant with the same name implicitly.
    } finally { stop(subscription); }
  };
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [MENTION_TEMPLATE] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const uri = request.params.uri;
    if (!uri.startsWith('pillowfort://sessions/')) return { contents: [await resourceLoader(uri)] };
    const name = mentionSession(uri);
    const snapshot = await observeSession(name, sessionSignal(name));
    return { contents: [{ uri, mimeType: 'application/json', text: boundedJSON({ session: name, revision: snapshot.revision, ...snapshot.mentions, ephemeral: true }, 32 * 1024) }] };
  });
  server.setRequestHandler(SubscribeRequestSchema, async request => {
    const uri = request.params.uri;
    const name = mentionSession(uri);
    let subscription = subscriptions.get(uri);
    if (!subscription) {
      const signal = sessionSignal(name);
      if (subscriptions.size >= 16) throw new McpError(ErrorCode.InvalidParams, 'At most 16 live mention resources may be subscribed per connection.');
      subscription = { uri, name, sessionSignal: signal, abort: new AbortController() };
      subscription.onSessionClosed = () => stop(subscription);
      subscriptions.set(uri, subscription);
      signal.addEventListener('abort', subscription.onSessionClosed, { once: true });
      subscription.ready = observeSession(name, signal).then(snapshot => {
        if (!active(subscription)) throw unavailableSession();
        subscription.done = watch(subscription, snapshot);
      }).catch(error => { stop(subscription); throw error; });
    }
    await subscription.ready;
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async request => {
    const uri = request.params.uri;
    mentionSession(uri);
    const subscription = subscriptions.get(uri);
    if (subscription) {
      stop(subscription);
      await subscription.ready.catch(() => {});
      await subscription.done;
    }
    return {};
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listAgentPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async request => getAgentPrompt(request.params.name, request.params.arguments, { resourceLoader, resourceDefinitions: resources }));
  let registryPromise;
  let activeCalls = 0;
  const registry = () => {
    if (!registryPromise) registryPromise = createAgentToolRegistry(agent, tools, { roomTools, includeCMS, jsonSchemaValidator }).catch(error => { registryPromise = undefined; throw error; });
    return registryPromise;
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return { tools: [...(await registry()).values()].map(tool => tool.definition) }; }
    catch (error) {
      const failure = errorResult(error).error;
      throw new McpError(ErrorCode.InternalError, `${failure.code}: ${failure.message}`, { retryable: failure.retryable });
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (activeCalls >= maxActiveCalls) return toolResult(errorResult(new AgentError('BUSY', 'Too many pending tool calls. Wait for existing calls to finish.', true)));
    activeCalls++;
    try {
      let tool;
      try { tool = (await registry()).get(request.params.name); }
      catch (error) { return toolResult(errorResult(error)); }
      if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool. Call tools/list to discover available tools.');
      const result = await tool.invoke(request.params.arguments ?? {});
      if (result.ok === false) onToolError?.(result.error);
      return toolResult(result);
    } finally { activeCalls--; }
  });
  return server;
}

function toolResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false };
}

/** Owns stdio and signal handlers until EOF/close. Never writes diagnostics to stdout. */
export async function runAgentMcp({ agent, tools = [], input = process.stdin, output = process.stdout, diagnostics = process.stderr }) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createAgentMcpServer({ agent, tools, onClose: () => onEnd() });
  const transport = new StdioServerTransport(input, output, { maxBufferSize: MAX_INPUT_BYTES + 16 * 1024 });
  let closing;
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const close = () => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        input.off('end', onEnd);
        input.off('close', onEnd);
        input.off('error', onIOError);
        output.off('error', onIOError);
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
        process.off('uncaughtException', onFatal);
        process.off('unhandledRejection', onFatal);
        await server.close().catch(() => {});
        await agent.close();
      }).finally(finish);
    }
    return closing;
  };
  const onEnd = () => { void close(); };
  const onIOError = () => { process.exitCode = 1; void close(); };
  const onInterrupt = () => { process.exitCode = 130; void close(); };
  const onTerminate = () => { process.exitCode = 143; void close(); };
  const onFatal = () => {
    diagnostics.write('Pillowfort MCP stopped after an internal error. Sessions are being closed.\n');
    process.exitCode = 1;
    void close();
  };
  server.onerror = () => {
    diagnostics.write('Pillowfort MCP transport error: check JSON-RPC framing and message size.\n');
    process.exitCode = 1;
    void close();
  };
  input.once('end', onEnd);
  input.once('close', onEnd);
  input.once('error', onIOError);
  output.once('error', onIOError);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  process.once('uncaughtException', onFatal);
  process.once('unhandledRejection', onFatal);
  try {
    await server.connect(transport);
    if (input.readableEnded || input.destroyed) await close();
    await finished;
  } finally { await close(); }
}
