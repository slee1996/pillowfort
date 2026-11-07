import { DurableObject } from 'cloudflare:workers';
import { ProtocolError, ProtocolErrorCode, type McpHttpHandler } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
import { AgentError, MAX_OUTPUT_BYTES } from '../../scripts/agent-common.mjs';
import { PillowfortHostedAgent } from '../../src/participant/hostedAgent';
import { initializeMls } from '../../src/participant/mlsCrypto';
import openMlsModule from '../../client/src/vendor/openmls/pillowfort_openmls_bg.wasm';
import { createWorkerWebSocket } from './webSocket';
import { createAgentMcpHandler } from '../../scripts/agent-mcp.mjs';
import { AGENT_RESOURCES } from '../../scripts/agent-guidance.mjs';
import catalog from '../../docs/agents/tools.json';
import overview from '../../docs/agents/index.md';
import workflows from '../../docs/agents/workflows.md';
import security from '../../docs/agents/security.md';
import type { Env } from './env';
import { hasBoundedMcpStructure, MAX_MCP_REQUEST_BYTES } from './requestLimits';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resources = AGENT_RESOURCES;
const texts: Record<string, string> = { index: overview, workflows, security };
const instructions = 'Hosted Pillowfort MCP uses self-service, expiring access: no manually issued key. The full non-payment tool catalog is invariant. Call session_create with {} to obtain a server-minted participant handle, then participant_preflight before room creation. Handles belong to this exact access grant; closed or expired identities cannot be restored. Capture the receiver latestMessageId before chat_send and call chat_verify_received on that receiver; a sender echo or queued action is not delivery. Read pillowfort://agents/index, workflows, and security. Follow existing operator authorization for named recipients, private invitations, explicit host approval and cleanup. Use the selected pendingAdmissions entry admissionId and deviceFingerprint exactly with confirm:true. The host may approve only an expected request whose device fingerprint was independently verified.';

async function resourceLoader(uri: string) {
  const definition = resources.find(resource => resource.uri === uri);
  if (!definition) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown resource. Call resources/list.');
  return { uri, mimeType: definition.mimeType, text: texts[uri.slice(uri.lastIndexOf('/') + 1)] };
}

interface PrincipalRecord {
  principalId: string;
  expiresAt: number;
  idleAt: number;
  status: 'active' | 'closed';
  leaseId?: string;
  leaseExpiresAt?: number;
}

const IDENTITY_UNAVAILABLE = { code: 'PARTICIPANT_IDENTITY_UNAVAILABLE', retryable: false, nextAction: 'authorize-new-access', identityRestorable: false };

function seconds(value: string, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 10 ? Math.min(parsed, maximum) * 1000 : fallback * 1000;
}

