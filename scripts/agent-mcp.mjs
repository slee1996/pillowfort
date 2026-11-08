import { Server, createMcpHandler, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { AgentError, boundedJSON, errorResult, MAX_INPUT_BYTES, MAX_WAIT_MS } from './agent-common.mjs';
import { createAgentToolRegistry, getAgentParticipantScope } from './agent-tools.mjs';
import { AGENT_INSTRUCTIONS, AGENT_RESOURCES, listAgentPrompts, readAgentResource, getAgentPrompt } from './agent-guidance.mjs';

/** @typedef {import('@modelcontextprotocol/server').Server} PillowfortMcpServer */

const PROTOCOL_VERSION = '2026-07-28';
const MAX_WIRE_BYTES = MAX_INPUT_BYTES + 16 * 1024;
const MENTION_URI = /^pillowfort:\/\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/mentions$/;
const MENTION_TEMPLATE = {
  uriTemplate: 'pillowfort://sessions/{session}/mentions', name: 'session-mentions',
  title: 'Live participant mentions', mimeType: 'application/json',
  description: 'Bounded own-mention chat for an owner-bound opaque participant handle. Ephemeral and live-only, not an offline inbox. Opt in with subscriptions/listen resourceSubscriptions; updates contain only the URI. Participant closure or expiry ends live delivery.',
};
const PUBLIC_CACHE = { ttlMs: 60_000, cacheScope: 'public' };
const PRIVATE_CACHE = { ttlMs: 0, cacheScope: 'private' };

function unavailableParticipant() {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, 'This participant handle is unavailable. Use session_list or session_create.');
}

function mentionParticipant(scope, uri) {
  const match = typeof uri === 'string' && MENTION_URI.exec(uri);
  if (!match || match[0] !== uri) throw unavailableParticipant();
  try { return scope.require(match[1]); }
  catch { throw unavailableParticipant(); }
}

/** Participant watchers belong to the owner, never to an HTTP exchange or listen stream. */
function createOwnerState(options, notify) {
  const { agent } = options;
  const participants = getAgentParticipantScope(agent);
  const watchers = new Map();
  let closed = false;
  let registryPromise;
  const state = {
    participants, activeCalls: 0,
    registry() {
      registryPromise ??= createAgentToolRegistry(agent, options.tools ?? [], options).catch(error => {
        registryPromise = undefined;
        throw error;
      });
      return registryPromise;
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      const pending = [...watchers.values()];
      for (const watcher of pending) stop(watcher);
      await Promise.allSettled(pending.map(watcher => watcher.done));
    },
  };
  const active = watcher => !closed && watchers.get(watcher.session) === watcher && !watcher.abort.signal.aborted && !watcher.signal.aborted;
  const stop = watcher => {
    if (watchers.get(watcher.session) === watcher) watchers.delete(watcher.session);
    watcher.signal.removeEventListener('abort', watcher.onClosed);
    watcher.abort.abort();
  };
  const start = participant => {
    if (closed || participant.signal.aborted) return Promise.resolve();
    const existing = watchers.get(participant.session);
    if (existing) return existing.ready;
    const watcher = { session: participant.session, signal: participant.signal, abort: new AbortController() };
    watcher.onClosed = () => stop(watcher);
    watchers.set(watcher.session, watcher);
    watcher.signal.addEventListener('abort', watcher.onClosed, { once: true });
    watcher.ready = agent.observe(watcher.session).then(snapshot => {
      if (!active(watcher)) throw unavailableParticipant();
      watcher.done = (async () => {
        let revision = snapshot.revision;
        let cursor = snapshot.mentions.latestMessageId;
        try {
          while (active(watcher)) {
            snapshot = await agent.wait(watcher.session, revision, MAX_WAIT_MS, { signal: watcher.abort.signal });
            if (!active(watcher)) return;
            revision = snapshot.revision;
            if (snapshot.mentions.latestMessageId > cursor) {
              cursor = snapshot.mentions.latestMessageId;
              await notify(`pillowfort://sessions/${watcher.session}/mentions`);
            }
          }
        } catch {
          // Closure, expiry and stale waits end delivery; never adopt a replacement identity.
        } finally { stop(watcher); }
      })();
    }).catch(error => { stop(watcher); throw error; });
    return watcher.ready;
  };
  const unsubscribe = participants.subscribe(start);
  return state;
}

