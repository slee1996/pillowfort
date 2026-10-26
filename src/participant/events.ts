export type ParticipantEventListener = (detail: unknown) => void;

/** Participant-local events; browser adapters may forward them to DOM listeners. */
export class ParticipantEvents {
  private readonly listeners = new Map<string, Set<ParticipantEventListener>>();

  on(name: string, listener: ParticipantEventListener): () => void {
    let listeners = this.listeners.get(name);
    if (!listeners) this.listeners.set(name, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.listeners.get(name) === listeners) this.listeners.delete(name);
    };
  }

  emit(name: string, detail?: unknown): void {
    const listeners = this.listeners.get(name);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(detail);
  }

  clear(): void {
    this.listeners.clear();
  }
}
