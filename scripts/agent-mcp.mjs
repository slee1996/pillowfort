import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AgentError, errorResult, MAX_INPUT_BYTES } from './agent-sdk.mjs';
import { createAgentToolRegistry } from './agent-tools.mjs';
import { AGENT_INSTRUCTIONS, AGENT_RESOURCES, listAgentPrompts, readAgentResource, getAgentPrompt } from './agent-guidance.mjs';

/** Dynamic JSON Schema catalogs require the SDK's lower-level Server API. */
export function createAgentMcpServer({ agent, tools = [] }) {
  const server = new Server({ name: 'pillowfort', version: '1.0.1' }, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: AGENT_INSTRUCTIONS,
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: AGENT_RESOURCES }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [await readAgentResource(request.params.uri)] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listAgentPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async request => getAgentPrompt(request.params.name, request.params.arguments));
  let registryPromise;
  let activeCalls = 0;
  const registry = () => {
    if (!registryPromise) registryPromise = createAgentToolRegistry(agent, tools).catch(error => { registryPromise = undefined; throw error; });
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
    if (activeCalls >= 64) return toolResult(errorResult(new AgentError('BUSY', 'Too many pending tool calls. Wait for existing calls to finish.', true)));
    activeCalls++;
    try {
      let tool;
      try { tool = (await registry()).get(request.params.name); }
      catch (error) { return toolResult(errorResult(error)); }
      if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool. Call tools/list to discover available tools.');
      return toolResult(await tool.invoke(request.params.arguments ?? {}));
    } finally { activeCalls--; }
  });
  return server;
}

function toolResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false };
}

/** Owns stdio and signal handlers until EOF/close. Never writes diagnostics to stdout. */
export async function runAgentMcp({ agent, tools = [], input = process.stdin, output = process.stdout, diagnostics = process.stderr }) {
  const server = createAgentMcpServer({ agent, tools });
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
  server.onclose = onEnd;
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
