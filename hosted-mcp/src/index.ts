import { readByteLimitedText } from '../../src/requestBody';
import { createAuthorizedWorker, AccessKeyStore } from './auth';
import { HostedMcpSession } from './session';
import { ParticipantQuota } from './quota';
import type { AuthenticatedProps, Env } from './env';
import { withOperationalTelemetry } from '../../src/telemetry';
import { hasBoundedMcpStructure, MAX_MCP_REQUEST_BYTES } from './requestLimits';

export { AccessKeyStore, HostedMcpSession, ParticipantQuota };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function rpcError(status: number, message: string, code = -32600): Response {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status });
}

const apiHandler: ExportedHandler<Env, unknown, unknown, AuthenticatedProps> = {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const principalId = ctx.props.principalId;
    if (typeof principalId !== 'string' || !UUID.test(principalId)) return rpcError(401, 'Valid operator authorization is required.');
    if (!['POST', 'GET', 'DELETE'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, GET, DELETE' } });

    let sessionId = request.headers.get('MCP-Session-Id');
    if (sessionId !== null && !UUID.test(sessionId)) return rpcError(400, 'Invalid MCP session identifier.');
    let body: string | undefined;
    let message: unknown;
    if (request.method === 'POST') {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return rpcError(415, 'Expected application/json.');
      // Respond before cancelling a known-oversized upload: workerd can reset
      // the client connection if its request body is cancelled first.
      const declaredLength = request.headers.get('content-length');
      if (declaredLength && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)
        && BigInt(declaredLength) > BigInt(MAX_MCP_REQUEST_BYTES)) return rpcError(413, 'MCP request exceeds its byte limit.');
      const result = await readByteLimitedText(request, MAX_MCP_REQUEST_BYTES);
      if (!result.ok) return rpcError(result.reason === 'body_too_large' ? 413 : 400, 'Invalid or oversized MCP request body.');
      body = result.text;
      try { message = JSON.parse(body); } catch { return rpcError(400, 'Invalid JSON.', -32700); }
      if (!hasBoundedMcpStructure(message)) return rpcError(413, 'MCP request exceeds its structural limits.');
    }
    if (sessionId === null) {
      if (request.method === 'GET') return new Response('Initialize a session with POST first.', { status: 405, headers: { Allow: 'POST' } });
      if (request.method !== 'POST') return rpcError(400, 'Initialize an MCP session before using it.');
      if (!message || typeof message !== 'object' || Array.isArray(message) || !('method' in message) || message.method !== 'initialize') return rpcError(400, 'Initialize an MCP session before using it.');
      sessionId = crypto.randomUUID();
    }

    // Only protocol headers reach the session actor. Never forward credentials,
    // cookies, raw client IPs, or caller-supplied internal routing assertions.
    const headers = new Headers();
    for (const name of ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'origin']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('x-pillowfort-principal', principalId);
    headers.set('x-pillowfort-session-id', sessionId);
    const id = env.MCP_SESSIONS.idFromName(`${principalId}:${sessionId}`);
    try {
      return await env.MCP_SESSIONS.get(id).fetch(new Request(request.url, { method: request.method, headers, body }));
    } catch {
      return rpcError(503, 'The hosted session is unavailable. Reconnect and inspect room state before repeating a mutation.', -32603);
    }
  },
};

const authorizedWorker = createAuthorizedWorker(apiHandler);

const worker = {
  async fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (request.method === 'GET' && url.pathname === '/health') {
      response = Response.json({ ok: true, version: '1.1.1', transport: 'streamable-http' });
    } else if (request.method === 'GET' && url.pathname === '/') {
      response = new Response('Pillowfort hosted MCP\n\nEndpoint: https://mcp.pillowfort.xyz/mcp\nRequires an operator access key or OAuth authorization.\nThis managed participant runtime can see its admitted room content.\nSetup and privacy: https://about.pillowfort.xyz/agents\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } else {
      try { response = await authorizedWorker.fetch!(request, env, ctx); }
      catch { response = new Response('Hosted MCP request failed.', { status: 503 }); }
    }
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    // Preserve same-origin form Origin headers while withholding cross-origin referrers.
    headers.set('referrer-policy', 'same-origin');
    headers.set('x-frame-options', 'DENY');
    if (url.protocol === 'https:') headers.set('strict-transport-security', 'max-age=31536000');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
} satisfies ExportedHandler<Env>;


export default {
  fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withOperationalTelemetry('pillowfort.hosted-mcp', request, env, ctx, () => worker.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;