/** Dynamic JSON Schema catalogs use the SDK's low-level modern Server API. */
export function createAgentMcpServer(options, ownerState) {
  const {
    agent, instructions = AGENT_INSTRUCTIONS, resources = AGENT_RESOURCES,
    resourceLoader = readAgentResource, maxActiveCalls = 64, jsonSchemaValidator,
    onToolError, observeToolCall, onClose,
  } = options;
  const server = new Server({ name: 'pillowfort', version: '2.0.1' }, {
    supportedProtocolVersions: [PROTOCOL_VERSION],
    capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
    instructions, jsonSchemaValidator,
    cacheHints: {
      'server/discover': PUBLIC_CACHE, 'tools/list': PUBLIC_CACHE, 'resources/list': PUBLIC_CACHE,
      'resources/templates/list': PUBLIC_CACHE, 'prompts/list': PUBLIC_CACHE, 'resources/read': PRIVATE_CACHE,
    },
  });
  const state = ownerState ?? createOwnerState(options, uri => server.sendResourceUpdated({ uri }));
  let closed = false;
  server.onclose = () => {
    if (closed) return;
    closed = true;
    if (!ownerState) void state.close();
    onClose?.();
  };
  server.setRequestHandler('resources/list', async () => ({ resources, ...PUBLIC_CACHE }));
  server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [MENTION_TEMPLATE], ...PUBLIC_CACHE }));
  server.setRequestHandler('resources/read', async request => {
    const uri = request.params.uri;
    if (!uri.startsWith('pillowfort://sessions/')) return { contents: [await resourceLoader(uri)], ...PUBLIC_CACHE };
    const participant = mentionParticipant(state.participants, uri);
    let snapshot;
    try { snapshot = await agent.observe(participant.session); }
    catch { throw unavailableParticipant(); }
    // Recheck after the async read to reject closure/recreation during observation.
    if (mentionParticipant(state.participants, uri) !== participant) throw unavailableParticipant();
    return {
      contents: [{ uri, mimeType: 'application/json', text: boundedJSON({ session: participant.session, revision: snapshot.revision, ...snapshot.mentions, ephemeral: true }, 32 * 1024) }],
      ...PRIVATE_CACHE,
    };
  });
  server.setRequestHandler('prompts/list', async () => ({ prompts: listAgentPrompts(), ...PUBLIC_CACHE }));
  server.setRequestHandler('prompts/get', async request => getAgentPrompt(request.params.name, request.params.arguments, { resourceLoader, resourceDefinitions: resources }));
  server.setRequestHandler('tools/list', async () => {
    try { return { tools: [...(await state.registry()).values()].map(tool => tool.definition), ...PUBLIC_CACHE }; }
    catch (error) {
      const failure = errorResult(error).error;
      throw new ProtocolError(ProtocolErrorCode.InternalError, `${failure.code}: ${failure.message}`, { retryable: failure.retryable });
    }
  });
  server.setRequestHandler('tools/call', async (request, context) => {
    const invoke = async () => {
      if (state.activeCalls >= maxActiveCalls) return errorResult(new AgentError('BUSY', 'Too many pending tool calls. Wait for existing calls to finish.', true));
      state.activeCalls++;
      try {
        let tool;
        try { tool = (await state.registry()).get(request.params.name); }
        catch (error) { return errorResult(error); }
        if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool. Call tools/list to discover available tools.');
        const result = await tool.invoke(request.params.arguments ?? {}, { signal: context.mcpReq.signal });
        if (result.ok === false) onToolError?.(result.error);
        return result;
      } finally { state.activeCalls--; }
    };
    const result = await (observeToolCall ? observeToolCall(request.params.name, invoke) : invoke());
    return server.projectCallToolResult({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false });
  });
  return server;
}

function authorizeListen(state, message, resources) {
  if (message?.method !== 'subscriptions/listen') return;
  const meta = message.params?._meta;
  if (meta?.['io.modelcontextprotocol/protocolVersion'] !== PROTOCOL_VERSION
      || !meta['io.modelcontextprotocol/clientCapabilities']
      || typeof meta['io.modelcontextprotocol/clientCapabilities'] !== 'object'
      || Array.isArray(meta['io.modelcontextprotocol/clientCapabilities'])) return;
  const uris = message.params?.notifications?.resourceSubscriptions;
  // Shape and envelope validation remain the SDK's responsibility.
  if (!Array.isArray(uris) || !uris.every(uri => typeof uri === 'string')) return;
  for (const uri of uris) {
    if (uri.startsWith('pillowfort://sessions/')) mentionParticipant(state.participants, uri);
    else if (!resources.some(resource => resource.uri === uri)) throw unavailableParticipant();
  }
}

