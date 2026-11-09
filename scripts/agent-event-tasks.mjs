import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

export const TASK_EXTENSION = 'io.modelcontextprotocol/tasks';
const TTL = 600_000;
const WAIT = 300_000;
const PREFIX = 'attention-task:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const taskParams = { '~standard': { version: 1, vendor: 'pillowfort', validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !uuid.test(value.taskId ?? '') || Object.keys(value).some(key => key !== 'taskId' && key !== '_meta')) return { issues: [{ message: 'An exact taskId is required.' }] };
  return { value: { taskId: value.taskId } };
} } };

const toolResult = data => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }], structuredContent: { ok: true, data }, isError: false });

/** Store only task coordination/readiness metadata, never room text or MLS state. */
export function createEventTasks({ store, agent, participants }) {
  const running = new Map();
  let closed = false;
  let creating = 0;
  const save = task => store.put(PREFIX + task.taskId, task);
  const load = async taskId => {
    const task = await store.get(PREFIX + taskId);
    if (!task || Date.now() >= Date.parse(task.createdAt) + task.ttlMs) {
      if (task) await store.delete(PREFIX + taskId);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found or expired.');
    }
    return task;
  };
  const settle = async (task, status, fields = {}) => {
    if (task.status !== 'working') return;
    Object.assign(task, { status, lastUpdatedAt: new Date().toISOString() }, fields);
    await save(task);
  };
  const publicTask = task => {
    const { session, input, ...result } = task;
    return result;
  };
  return {
    async create(session, input) {
      if (closed) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Participant service closed.');
      if (running.size + creating >= 8) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Event task capacity reached.');
      creating++;
      try {
      participants.require(session);
      const records = await store.list({ prefix: PREFIX });
      let retained = 0;
      for (const [key, task] of records) {
        if (Date.now() >= Date.parse(task.createdAt) + task.ttlMs) await store.delete(key);
        else retained++;
      }
      if (retained + creating > 16) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Event task capacity reached; finish or expire existing tasks.');
      const probe = await agent.execute(session, 'room_next_event', { ...input, timeoutMs: 0 });
      if (!probe.ok || probe.data.events.length || probe.data.missed || probe.data.closed || input.timeoutMs === 0) return probe;
      const readCursor = probe.data.cursor;
      const now = new Date().toISOString();
      const task = { taskId: crypto.randomUUID(), status: 'working', createdAt: now, lastUpdatedAt: now, ttlMs: TTL, pollIntervalMs: 1000, session, input: { cursor: readCursor, types: input.types, limit: input.limit } };
      const waitId = `task:${task.taskId}`;
      const job = { task, waitId };
      // Persist and reserve before starting any wait or returning the handle.
      await save(task);
      if (closed) { await settle(task, 'failed', { error: { code: -32001, message: 'Participant service closed.' } }); throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Participant service closed.'); }
      running.set(task.taskId, job);
      job.done = (async () => {
        const deadline = Date.now() + WAIT;
        try {
          while (task.status === 'working' && !closed) {
            participants.require(session);
            const result = await agent.execute(session, 'room_next_event', { ...task.input, waitId, timeoutMs: Math.min(30_000, Math.max(0, deadline - Date.now())) });
            if (task.status !== 'working') return;
            if (!result.ok) throw new Error(result.error.code);
            const batch = result.data;
            if (batch.events.length || batch.missed || batch.closed) {
              // Private content is fetched separately by the same owner using readCursor.
              await settle(task, 'completed', { result: toolResult({ ready: true, readCursor, cursor: batch.cursor, eventIds: batch.events.map(event => event.id), types: batch.events.map(event => event.type), missed: batch.missed, closed: batch.closed, requiresRead: true }) });
              return;
            }
            if (Date.now() >= deadline) {
              await settle(task, 'completed', { result: toolResult({ ready: false, readCursor, cursor: batch.cursor, timeout: true, requiresRead: false }) });
              return;
            }
          }
        } catch {
          await settle(task, 'failed', { error: { code: -32001, message: 'Participant unavailable or event wait failed. Observe the participant; never substitute an identity.' } });
        } finally { running.delete(task.taskId); }
      })();
      // Observe background storage failures; get() will expose a retained working record as failed.
      void job.done.catch(() => {});
      return { resultType: 'task', ...publicTask(task) };
      } finally { creating--; }
    },
    async get(taskId) {
      const task = running.get(taskId)?.task ?? await load(taskId);
      if (task.status === 'working' && !running.has(taskId)) await settle(task, 'failed', { error: { code: -32001, message: 'Participant runtime was lost; cryptographic identity is not restorable.' } });
      return { resultType: 'complete', ...publicTask(task) };
    },
    async cancel(taskId) {
      const task = running.get(taskId)?.task ?? await load(taskId);
      await settle(task, 'cancelled');
      const job = running.get(taskId);
      if (job) await agent.execute(task.session, 'room_cancel_event_wait', { waitId: job.waitId }).catch(() => {});
      return { resultType: 'complete' };
    },
    async close() {
      closed = true;
      await Promise.allSettled([...running.values()].map(async job => {
        await settle(job.task, 'failed', { error: { code: -32001, message: 'Participant service closed; identity is not restorable.' } });
        await agent.execute(job.task.session, 'room_cancel_event_wait', { waitId: job.waitId }).catch(() => {});
        await job.done;
      }));
    },
  };
}
