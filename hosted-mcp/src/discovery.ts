import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { createAgentToolRegistry } from '../../scripts/agent-tools.mjs';
import { readByteLimitedText } from '../../src/requestBody';
import { hasBoundedMcpStructure, MAX_MCP_REQUEST_BYTES } from './requestLimits';
import catalog from '../../docs/agents/tools.json';

const handler = createMcpHandler(async () => {
  const server = new Server({ name: 'pillowfort', version: catalog.release.version }, {
    supportedProtocolVersions: ['2026-07-28'],
    capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
    instructions: 'The complete non-payment tool catalog is public. Authorize before calling tools. session_create takes {} and returns an owner-bound participant handle. https://mcp.pillowfort.xyz/preflight',
  });
  server.setRequestHandler('tools/list', async () => {
    // Supplying the static catalog avoids capabilities() and any participant runtime.
    const registry = await createAgentToolRegistry(null, [], {
      roomTools: catalog.tools, includeCMS: false, jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    });
    return { tools: [...registry.values()].map(tool => tool.definition), ttlMs: 0, cacheScope: 'public' };
  });
  return server;
}, { legacy: 'reject', maxRequestBodySize: MAX_MCP_REQUEST_BYTES });

/** Exact public allowlist: no identity, crypto state, principal actor, or quota. */
export async function discover(request: Request): Promise<Response | null> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return Response.json({ error: 'Expected application/json.' }, { status: 415 });
  const result = await readByteLimitedText(request, MAX_MCP_REQUEST_BYTES);
  if (!result.ok) return Response.json({ error: 'Invalid or oversized MCP request body.' }, { status: result.reason === 'body_too_large' ? 413 : 400 });
  let message: unknown;
  try { message = JSON.parse(result.text); }
  catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }, { status: 400 }); }
  if (!hasBoundedMcpStructure(message)) return Response.json({ error: 'MCP request exceeds its structural limits.' }, { status: 413 });
  // Everything outside this allowlist must pass authentication, including batches.
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || !('method' in message) || !['server/discover', 'tools/list'].includes(String(message.method))) return null;
  return handler.fetch(request, { parsedBody: message });
}
