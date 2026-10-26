import { AgentError, boundedJSON, MAX_OUTPUT_BYTES, MAX_WAIT_MS, validateBaseURL } from '../../scripts/agent-common.mjs';
import { createParticipantRuntime, type ParticipantRuntime, type ParticipantRuntimeOptions } from './runtime';
import type { AgentCapability, AgentResult, AgentSnapshot } from './agent';

interface Session {
  name: string;
  state: 'opening' | 'ready';
  runtime?: ParticipantRuntime;
  abort: AbortController;
  pendingCalls: number;
  pendingActions: number;
  nextActionAt: number;
  actionQueue: Promise<unknown>;
  opening?: Promise<void>;
}

interface HostedAgentOptions extends ParticipantRuntimeOptions {
  maxSessions?: number;
  timeoutMs?: number;
  beforeStart?: () => Promise<void>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new AgentError('SESSION_CLOSED', 'The session closed before this action was submitted.')); return; }
    const abort = () => { clearTimeout(timer); reject(new AgentError('SESSION_CLOSED', 'The session closed before this action was submitted.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Named, isolated native participants implementing the existing MCP tool-registry contract. */
export class PillowfortHostedAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Set<Promise<void>>();
  private readonly disposing = new Set<Promise<void>>();
  private discovery?: Promise<ParticipantRuntime>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly baseURL: string;
  private readonly maxSessions: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: HostedAgentOptions) {
    this.baseURL = validateBaseURL(options.baseURL).origin;
    this.maxSessions = options.maxSessions ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 16) throw new AgentError('INVALID_INPUT', 'maxSessions must be an integer from 1 to 16.');
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 60_000) throw new AgentError('INVALID_INPUT', 'timeoutMs must be an integer from 1000 to 60000.');
  }

  private async open(): Promise<ParticipantRuntime> {
    if (this.closed) throw new AgentError('CLOSED', 'The SDK is closed.');
    await this.options.beforeStart?.();
    if (this.closed) throw new AgentError('CLOSED', 'The SDK is closed.');
    const runtime = await createParticipantRuntime({ baseURL: this.baseURL, createWebSocket: this.options.createWebSocket });
    if (this.closed) {
      await runtime.close();
      throw new AgentError('CLOSED', 'The SDK closed during participant startup.');
    }
    return runtime;
  }

  async createSession(name: string) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new AgentError('INVALID_SESSION', 'Session names must be 1–64 ASCII letters, digits, underscores or hyphens, starting with a letter or digit.');
    if (this.closed) throw new AgentError('CLOSED', 'The SDK is closed.');
    if (this.sessions.has(name)) throw new AgentError('SESSION_EXISTS', 'That session already exists. Reuse it or close it first.');
    if (this.sessions.size >= this.maxSessions || this.pending.size >= this.maxSessions) throw new AgentError('SESSION_LIMIT', `At most ${this.maxSessions} named sessions may be open or opening. Close one or wait for creation to finish.`);
    const session: Session = { name, state: 'opening', abort: new AbortController(), pendingCalls: 0, pendingActions: 0, nextActionAt: 0, actionQueue: Promise.resolve() };
    this.sessions.set(name, session);
    const opening = this.open().then(async runtime => {
      if (session.abort.signal.aborted || this.sessions.get(name) !== session) {
        await runtime.close();
        throw new AgentError('SESSION_CLOSED', 'The session was closed while opening.');
      }
      session.runtime = runtime;
      session.state = 'ready';
    });
    session.opening = opening;
    this.pending.add(opening);
    void opening.finally(() => this.pending.delete(opening)).catch(() => {});
    try {
      await this.call(session, () => opening);
      return { name, state: 'ready' };
    } catch (error) {
      if (this.sessions.get(name) === session) this.sessions.delete(name);
      session.abort.abort();
      void this.disposeSession(session).catch(() => {});
      throw error;
    }
  }

  listSessions() { return [...this.sessions.values()].map(({ name, state }) => ({ name, state })); }

  private session(name: string): Session {
    if (this.closed) throw new AgentError('CLOSED', 'The SDK is closed.');
    const session = this.sessions.get(name);
    if (!session) throw new AgentError('SESSION_NOT_FOUND', 'No such session. Use session_list or create a named session first.');
    if (session.state !== 'ready') throw new AgentError('SESSION_NOT_READY', 'The session is still opening. Wait for session_create to finish.', true);
    return session;
  }

  private disposeSession(session: Session): Promise<void> {
    if (!session.runtime) return Promise.resolve();
    const disposed = session.runtime.close();
    this.disposing.add(disposed);
    void disposed.finally(() => this.disposing.delete(disposed)).catch(() => {});
    return disposed;
  }

  private async call<T>(session: Session, operation: () => T | Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    if (session.abort.signal.aborted) throw new AgentError('SESSION_CLOSED', 'The session closed while this call was pending.');
    if (session.pendingCalls >= 32) throw new AgentError('BUSY', 'Too many outstanding calls for this session. Wait for pending calls to finish.', true);
    session.pendingCalls++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(new AgentError('SESSION_CLOSED', 'The session closed while this call was pending. A mutation may already have committed.'));
        session.abort.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          // Reject with TIMEOUT before aborting other pending operations.
          reject(new AgentError('TIMEOUT', 'The participant operation timed out and this session closed to prevent late actions. Inspect room state before retrying mutations.'));
          session.abort.abort();
          if (this.sessions.get(session.name) === session) this.sessions.delete(session.name);
          void this.disposeSession(session).catch(() => {});
        }, timeoutMs);
      });
      const result = await Promise.race([Promise.resolve().then(() => {
        if (session.abort.signal.aborted) throw new AgentError('SESSION_CLOSED', 'The session closed before this operation.');
        return operation();
      }), stopped]);
      // Startup has no payload; externally returned observations are bounded copies.
      return result === undefined ? result : JSON.parse(boundedJSON(result, MAX_OUTPUT_BYTES));
    } finally {
      clearTimeout(timer);
      if (onAbort) session.abort.signal.removeEventListener('abort', onAbort);
      session.pendingCalls--;
    }
  }

  async capabilities(name?: string): Promise<AgentCapability[]> {
    if (name !== undefined) {
      const session = this.session(name);
      return this.call(session, () => session.runtime!.agent.capabilities());
    }
    if (this.closed) throw new AgentError('CLOSED', 'The SDK is closed.');
    this.discovery ??= this.open();
    const runtime = await this.discovery;
    return JSON.parse(boundedJSON(runtime.agent.capabilities(), MAX_OUTPUT_BYTES));
  }

  async cmsCapabilities(): Promise<never[]> { return []; }

  async execute(sessionName: string, name: string, input: Record<string, unknown> = {}): Promise<AgentResult> {
    if (typeof name !== 'string' || !name || !input || typeof input !== 'object' || Array.isArray(input)) throw new AgentError('INVALID_INPUT', 'Provide an action name and a JSON object input.');
    const session = this.session(sessionName);
    const copied = JSON.parse(boundedJSON(input)) as Record<string, unknown>;
    const paced = typeof copied.roomId === 'string' && session.runtime!.agent.capabilities().some(capability => capability.name === name && capability.roomTraffic);
    const deadline = Date.now() + this.timeoutMs;
    const run = async () => {
      if (session.abort.signal.aborted) throw new AgentError('SESSION_CLOSED', 'The session closed before this action was submitted.');
      if (paced) {
        const snapshot = session.runtime!.agent.observe();
        const room = snapshot.room as { members?: unknown[] } | null;
        const members = Math.max(1, room?.members?.length ?? 1);
        const interval = Math.max(500, Math.ceil(5000 * members * (members + 4) / 128));
        const waitMs = Math.max(0, session.nextActionAt - Date.now());
        if (Date.now() + waitMs + 1000 > deadline) throw new AgentError('BUSY', 'The room action budget is busy. Observe state and wait before submitting another action.', true);
        if (waitMs) await delay(waitMs, session.abort.signal);
        if (session.abort.signal.aborted) throw new AgentError('SESSION_CLOSED', 'The session closed before this action was submitted.');
        session.nextActionAt = Date.now() + interval;
      }
      if (Date.now() >= deadline) throw new AgentError('BUSY', 'This action expired in the local queue and was not submitted.', true);
      return this.call(session, () => session.runtime!.agent.execute(name, copied), deadline - Date.now());
    };
    if (!paced) return run();
    if (session.pendingActions >= 8) throw new AgentError('BUSY', 'At most eight room actions may be queued per session. Wait for pending actions.', true);
    session.pendingActions++;
    const result = session.actionQueue.then(run).finally(() => { session.pendingActions--; });
    session.actionQueue = result.catch(() => {});
    return result;
  }

  observe(name: string): Promise<AgentSnapshot> {
    const session = this.session(name);
    return this.call(session, () => session.runtime!.agent.observe());
  }

  wait(name: string, afterRevision: number, timeoutMs = MAX_WAIT_MS): Promise<AgentSnapshot> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) throw new AgentError('INVALID_INPUT', 'afterRevision must be a nonnegative safe integer; timeoutMs must be an integer from 0 to 30000.');
    const session = this.session(name);
    return this.call(session, () => session.runtime!.agent.waitForChange(afterRevision, timeoutMs), timeoutMs + 5000);
  }

  async closeSession(name: string) {
    const session = this.sessions.get(name);
    if (!session) throw new AgentError('SESSION_NOT_FOUND', 'No such session. Use session_list to find open sessions.');
    this.sessions.delete(name);
    session.abort.abort();
    await session.opening?.catch(() => {});
    await session.runtime?.close();
    return { name, closed: true };
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      for (const session of sessions) session.abort.abort();
      this.closing = (async () => {
        await Promise.allSettled([...sessions.map(session => this.disposeSession(session)), ...this.pending, ...this.disposing, this.discovery?.then(runtime => runtime.close())]);
        this.discovery = undefined;
      })();
    }
    return this.closing;
  }
}