function failure(status: number, message: string, id: unknown = null, data?: Record<string, string | boolean>): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code: status === 404 ? -32001 : -32600, message, ...(data ? { data } : {}) } }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function boundedBody(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  let bytes = 0;
  let chunks = 0;
  let timer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentError('TIMEOUT', 'Request body timed out.')), 10_000);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) return text + decoder.decode();
      if (++chunks > 8192) throw new AgentError('SIZE_LIMIT', 'MCP message exceeds its chunk limit.');
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new AgentError('SIZE_LIMIT', 'MCP message exceeds its byte limit.');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** One authenticated grant owns memory-only participants, not a protocol connection. */
export class HostedMcpSession extends DurableObject<Env> {
  private record?: PrincipalRecord;
  private restored = false;
  private agent?: PillowfortHostedAgent;
  private handler?: McpHttpHandler;
  private initializing?: Promise<void>;
  private starting?: Promise<void>;
  private releasing?: Promise<void>;
  private closing?: Promise<void>;
  private activeRequests = 0;
  private participantChanges = 0;
  private lifetime = new AbortController();
  private residencyTimer: number | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.record = await ctx.storage.get<PrincipalRecord>('principal');
      if (!this.record) {
        const legacy = await ctx.storage.get<PrincipalRecord>('session');
        if (legacy) {
          const retired: PrincipalRecord = {
            principalId: legacy.principalId, expiresAt: legacy.expiresAt, idleAt: legacy.idleAt,
            status: 'closed', leaseId: legacy.leaseId, leaseExpiresAt: legacy.leaseExpiresAt,
          };
          // Move lifecycle metadata atomically so a crash cannot orphan its lease.
          // The old protocol identity is retired, never resumed or translated.
          await ctx.storage.transaction(async transaction => {
            await transaction.put('principal', retired);
            await transaction.delete('session');
          });
          this.record = retired;
        }
      }
      this.restored = !!this.record;
      // Stored lifecycle metadata never permits recreation of lost MLS identities.
      if (this.record) {
        // Arm recovery before cross-actor work. The durable tombstone retains its
        // lease until retirement succeeds, so crashes retry without losing refunds.
        await ctx.storage.setAlarm(Date.now() + 1);
        if (!ctx.id.equals(env.MCP_SESSIONS.idFromName(this.record.principalId))) {
          // Historical actors used principalId:sessionId, not the modern principal
          // route. Revoke only their persisted grant, including already-migrated
          // tombstones, before this actor can refund or serve another request.
          // The authorization store disables new requests first, then closes the
          // modern principal actor to fence calls that already passed authorization.
          await env.MCP_ACCESS_KEYS.get(env.MCP_ACCESS_KEYS.idFromName('global')).revoke(this.record.principalId);
        }
      }
    });
  }

  private async persist() {
    if (this.record) await this.ctx.storage.put('principal', this.record);
  }

  private async schedule() {
    clearTimeout(this.residencyTimer);
    this.residencyTimer = undefined;
    if (!this.record) return;
    if (this.record.status === 'closed') {
      if (this.record.leaseId) await this.ctx.storage.setAlarm(Date.now() + 10_000);
      else await this.ctx.storage.deleteAlarm();
      return;
    }
    const deadline = Math.min(this.record.expiresAt, this.record.idleAt);
    // Keep volatile identities resident; alarms still fail closed after eviction.
    this.residencyTimer = setTimeout(() => {
      this.residencyTimer = undefined;
      this.ctx.waitUntil(this.alarm());
    }, Math.max(0, deadline - Date.now()));
    await this.ctx.storage.setAlarm(Math.min(deadline, Date.now() + 30_000));
  }

  private live() {
    return !this.restored && this.record?.status === 'active' && Date.now() < Math.min(this.record.expiresAt, this.record.idleAt);
  }

  private startParticipants(): Promise<void> {
    if (!this.live()) return Promise.reject(new AgentError('CLOSED', 'The hosted participant lifetime ended.'));
    if (!this.starting) this.starting = (async () => {
      await this.releasing;
      if (this.record?.leaseId) return;
      await this.reserveParticipants();
    })().catch(error => { this.starting = undefined; throw error; });
    return this.starting;
  }

  private async reserveParticipants(): Promise<void> {
    if (!this.live() || !this.record) throw new AgentError('CLOSED', 'This hosted participant lifetime ended. Authorize new access.');
    const record = this.record;
    const keys = this.env.MCP_ACCESS_KEYS.get(this.env.MCP_ACCESS_KEYS.idFromName('global'));
    if (!await keys.allow('participantStart', record.principalId)) throw new AgentError('RATE_LIMIT', 'Hosted participant allocation rate exceeded. No room action ran.', true, 3600);
    if (!this.live()) throw new AgentError('CLOSED', 'The participant lifetime ended before allocation.');
    const leaseId = crypto.randomUUID();
    const quota = this.env.MCP_QUOTAS.get(this.env.MCP_QUOTAS.idFromName('global'));
    const lease = await quota.acquire(leaseId, record.principalId, Math.max(1000, record.expiresAt - Date.now()));
    if (!lease.ok) throw new AgentError(lease.code, lease.retryAfter > 0
      ? `Hosted infrastructure capacity is unavailable, not a room admission or encryption failure. No room action ran. Wait ${lease.retryAfter} seconds, refresh GET /preflight, then retry session_create without recreating existing participants.`
      : 'The hosted allocation request was invalid; no participant or room action started.', lease.retryAfter > 0, lease.retryAfter > 0 ? lease.retryAfter : undefined);
    record.leaseId = leaseId;
    record.leaseExpiresAt = lease.expiresAt;
    try {
      await this.persist();
      if (!this.live()) throw new AgentError('CLOSED', 'The participant lifetime ended before crypto startup.');
      await initializeMls(openMlsModule);
      if (!this.live()) throw new AgentError('CLOSED', 'The participant lifetime ended during crypto startup.');
    } catch (error) {
      this.ctx.waitUntil(Promise.resolve().then(() => this.shutdown()));
      throw error;
    }
  }

  private releaseLease(): Promise<void> {
    if (this.releasing) return this.releasing;
    const record = this.record;
    if (!record?.leaseId) return Promise.resolve();
    const leaseId = record.leaseId;
    this.releasing = (async () => {
      await this.env.MCP_QUOTAS.get(this.env.MCP_QUOTAS.idFromName('global')).release(leaseId);
      delete record.leaseId;
      delete record.leaseExpiresAt;
      await this.persist();
    })().finally(() => { this.releasing = undefined; });
    return this.releasing;
  }

  private async initialize(principalId: string) {
    const grantExpiresAt = await this.env.MCP_ACCESS_KEYS.get(this.env.MCP_ACCESS_KEYS.idFromName('global')).expiresAt(principalId);
    if (this.record || !grantExpiresAt) throw new AgentError('CLOSED', 'The access grant is no longer active.');
    const now = Date.now();
    this.record = { principalId, expiresAt: Math.min(grantExpiresAt, now + seconds(this.env.MAX_SESSION_SECONDS, 600, 600)), idleAt: now + seconds(this.env.IDLE_TIMEOUT_SECONDS, 120, 600), status: 'active' };
    await this.persist();
    if (!this.live()) throw new AgentError('CLOSED', 'The participant lifetime ended before startup.');
    this.agent = new PillowfortHostedAgent({ baseURL: this.env.APP_URL, maxSessions: 2, timeoutMs: 30_000, createWebSocket: createWorkerWebSocket, beforeStart: () => this.startParticipants() });
    this.handler = createAgentMcpHandler({
      agent: this.agent, roomTools: catalog.tools, includeCMS: false, maxActiveCalls: 8,
      resourceLoader, resources, instructions, jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      observeToolCall: async (name: string, invoke: () => Promise<unknown>) => {
        const changing = name === 'session_create' || name === 'session_close';
        if (changing) this.participantChanges++;
        try { return await invoke(); }
        finally {
          if (changing) this.participantChanges--;
          if (changing && this.participantChanges === 0 && this.agent?.listSessions().length === 0 && this.record?.leaseId) {
            this.starting = undefined;
            await this.releaseLease();
          }
        }
      },
      onToolError: (error: { code: string }) => {
        if (['STALE_SESSION', 'TIMEOUT', 'BRIDGE_ERROR', 'CONNECTION_FAILED', 'INVALID_CAPABILITIES'].includes(error.code)) this.ctx.waitUntil(this.shutdown());
      },
    });
    await this.schedule();
  }

  async fetch(request: Request): Promise<Response> {
    const principalId = request.headers.get('x-pillowfort-principal') ?? '';
    if (!UUID.test(principalId)) return failure(403, 'Trusted principal binding is required.');
    if (this.record && this.record.principalId !== principalId) return failure(404, 'Participant owner not found.');
    if (this.restored || (this.record && !this.live())) {
      await this.shutdown();
      return failure(404, 'Participant lifetime lost or expired. Authorize new access; identities cannot be recovered.', null, IDENTITY_UNAVAILABLE);
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
    if (this.activeRequests >= 12) return failure(429, 'Too many concurrent MCP requests.');
    this.activeRequests++;
    let parsedBody: unknown;
    try {
      try { parsedBody = JSON.parse(await boundedBody(request.body, MAX_MCP_REQUEST_BYTES)); }
      catch (error) { return failure(error instanceof AgentError && error.code === 'SIZE_LIMIT' ? 413 : 400, 'Invalid, oversized, or incomplete MCP JSON request.'); }
      if (!hasBoundedMcpStructure(parsedBody)) return failure(413, 'MCP request exceeds its structural limits.');
      if (!this.record && !this.initializing) this.initializing = this.initialize(principalId);
      await this.initializing;
      if (!this.live() || !this.record || !this.handler) return failure(404, 'Participant lifetime closed. Authorize new access.', null, IDENTITY_UNAVAILABLE);
      this.record.idleAt = Math.min(this.record.expiresAt, Date.now() + seconds(this.env.IDLE_TIMEOUT_SECONDS, 120, 600));
      await this.persist();
      await this.schedule();
      let timer: number | undefined;
      let onClosed: (() => void) | undefined;
      const stopped = new Promise<Response>(resolve => {
        onClosed = () => resolve(failure(404, 'Participant lifetime ended while this call was pending. A mutation may already have committed.', null, { ...IDENTITY_UNAVAILABLE, mutationOutcome: 'unknown' }));
        this.lifetime.signal.addEventListener('abort', onClosed, { once: true });
        timer = setTimeout(() => {
          this.ctx.waitUntil(this.shutdown());
          resolve(failure(504, 'MCP call timed out and participants are closing. Inspect room state before retrying mutations.'));
        }, 45_000);
      });
      let response: Response;
      try { response = await Promise.race([this.handler.fetch(request, { parsedBody }), stopped]); }
      finally {
        clearTimeout(timer);
        if (onClosed) this.lifetime.signal.removeEventListener('abort', onClosed);
      }
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'no-store');
      if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
        // Subscription lifetime and per-filter delivery belong to the modern SDK.
        return new Response(response.body, { status: response.status, headers });
      }
      try {
        // Bound the complete wire representation, including duplicate structured/text output.
        const body = await boundedBody(response.body, MAX_OUTPUT_BYTES);
        return new Response(body || null, { status: response.status, headers });
      } catch {
        const id = parsedBody && typeof parsedBody === 'object' && 'id' in parsedBody ? parsedBody.id : null;
        return failure(413, 'MCP output exceeds the byte limit. Request a smaller result; a mutation may already have committed.', id);
      }
    } catch {
      await this.shutdown();
      return failure(500, 'Participant runtime failed and was closed. Authorize new access and inspect room state before retrying mutations.');
    } finally { this.activeRequests--; }
  }

  private shutdown(): Promise<void> {
    if (!this.closing) this.closing = this.closeParticipants().finally(() => { this.closing = undefined; });
    return this.closing;
  }

  private async closeParticipants() {
    clearTimeout(this.residencyTimer);
    this.residencyTimer = undefined;
    const record = this.record;
    if (!record) return;
    record.status = 'closed';
    this.lifetime.abort();
    await this.persist();
    await this.starting?.catch(() => {});
    await Promise.allSettled([this.agent?.close(), this.handler?.close()]);
    this.agent = undefined;
    this.handler = undefined;
    try { await this.releaseLease(); }
    finally { await this.schedule(); }
    // Retain a non-secret tombstone: the exact grant must never resurrect identities.
  }

  async revoke(principalId: string): Promise<void> {
    if (!UUID.test(principalId) || (this.record && this.record.principalId !== principalId)) return;
    this.record ??= { principalId, expiresAt: 0, idleAt: 0, status: 'closed' };
    await this.shutdown();
  }

  async alarm() {
    if (!this.live()) { await this.shutdown(); return; }
    if (!await this.env.MCP_ACCESS_KEYS.get(this.env.MCP_ACCESS_KEYS.idFromName('global')).active(this.record!.principalId)) {
      await this.shutdown();
      return;
    }
    await this.schedule();
  }
}
