import { AgentError } from "./schema";
import type { JSONValue } from "./schema";

export type AttentionEventType = "mention" | "admission" | "game-turn" | "lifecycle";
export interface AttentionEvent { id: number; type: AttentionEventType; data: JSONValue }
export interface AttentionBatch {
  cursor: string;
  events: AttentionEvent[];
  missed: boolean;
  closed: boolean;
  liveOnly: true;
}

/** One live participant/room incarnation. Never persisted or shared across owners. */
export class ParticipantEventQueue {
  private readonly scope = crypto.randomUUID();
  private sequence = 0;
  private bytes = 0;
  private readonly entries: { event: AttentionEvent; bytes: number }[] = [];
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(private readonly capacity = 128, private readonly byteLimit = 64 * 1024) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1024 || !Number.isSafeInteger(byteLimit) || byteLimit < 1024 || byteLimit > 1024 * 1024) {
      throw new AgentError("invalid-input", "Invalid event queue bounds.");
    }
  }

  cursor(): string { return `${this.scope}:${this.sequence}`; }

  push(type: AttentionEventType, data: JSONValue): void {
    if (this.closed) return;
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new AgentError("event-limit", "Event sequence exhausted.");
    const encoded = JSON.stringify({ id: this.sequence + 1, type, data });
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (bytes > this.byteLimit || bytes > 12 * 1024) throw new AgentError("event-too-large", "Event exceeds the bounded attention budget.");
    const event = JSON.parse(encoded) as AttentionEvent;
    this.sequence++;
    this.entries.push({ event, bytes });
    this.bytes += bytes;
    while (this.entries.length > this.capacity || this.bytes > this.byteLimit) {
      const oldest = this.entries.shift();
      if (oldest) this.bytes -= oldest.bytes;
    }
    for (const wake of [...this.listeners]) wake();
  }

  read(cursor: string | undefined, types: AttentionEventType[], limit = 16): AttentionBatch {
    if (!Array.isArray(types) || types.length < 1 || types.length > 4 || types.some(type => !["mention", "admission", "game-turn", "lifecycle"].includes(type)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
      throw new AgentError("invalid-input", "Select 1–4 event types and a batch limit of 1–16.");
    }
    let after = 0;
    if (cursor !== undefined) {
      const prefix = `${this.scope}:`;
      if (!cursor.startsWith(prefix) || !/^(0|[1-9][0-9]*)$/u.test(cursor.slice(prefix.length))) throw new AgentError("stale-cursor", "Cursor belongs to another participant or room incarnation. Observe and start a fresh event baseline.");
      after = Number(cursor.slice(prefix.length));
      if (!Number.isSafeInteger(after) || after > this.sequence) throw new AgentError("stale-cursor", "Cursor is ahead of this event stream.");
    }
    const missed = after < (this.entries[0]?.event.id ?? this.sequence + 1) - 1;
    const events: AttentionEvent[] = [];
    let consumed = Math.max(after, (this.entries[0]?.event.id ?? 1) - 1);
    let bytes = 0;
    for (const entry of this.entries) {
      if (entry.event.id <= after) continue;
      if (types.includes(entry.event.type)) {
        if (events.length === limit || bytes + entry.bytes > 16 * 1024) break;
        events.push(entry.event);
        bytes += entry.bytes;
      }
      consumed = entry.event.id;
    }
    return { cursor: `${this.scope}:${consumed}`, events: JSON.parse(JSON.stringify(events)), missed, closed: this.closed, liveOnly: true };
  }

  wait(cursor: string | undefined, types: AttentionEventType[], limit: number, timeoutMs: number, signal?: AbortSignal): Promise<AttentionBatch> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) return Promise.reject(new AgentError("invalid-input", "Event waits must be between 0 and 30000 milliseconds."));
    if (signal?.aborted) return Promise.reject(new AgentError("cancelled", "Event wait cancelled."));
    const initial = this.read(cursor, types, limit);
    if (initial.events.length || initial.missed || initial.closed || timeoutMs === 0) return Promise.resolve(initial);
    if (this.listeners.size >= 64) return Promise.reject(new AgentError("busy", "Too many event waits."));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (cancelled = false, timedOut = false) => {
        if (settled) return;
        const batch = this.read(cursor, types, limit);
        if (!cancelled && !timedOut && !batch.events.length && !batch.missed && !batch.closed) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(wake);
        signal?.removeEventListener("abort", abort);
        if (cancelled) reject(new AgentError("cancelled", "Event wait cancelled."));
        else resolve(batch);
      };
      const wake = () => finish();
      const abort = () => finish(true);
      const timer = setTimeout(() => finish(false, true), timeoutMs);
      this.listeners.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort(); else wake();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const wake of [...this.listeners]) wake();
  }
}