/** A stable owner-bound HTTP handler; per-request Server closure never owns participants. */
export function createAgentMcpHandler(options) {
  let handler;
  const state = createOwnerState(options, uri => handler.notify.resourceUpdated(uri));
  handler = createMcpHandler(() => createAgentMcpServer(options, state), {
    legacy: 'reject', maxSubscriptions: 16, maxRequestBodySize: MAX_WIRE_BYTES,
  });
  return {
    notify: handler.notify, bus: handler.bus,
    async fetch(request, requestOptions = {}) {
      let body = requestOptions.parsedBody;
      if (request.method === 'POST' && body === undefined && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
        const reader = request.body?.getReader();
        const decoder = new TextDecoder();
        let text = '';
        let bytes = 0;
        try {
          if (reader) while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_WIRE_BYTES) {
              void reader.cancel().catch(() => {});
              return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Request body is too large.' } }, { status: 413 });
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          body = JSON.parse(text + decoder.decode());
        } catch {
          return Response.json({ jsonrpc: '2.0', id: null, error: { code: ProtocolErrorCode.ParseError, message: 'Parse error: the request body is not valid JSON.' } }, { status: 400 });
        } finally { reader?.releaseLock(); }
      }
      const response = await handler.fetch(request, { ...requestOptions, ...(body !== undefined && { parsedBody: body }) });
      // Validate the protocol envelope/headers before applying participant policy.
      // The SDK stream is not exposed until its requested resources are authorized.
      if (body?.method === 'subscriptions/listen' && response.ok && response.headers.get('content-type')?.startsWith('text/event-stream')) {
        try { authorizeListen(state, body, options.resources ?? AGENT_RESOURCES); }
        catch (error) {
          await response.body?.cancel().catch(() => {});
          return Response.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: ProtocolErrorCode.InvalidParams, message: error.message } });
        }
      }
      return response;
    },
    async close() {
      await handler.close();
      await state.close();
    },
  };
}

/** Owns stdio and signal handlers until EOF/close. Never writes diagnostics to stdout. */
export async function runAgentMcp({ agent, tools = [], input = process.stdin, output = process.stdout, diagnostics = process.stderr, ...options }) {
  const { StdioServerTransport, serveStdio } = await import('@modelcontextprotocol/server/stdio');
  const transport = new StdioServerTransport(input, output, { maxBufferSize: MAX_WIRE_BYTES });
  let closing;
  const { promise: finished, resolve: finish } = Promise.withResolvers();
  const close = () => {
    closing ??= Promise.resolve().then(async () => {
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onIOError);
      output.off('error', onIOError);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      process.off('uncaughtException', onFatal);
      process.off('unhandledRejection', onFatal);
      await handle.close().catch(() => {});
      await agent.close();
    }).finally(finish);
    return closing;
  };
  const onEnd = () => { void close(); };
  const onIOError = () => { process.exitCode = 1; void close(); };
  const onInterrupt = () => { process.exitCode = 130; void close(); };
  const onTerminate = () => { process.exitCode = 143; void close(); };
  const onFatal = () => {
    diagnostics.write('Pillowfort MCP stopped after an internal error. Participants are being closed.\n');
    process.exitCode = 1;
    void close();
  };
  const handle = serveStdio(() => {
    return createAgentMcpServer({ ...options, agent, tools, onClose: () => { options.onClose?.(); onEnd(); } });
  }, { legacy: 'reject', transport, maxSubscriptions: 16, onerror: () => {
    diagnostics.write('Pillowfort MCP rejected a protocol message: check revision, JSON-RPC framing and message size.\n');
  } });
  const transportError = transport.onerror;
  transport.onerror = error => {
    transportError?.(error);
    onIOError();
  };
  const receive = transport.onmessage;
  transport.onmessage = message => {
    try { authorizeListen({ participants: getAgentParticipantScope(agent) }, message, options.resources ?? AGENT_RESOURCES); }
    catch (error) {
      void transport.send({ jsonrpc: '2.0', id: message.id, error: { code: ProtocolErrorCode.InvalidParams, message: error.message } }).catch(onIOError);
      return;
    }
    receive?.(message);
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
    if (input.readableEnded || input.destroyed) await close();
    await finished;
  } finally { await close(); }
}
