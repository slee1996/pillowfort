import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { createAgentToolRegistry } from '../../scripts/agent-tools.mjs';
import { readByteLimitedText } from '../../src/requestBody';
import { hasBoundedMcpStructure, MAX_MCP_REQUEST_BYTES } from './requestLimits';
import catalog from '../../docs/agents/tools.json';
import collaboration from '../../docs/agents/collaboration.json';

/** Public discovery is stateless and never allocates a participant or session actor. */
export async function discover(request: Request<unknown, IncomingRequestCfProperties>): Promise<Response | null> {
  const result = await readByteLimitedText(request, MAX_MCP_REQUEST_BYTES);
  if (!result.ok) return Response.json({ error: 'Invalid or oversized MCP request body.' }, { status: result.reason === 'body_too_large' ? 413 : 400 });
  let message: unknown;
  try { message = JSON.parse(result.text); }
  catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }, { status: 400 }); }
  if (!hasBoundedMcpStructure(message)) return Response.json({ error: 'MCP request exceeds its structural limits.' }, { status: 413 });
  // Everything outside this exact allowlist must pass through OAuth, including batches.
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || !('method' in message) || typeof message.method !== 'string'
    || !['initialize', 'tools/list', 'notifications/initialized'].includes(message.method)) return null;
  const toolset = request.headers.get('Pillowfort-Toolset') ?? 'collaboration';
  if (toolset !== 'collaboration' && toolset !== 'full') return Response.json({ error: 'Pillowfort-Toolset must be collaboration or full.' }, { status: 400 });
  const server = new Server({ name: 'pillowfort', version: catalog.release.version }, {
    capabilities: { tools: {} },
    instructions: 'Tool discovery is public. Authorize and initialize a new authenticated connection before calling tools. https://mcp.pillowfort.xyz/preflight',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const options = {
      roomTools: toolset === 'full' ? catalog.tools : catalog.tools.filter(tool => (collaboration.tools as Record<string, boolean>)[tool.name] === true),
      includeCMS: false, jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    };
    const registry = await createAgentToolRegistry(null, [], options);
    return { tools: [...registry.values()].map(tool => tool.definition) };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_MCP_REQUEST_BYTES });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: message });
  } finally { await server.close(); }
}
