import { readByteLimitedText } from '../../src/requestBody';
import { createAuthorizedWorker, AccessKeyStore } from './auth';
import { HostedMcpSession } from './session';
import { discover } from './discovery';
import { ParticipantQuota } from './quota';
import type { AuthenticatedProps, Env } from './env';
import { withOperationalTelemetry } from '../../src/telemetry';
import { hasBoundedMcpStructure, MAX_MCP_REQUEST_BYTES } from './requestLimits';
import catalog from '../../docs/agents/tools.json';

export { AccessKeyStore, HostedMcpSession, ParticipantQuota };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function rpcError(status: number, message: string, code = -32600): Response {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status });
}

const apiHandler: ExportedHandler<Env, unknown, unknown, AuthenticatedProps> = {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const principalId = ctx.props.principalId;
    if (typeof principalId !== 'string' || !UUID.test(principalId)) return rpcError(401, 'Valid access authorization is required.');
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return rpcError(415, 'Expected application/json.');
    // Respond before cancelling an oversized upload: workerd may otherwise reset it.
    const declaredLength = request.headers.get('content-length');
    if (declaredLength && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)
      && BigInt(declaredLength) > BigInt(MAX_MCP_REQUEST_BYTES)) return rpcError(413, 'MCP request exceeds its byte limit.');
    const result = await readByteLimitedText(request, MAX_MCP_REQUEST_BYTES);
    if (!result.ok) return rpcError(result.reason === 'body_too_large' ? 413 : 400, 'Invalid or oversized MCP request body.');
    const body = result.text;
    let message: unknown;
    try { message = JSON.parse(body); } catch { return rpcError(400, 'Invalid JSON.', -32700); }
    if (!hasBoundedMcpStructure(message)) return rpcError(413, 'MCP request exceeds its structural limits.');
    const publicResult = await discover(new Request(request, { body }));
    if (publicResult) return publicResult;

    // Only protocol headers reach the principal actor. No credentials or caller
    // assertions about ownership, transport sessions, or toolsets survive.
    const headers = new Headers();
    for (const name of ['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'origin']) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set('x-pillowfort-principal', principalId);
    const id = env.MCP_SESSIONS.idFromName(principalId);
    try {
      return await env.MCP_SESSIONS.get(id).fetch(new Request(request.url, { method: 'POST', headers, body, signal: request.signal }));
    } catch {
      return rpcError(503, 'The hosted participant is unavailable. Inspect room state before repeating a mutation.', -32603);
    }
  },
};

const authorizedWorker = createAuthorizedWorker(apiHandler);

const worker = {
  async fetch(request: Request<unknown, IncomingRequestCfProperties>, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    if (request.method === 'GET' && url.pathname === '/health') {
      response = Response.json({ ok: true, version: catalog.release.version, catalog: catalog.release, transport: 'streamable-http' });
    } else if (request.method === 'GET' && url.pathname === '/') {
      response = new Response('Pillowfort hosted MCP\n\nEndpoint: https://mcp.pillowfort.xyz/mcp\nMCP 2026-07-28 uses ordinary POST requests and POST subscriptions/listen streams; no initialize handshake or protocol session header.\nNo manually issued key or account is required.\nPreflight: GET https://mcp.pillowfort.xyz/preflight\nSelf-service access: POST https://mcp.pillowfort.xyz/access with JSON {"acceptManagedCustody":true}; use the returned access_token as a Bearer credential. Access expires after one hour and can be revoked with DELETE /mcp/access.\nOAuth clients authorize through the consent page without key entry.\nThe complete non-payment tool catalog is invariant and public. Tool execution requires authorization. session_create takes {} and returns an owner-bound opaque participant handle.\nThis managed participant runtime can see its admitted room content. Invitations and verified host approval are still required.\nSetup, isolation and privacy: https://about.pillowfort.xyz/agents/index.md\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    } else {
      try { response = await authorizedWorker.fetch!(request, env, ctx); }
      catch { response = new Response('Hosted MCP request failed.', { status: 503 }); }
    }
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('link', '<https://about.pillowfort.xyz/llms.txt>; rel="describedby"');
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